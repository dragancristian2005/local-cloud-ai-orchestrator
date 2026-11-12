import type { FallbackReason } from "./types.ts";

export type Decision = "retry" | "escalate" | "stop";

export interface PolicyState {
  /** Why the attempt failed. */
  reason: FallbackReason;
  backendKind: "local" | "cloud";
  /** Retries already spent at this tier. */
  retriesUsed: number;
  /** Retries allowed per tier (from config). */
  retryBeforeEscalate: number;
  /** True when no stronger backend is left in the chain. */
  isLastTier: boolean;
}

const MAX_PREVIOUS_OUTPUT_CHARS = 2000;

/**
 * The escalation policy: what to do after a failed attempt.
 * Only a rejected answer from a local model is worth a retry: the model gets the reason and one
 * more try. A retry on Claude would spend a subscription call, and a retry after an unreachable
 * PC, a timeout or a backend error would very likely fail the same way.
 */
export function decideNext(s: PolicyState): Decision {
  const worthRetrying = s.reason === "verify_failed" && s.backendKind === "local";
  if (worthRetrying && s.retriesUsed < s.retryBeforeEscalate) return "retry";
  return s.isLastTier ? "stop" : "escalate";
}

/** The prompt for a retry: the original task plus the rejected answer and why it was rejected. */
export function buildRetryPrompt(original: string, previousOutput: string, verifyDetail: string): string {
  return `${original}

---
Your previous answer was rejected by an automatic check.
Reason: ${verifyDetail}
Previous answer:
${previousOutput.slice(0, MAX_PREVIOUS_OUTPUT_CHARS)}

Reply with a corrected answer only.
`;
}
