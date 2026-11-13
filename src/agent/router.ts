import { estimateTokens } from "../core/context.ts";
import { BackendError } from "../core/types.ts";
import type { ChatBackend } from "../core/types.ts";
import type { EscalationReason } from "./loop.ts";

/** Where a message goes before the local model has tried anything. */
export type Route =
  | { to: "local" }
  | { to: "claude"; reason: "pc_unreachable" | "too_long" | "triage"; detail: string };

/** Each reason a message can end up with Claude, in words for the user. */
export const REASON_TEXT: Record<EscalationReason, string> = {
  pc_unreachable: "the PC is unreachable",
  timeout: "the local model timed out",
  backend_error: "the local model returned an error",
  agent_asked: "the local model asked for help",
  step_limit: "the local model got stuck",
  gave_up: "the local model could not answer",
  triage: "the request needs more than the local model",
  too_long: "the message is too long for the local model",
  user_request: "you asked for Claude",
};

export const TRIAGE_PROMPT = (message: string): string => `You are a router. Read the request and reply with exactly one word.

LOCAL  - a question that can be answered by reading a few files, searching the code, or running one command.
CLAUDE - writing or changing code, debugging, design, anything that needs several steps, or anything unclear.

When unsure, reply CLAUDE.

Request:
${message}
`;

const DEFAULT_TRIAGE_TIMEOUT_MS = 15_000;
const GIVING_UP = /^(i can['’]?t|i cannot|i don['’]?t know|i do not know|i['’]?m not able|i am not able|i['’]?m unable|i am unable|sorry|unfortunately,? i)\b/i;

/** True for an answer that is no answer: empty, or opening with a refusal. */
export function looksLikeGivingUp(answer: string): boolean {
  const text = answer.trim();
  return text === "" || GIVING_UP.test(text);
}

/**
 * Decide who gets a message. Rules first (is the PC there, does the message fit), then one short
 * call asks the local model itself to label the request.
 *
 * Only a clear "CLAUDE" sends the message to Claude. Any other reply, and any triage failure
 * except an unreachable PC, means "local": a model that cannot follow the triage must not turn
 * every message into a Claude call, and the agent loop has its own ways of handing over.
 */
export async function route(opts: {
  local: ChatBackend;
  message: string;
  historyTokenBudget: number;
  triageTimeoutMs?: number;
}): Promise<Route> {
  const { local, message } = opts;
  let healthy: boolean;
  try {
    healthy = await local.healthCheck();
  } catch {
    healthy = false;
  }
  if (!healthy) return { to: "claude", reason: "pc_unreachable", detail: `${local.name} is not reachable` };

  if (estimateTokens(message) > opts.historyTokenBudget / 2) {
    return { to: "claude", reason: "too_long", detail: `the message is about ${estimateTokens(message)} tokens` };
  }

  try {
    const reply = await local.chat({
      messages: [{ role: "user", content: TRIAGE_PROMPT(message) }],
      tools: [],
      timeoutMs: opts.triageTimeoutMs ?? DEFAULT_TRIAGE_TIMEOUT_MS,
    });
    const firstWord = reply.content.trim().split(/\s+/)[0]?.replace(/[^a-z]/gi, "").toUpperCase();
    if (firstWord === "CLAUDE") return { to: "claude", reason: "triage", detail: "the triage labelled the request CLAUDE" };
  } catch (err) {
    if (err instanceof BackendError && err.reason === "pc_unreachable") {
      return { to: "claude", reason: "pc_unreachable", detail: err.message };
    }
  }
  return { to: "local" };
}
