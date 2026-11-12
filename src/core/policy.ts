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

// 👤 Yours to write (5-10 lines). This is the whole escalation policy.
// Inputs: why the attempt failed, whether the backend is local or cloud, retries already used at this tier,
// the configured retry count, and whether a stronger tier exists.
// Think about: a retry on "cloud" spends a subscription call; a retry after pc_unreachable or timeout
// will very likely fail the same way; on the last tier the only choices are "retry" and "stop".
export function decideNext(s: PolicyState): Decision {
  throw new Error(`TODO(you): decideNext (called with ${JSON.stringify(s)})`);
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
