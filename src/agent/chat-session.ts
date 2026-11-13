import type { AgentConfig } from "../core/config.ts";
import { BackendError } from "../core/types.ts";
import type { AttemptRecord, BackendResult, ChatBackend, FallbackReason } from "../core/types.ts";
import type { RunLog } from "../log/run-log.ts";
import { renderTranscript } from "./history.ts";
import { runAgentTurn } from "./loop.ts";
import type { AgentEvent, Approval, EscalationReason } from "./loop.ts";
import type { ChatMessage } from "./messages.ts";
import { looksLikeGivingUp, REASON_TEXT, route } from "./router.ts";

/** What the chat needs from the Claude backend: a headless call inside the repository. */
export interface CloudAgent {
  id: string;
  model: string;
  timeoutMs: number;
  runAgent(req: { prompt: string; cwd: string; timeoutMs: number }): Promise<BackendResult>;
}

/** What the interface is told while a message is handled. */
export type ChatEvent = AgentEvent | { type: "handover"; reason: EscalationReason };

export interface ChatReply {
  text: string;
  /** The id of the backend that answered; null when nobody could. */
  answeredBy: string | null;
  /** Why the message went to Claude; null when the local model answered. */
  routedBecause: EscalationReason | null;
  error?: string;
}

const TRANSCRIPT_FILE = "transcript.jsonl";

const CLAUDE_PROMPT = (transcript: string): string => `You are answering in a terminal chat about the repository in the current directory. You can read files and search with your tools. You cannot change files or run commands: when a change is needed, show it as a diff the user can apply.
The conversation so far is below; some of it was handled by a small local model, whose statements may be wrong. Answer the user's last message. Be concise.

${transcript}
`;

/**
 * One conversation. It keeps the history, sends each message to the local model or to Claude,
 * hands a turn over when the local model cannot finish, and writes the log and the transcript.
 */
export class ChatSession {
  readonly sessionId: string;
  private readonly opts: {
    local: ChatBackend;
    cloud: CloudAgent | null;
    root: string;
    onMainBranch: boolean;
    agent: AgentConfig;
    log: RunLog;
    approve: (command: string) => Promise<Approval>;
    onEvent?: (event: ChatEvent) => void;
  };
  private messages: ChatMessage[] = [];
  private turn = 0;
  private transcriptPath: string | null = null;
  private readonly sessionAllowed = new Set<string>();

  constructor(opts: ChatSession["opts"]) {
    this.opts = opts;
    this.sessionId = opts.log.newRunId();
  }

  /** Forget the conversation. Commands approved with "always" stay approved. */
  clear(): void {
    this.messages = [];
  }

  async send(text: string): Promise<ChatReply> {
    const { local, agent } = this.opts;
    this.turn++;
    this.messages.push({ role: "user", content: text });
    this.note({ type: "user", content: text });

    const routingStarted = Date.now();
    const decision = await route({ local, message: text, historyTokenBudget: agent.historyTokenBudget });
    this.note({ type: "route", ...decision });
    if (decision.to === "claude") {
      this.recordLocal(decision.reason, decision.detail, Date.now() - routingStarted);
      return this.callClaude(decision.reason);
    }

    const before = this.messages.length;
    const result = await runAgentTurn({
      backend: local,
      messages: this.messages,
      root: this.opts.root,
      maxSteps: agent.maxSteps,
      historyTokenBudget: agent.historyTokenBudget,
      commandTimeoutMs: agent.commandTimeoutMs,
      allowCommands: agent.allowCommands,
      sessionAllowed: this.sessionAllowed,
      onMainBranch: this.opts.onMainBranch,
      approve: this.opts.approve,
      onEvent: (event) => {
        this.note(event);
        this.opts.onEvent?.(event);
      },
    });
    this.noteNewMessages(before);
    const tokens = { promptTokens: result.promptTokens, outputTokens: result.outputTokens };

    if (result.outcome.kind === "answer" && !looksLikeGivingUp(result.outcome.text)) {
      this.messages.push({ role: "assistant", content: result.outcome.text, from: local.id });
      this.note({ type: "assistant", from: local.id, content: result.outcome.text });
      this.recordLocal(null, "", result.durationMs, tokens);
      return { text: result.outcome.text, answeredBy: local.id, routedBecause: null };
    }

    // A refusal is not kept: it would only tell the next reader that nothing can be done.
    const reason = result.outcome.kind === "answer" ? "gave_up" : result.outcome.reason;
    const detail = result.outcome.kind === "answer" ? result.outcome.text : result.outcome.detail;
    this.recordLocal(reason, detail, result.durationMs, tokens);
    return this.callClaude(reason);
  }

  /** Answer the last user message again, with Claude. */
  async askClaude(): Promise<ChatReply> {
    if (!this.messages.some((message) => message.role === "user")) {
      return { text: "", answeredBy: null, routedBecause: "user_request", error: "there is no message to send to Claude yet" };
    }
    this.note({ type: "route", to: "claude", reason: "user_request" });
    this.recordLocal("user_request", "", 0);
    return this.callClaude("user_request");
  }

  private async callClaude(reason: EscalationReason): Promise<ChatReply> {
    const { cloud } = this.opts;
    if (cloud === null) {
      const error = `${REASON_TEXT[reason]}, and no Claude backend is configured for the chat`;
      this.note({ type: "error", error });
      return { text: "", answeredBy: null, routedBecause: reason, error };
    }

    this.opts.onEvent?.({ type: "handover", reason });
    const prompt = CLAUDE_PROMPT(renderTranscript(this.messages, this.opts.agent.claudeTranscriptTokens));
    const started = Date.now();
    try {
      const result = await cloud.runAgent({ prompt, cwd: this.opts.root, timeoutMs: cloud.timeoutMs });
      const text = result.text.trim();
      this.messages.push({ role: "assistant", content: text, from: cloud.id });
      this.note({ type: "assistant", from: cloud.id, content: text });
      this.record({
        tier: 1,
        backend: cloud.id,
        model: result.model ?? cloud.model,
        durationMs: result.durationMs,
        promptTokens: result.promptTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        fallbackReason: null,
        verifyDetail: "",
        escalated: false,
      });
      return { text, answeredBy: cloud.id, routedBecause: reason };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.note({ type: "error", error });
      this.record({
        tier: 1,
        backend: cloud.id,
        model: cloud.model,
        durationMs: Date.now() - started,
        promptTokens: null,
        outputTokens: null,
        fallbackReason: err instanceof BackendError ? err.reason : "backend_error",
        verifyDetail: error,
        escalated: false,
      });
      return { text: "", answeredBy: null, routedBecause: reason, error };
    }
  }

  private recordLocal(
    reason: EscalationReason | null,
    detail: string,
    durationMs: number,
    tokens: { promptTokens?: number; outputTokens?: number } = {},
  ): void {
    this.record({
      tier: 0,
      backend: this.opts.local.id,
      model: this.opts.local.model,
      durationMs,
      promptTokens: tokens.promptTokens ?? null,
      outputTokens: tokens.outputTokens ?? null,
      fallbackReason: reason,
      verifyDetail: detail,
      // Only true when there is someone to hand over to.
      escalated: reason !== null && this.opts.cloud !== null,
    });
  }

  private record(
    fields: Pick<
      AttemptRecord,
      "tier" | "backend" | "model" | "durationMs" | "promptTokens" | "outputTokens" | "verifyDetail" | "escalated"
    > & { fallbackReason: FallbackReason | null },
  ): void {
    this.opts.log.append({
      runId: this.sessionId,
      ts: new Date().toISOString(),
      repo: this.opts.root,
      taskType: "chat",
      attempt: 0,
      verify: "skipped",
      outputFile: this.transcriptPath,
      mode: "chat",
      taskId: `turn-${this.turn}`,
      ...fields,
    });
  }

  /** One line in the session's transcript file: everything that happened, in order. */
  private note(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), turn: this.turn, ...entry });
    this.transcriptPath = this.opts.log.appendArtifact(this.sessionId, TRANSCRIPT_FILE, line);
  }

  private noteNewMessages(from: number): void {
    for (const message of this.messages.slice(from)) {
      if (message.role === "tool") this.note({ type: "tool_result", tool: message.toolName, content: message.content });
      else if (message.role === "assistant") this.note({ type: "tool_call", from: message.from, calls: message.toolCalls ?? [] });
    }
  }
}
