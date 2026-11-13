import { runCommand } from "../core/command.ts";
import { BackendError } from "../core/types.ts";
import type { ChatBackend } from "../core/types.ts";
import { fitHistory } from "./history.ts";
import type { ChatMessage, ToolCall } from "./messages.ts";
import { classifyCommand } from "./permissions.ts";
import { listDirTool, MAX_TOOL_RESULT_CHARS, readFileTool, searchTool, TOOL_DEFINITIONS, ToolError } from "./tools.ts";

/** Why a message is answered by Claude instead of the local model. */
export type EscalationReason =
  | "pc_unreachable" | "timeout" | "backend_error" // the local backend failed
  | "agent_asked" | "step_limit" | "gave_up" // the local model could not finish
  | "triage" | "too_long" | "user_request"; // decided before the local model tried

export type Approval = "yes" | "no" | "always";

/** What the interface shows while the model works. */
export type AgentEvent =
  | { type: "tool"; name: string; summary: string }
  | {
      type: "command";
      command: string;
      verdict: "allowed" | "approved" | "declined" | "refused";
      exitCode?: number | null;
      detail?: string;
    };

export interface TurnResult {
  outcome: { kind: "answer"; text: string } | { kind: "escalate"; reason: EscalationReason; detail: string };
  /** Calls made to the model in this turn. */
  steps: number;
  durationMs: number;
  promptTokens: number;
  outputTokens: number;
}

export interface AgentTurnOptions {
  backend: ChatBackend;
  /** The conversation. Tool requests and results are appended to it; the final answer is not. */
  messages: ChatMessage[];
  root: string;
  maxSteps: number;
  historyTokenBudget: number;
  commandTimeoutMs: number;
  allowCommands: string[];
  /** Exact commands the user answered "always" to in this session. */
  sessionAllowed: Set<string>;
  /** Whether the repository is on main or master. A function is asked again before every command. */
  onMainBranch: boolean | (() => boolean | Promise<boolean>);
  approve: (command: string) => Promise<Approval>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export const SYSTEM_PROMPT = (root: string): string => `You are a coding assistant working in the repository at ${root}.
You can call tools to read files, list directories, search, and run commands. The user approves commands before they run.
Rules:
- Use a tool when you need facts about the code. Do not guess file contents.
- Paths are relative to the repository root.
- Keep answers short and concrete.
- If the task is beyond you, or you have tried twice without progress, call ask_claude with a one-line reason.
`;

const MAX_COMMAND_OUTPUT_CHARS = 4000;
const SAME_CALL_LIMIT = 3;
const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.function.name).join(", ");

function cap(result: string): string {
  const note = "\n[result cut]";
  return result.length <= MAX_TOOL_RESULT_CHARS ? result : result.slice(0, MAX_TOOL_RESULT_CHARS - note.length) + note;
}

function describe(call: ToolCall): string {
  const value = call.arguments.path ?? call.arguments.query ?? "";
  return typeof value === "string" && value !== "" ? `${call.name} ${value}` : call.name;
}

/** Run a command the model asked for, if the rules and the user allow it. Returns the tool result text. */
async function runCommandTool(call: ToolCall, opts: AgentTurnOptions): Promise<string> {
  const command = call.arguments.command;
  if (typeof command !== "string" || command.trim() === "") return `error: "command" must be a non-empty string`;

  // Looked up now, not at the start of the chat: the branch may have changed since.
  const onMainBranch = typeof opts.onMainBranch === "function" ? await opts.onMainBranch() : opts.onMainBranch;
  const verdict = classifyCommand(command, { allowCommands: opts.allowCommands, onMainBranch });
  if (verdict.decision === "deny") {
    opts.onEvent?.({ type: "command", command, verdict: "refused", detail: verdict.reason });
    return `refused: ${verdict.reason}`;
  }
  let how: "allowed" | "approved" = "allowed";
  if (verdict.decision === "ask") {
    how = "approved";
    if (!opts.sessionAllowed.has(command)) {
      const answer = await opts.approve(command);
      if (answer === "no") {
        opts.onEvent?.({ type: "command", command, verdict: "declined" });
        return "the user declined to run this command";
      }
      if (answer === "always") opts.sessionAllowed.add(command);
    }
  }

  const result = await runCommand(command, { cwd: opts.root, timeoutMs: opts.commandTimeoutMs, signal: opts.signal });
  opts.onEvent?.({ type: "command", command, verdict: how, exitCode: result.exitCode });
  const output = result.output.slice(-MAX_COMMAND_OUTPUT_CHARS).trimEnd();
  const status = result.timedOut
    ? `timed out after ${Math.round(opts.commandTimeoutMs / 1000)} s`
    : `exit code ${result.exitCode ?? "unknown"}`;
  return output === "" ? status : `${status}\n${output}`;
}

async function runTool(call: ToolCall, opts: AgentTurnOptions): Promise<string> {
  if (call.name === "run_command") return runCommandTool(call, opts);
  const fileTools: Record<string, (root: string, args: Record<string, unknown>) => string> = {
    read_file: readFileTool,
    list_dir: listDirTool,
    search: searchTool,
  };
  const tool = fileTools[call.name];
  if (tool === undefined) return `error: unknown tool ${call.name} (available: ${TOOL_NAMES})`;
  try {
    const result = tool(opts.root, call.arguments);
    opts.onEvent?.({ type: "tool", name: call.name, summary: describe(call) });
    return result;
  } catch (err) {
    if (err instanceof ToolError) return `error: ${err.message}`;
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * One turn of the local model: ask it, run the tools it requests, give it the results, until it
 * answers or the turn has to be handed over. The model never touches anything itself; every
 * request passes through the tools' own checks and, for commands, the permission rules.
 */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<TurnResult> {
  const { backend, messages } = opts;
  const started = Date.now();
  let steps = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  const done = (outcome: TurnResult["outcome"]): TurnResult => ({
    outcome,
    steps,
    durationMs: Date.now() - started,
    promptTokens,
    outputTokens,
  });
  const escalate = (reason: EscalationReason, detail: string) => done({ kind: "escalate", reason, detail });

  if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: SYSTEM_PROMPT(opts.root) });

  let healthy: boolean;
  try {
    healthy = await backend.healthCheck();
  } catch {
    healthy = false;
  }
  if (!healthy) return escalate("pc_unreachable", `${backend.name} is not reachable`);

  const timesSeen = new Map<string, number>();
  while (steps < opts.maxSteps) {
    steps++;
    let reply;
    try {
      reply = await backend.chat({
        messages: fitHistory(messages, opts.historyTokenBudget),
        tools: TOOL_DEFINITIONS,
        timeoutMs: backend.timeoutMs,
      });
    } catch (err) {
      const reason = err instanceof BackendError ? err.reason : "backend_error";
      return escalate(reason, err instanceof Error ? err.message : String(err));
    }
    promptTokens += reply.promptTokens ?? 0;
    outputTokens += reply.outputTokens ?? 0;

    if (reply.toolCalls.length === 0) return done({ kind: "answer", text: reply.content.trim() });

    messages.push({ role: "assistant", content: reply.content, toolCalls: reply.toolCalls, from: backend.id });
    // Every call gets a result, even when the turn ends early, so the history stays well-formed.
    let handOver: TurnResult | undefined;
    for (const call of reply.toolCalls) {
      const key = `${call.name} ${JSON.stringify(call.arguments)}`;
      const seen = (timesSeen.get(key) ?? 0) + 1;
      timesSeen.set(key, seen);

      let result: string;
      if (handOver !== undefined) {
        result = "not run: the request was handed over";
      } else if (call.name === "ask_claude") {
        const why = typeof call.arguments.reason === "string" ? call.arguments.reason : "no reason given";
        handOver = escalate("agent_asked", why);
        result = "handed over";
      } else if (seen >= SAME_CALL_LIMIT) {
        handOver = escalate("step_limit", "repeated the same tool call");
        result = "not run: the same call was made three times";
      } else {
        result = await runTool(call, opts);
      }
      messages.push({ role: "tool", toolName: call.name, content: cap(result) });
    }
    if (handOver !== undefined) return { ...handOver, durationMs: Date.now() - started };
  }
  return escalate("step_limit", `no answer after ${opts.maxSteps} tool rounds`);
}
