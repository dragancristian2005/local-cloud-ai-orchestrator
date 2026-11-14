import { BackendError } from "../core/types.ts";
import type { ChatBackend } from "../core/types.ts";
import { fitHistory } from "./history.ts";
import type { ChatMessage, ToolCall } from "./messages.ts";
import { ASK_CLAUDE_TOOL, MAX_TOOL_RESULT_CHARS } from "./toolkit.ts";
import type { Tool, Toolkit, ToolOutput, Verdict } from "./toolkit.ts";

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
  /** The tools, the system prompt and the policy that gates every tool call. */
  toolkit: Toolkit;
  maxSteps: number;
  historyTokenBudget: number;
  /** Calls the user answered "always" to in this session. */
  sessionAllowed: Set<string>;
  /** Shown the tool's own description of the call. */
  approve: (description: string) => Promise<Approval>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

const SAME_CALL_LIMIT = 3;

// A small model can emit dozens of calls in one reply; only the first few are run.
const MAX_CALLS_PER_REPLY = 8;
// The part of the history budget one reply's tool results may fill, so that the group still fits
// and fitHistory does not drop all of it.
const RESULTS_SHARE_OF_HISTORY = 0.6;

function cap(result: string, limit: number): string {
  const note = "\n[result cut]";
  return result.length <= limit ? result : result.slice(0, Math.max(0, limit - note.length)) + note;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run one tool call, if the policy and the user allow it. Returns the tool result text.
 * Nothing runs before the policy has answered for this exact call.
 */
async function runTool(call: ToolCall, tools: Map<string, Tool>, opts: AgentTurnOptions): Promise<string> {
  // A Map, not an object: "constructor" and "toString" must not find anything.
  const tool = tools.get(call.name);
  if (tool === undefined) {
    return `error: unknown tool ${call.name} (available: ${[...tools.keys(), ASK_CLAUDE_TOOL.function.name].join(", ")})`;
  }

  let description: string;
  try {
    description = tool.describe(call.arguments);
  } catch (err) {
    return `error: ${message(err)}`;
  }

  let verdict: Verdict;
  try {
    verdict = await opts.toolkit.policy.check(call.name, call.arguments);
  } catch (err) {
    return `error: the permission check failed: ${message(err)}`;
  }
  if (verdict?.decision === "deny") {
    opts.onEvent?.({ type: "command", command: description, verdict: "refused", detail: verdict.reason });
    return `refused: ${verdict.reason}`;
  }
  let how: "allowed" | "approved" = "allowed";
  // Anything but a clear "allow" is asked.
  if (verdict?.decision !== "allow") {
    how = "approved";
    // "Always" is remembered per tool: the same text from another tool is asked again.
    const key = `${call.name}:${description}`;
    if (!opts.sessionAllowed.has(key)) {
      const answer = await opts.approve(description);
      if (answer === "no") {
        opts.onEvent?.({ type: "command", command: description, verdict: "declined" });
        return "the user declined to run this command";
      }
      if (answer === "always") opts.sessionAllowed.add(key);
    }
  }

  let output: ToolOutput;
  try {
    output = await tool.run(call.arguments, { signal: opts.signal });
  } catch (err) {
    return `error: ${message(err)}`;
  }
  if (typeof output === "string") {
    opts.onEvent?.({ type: "tool", name: call.name, summary: description });
    return output;
  }
  opts.onEvent?.({ type: "command", command: description, verdict: how, exitCode: output.exitCode });
  return output.text;
}

/**
 * One turn of the local model: ask it, run the tools it requests, give it the results, until it
 * answers or the turn has to be handed over. The model never touches anything itself; every
 * request passes through the toolkit's policy and the tools' own checks.
 */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<TurnResult> {
  const { backend, messages, toolkit } = opts;
  const tools = new Map(toolkit.tools.map((tool) => [tool.definition.function.name, tool]));
  const definitions = [...toolkit.tools.map((tool) => tool.definition), ASK_CLAUDE_TOOL];
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

  if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: toolkit.systemPrompt });

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
        tools: definitions,
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
    // History is budgeted in tokens, estimated as characters / 3.
    const share = Math.min(
      MAX_TOOL_RESULT_CHARS,
      Math.floor((opts.historyTokenBudget * 3 * RESULTS_SHARE_OF_HISTORY) / Math.min(reply.toolCalls.length, MAX_CALLS_PER_REPLY)),
    );
    for (const [index, call] of reply.toolCalls.entries()) {
      if (index >= MAX_CALLS_PER_REPLY) {
        messages.push({ role: "tool", toolName: call.name, content: "not run: too many tool calls in one reply" });
        continue;
      }
      const key = `${call.name} ${JSON.stringify(call.arguments)}`;
      const seen = (timesSeen.get(key) ?? 0) + 1;
      timesSeen.set(key, seen);

      let result: string;
      if (handOver !== undefined) {
        result = "not run: the request was handed over";
      } else if (call.name === ASK_CLAUDE_TOOL.function.name) {
        const why = typeof call.arguments.reason === "string" ? call.arguments.reason : "no reason given";
        handOver = escalate("agent_asked", why);
        result = "handed over";
      } else if (seen >= SAME_CALL_LIMIT) {
        handOver = escalate("step_limit", "repeated the same tool call");
        result = "not run: the same call was made three times";
      } else {
        result = await runTool(call, tools, opts);
      }
      messages.push({ role: "tool", toolName: call.name, content: cap(result, share) });
    }
    if (handOver !== undefined) return { ...handOver, durationMs: Date.now() - started };
  }
  return escalate("step_limit", `no answer after ${opts.maxSteps} tool rounds`);
}
