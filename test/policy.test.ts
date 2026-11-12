import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRetryPrompt, decideNext } from "../src/core/policy.ts";

const base = {
  reason: "verify_failed",
  backendKind: "local",
  retriesUsed: 0,
  retryBeforeEscalate: 1,
  isLastTier: false,
} as const;

test("a verify failure on a local backend is retried while retries are left", () => {
  assert.equal(decideNext(base), "retry");
});

test("a verify failure escalates once the retries are used", () => {
  assert.equal(decideNext({ ...base, retriesUsed: 1 }), "escalate");
});

test("a verify failure on the last tier stops once the retries are used", () => {
  assert.equal(decideNext({ ...base, retriesUsed: 1, isLastTier: true }), "stop");
});

test("no retry when retryBeforeEscalate is 0", () => {
  assert.equal(decideNext({ ...base, retryBeforeEscalate: 0 }), "escalate");
});

test("a verify failure on a cloud backend is not retried", () => {
  assert.equal(decideNext({ ...base, backendKind: "cloud" }), "escalate");
  assert.equal(decideNext({ ...base, backendKind: "cloud", isLastTier: true }), "stop");
});

test("an unreachable PC, a timeout and a backend error are never retried", () => {
  for (const reason of ["pc_unreachable", "timeout", "backend_error"] as const) {
    assert.equal(decideNext({ ...base, reason }), "escalate", reason);
    assert.equal(decideNext({ ...base, reason, isLastTier: true }), "stop", reason);
  }
});

test("buildRetryPrompt carries the original prompt, the rejected answer and the reason", () => {
  const prompt = buildRetryPrompt("P", "OUT", "why");
  assert.ok(prompt.startsWith("P\n"));
  assert.ok(prompt.includes("Reason: why"));
  assert.ok(prompt.includes("Previous answer:\nOUT\n"));
  assert.ok(prompt.includes("Reply with a corrected answer only."));
});

test("buildRetryPrompt cuts a long previous answer to 2000 characters", () => {
  const prompt = buildRetryPrompt("P", "x".repeat(5000), "why");
  assert.equal(prompt.match(/x+/g)?.[0]?.length, 2000);
});
