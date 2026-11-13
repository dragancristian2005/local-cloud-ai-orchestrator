import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeGivingUp, route, TRIAGE_PROMPT } from "../src/agent/router.ts";
import { BackendError } from "../src/core/types.ts";
import { fakeChatBackend } from "./helpers/fake-chat-backend.ts";

const BUDGET = 5000;

async function decide(reply: string | BackendError, message = "what does clamp do?", healthy = true) {
  const local = fakeChatBackend([typeof reply === "string" ? { content: reply } : reply], { healthy });
  const decision = await route({ local, message, historyTokenBudget: BUDGET });
  return { decision, local };
}

test("LOCAL goes to the local model", async () => {
  assert.deepEqual((await decide("LOCAL")).decision, { to: "local" });
});

test("CLAUDE goes to Claude, however it is punctuated", async () => {
  for (const reply of ["CLAUDE", "claude.", "Claude - this needs code changes", "  **CLAUDE**", "\"CLAUDE\""]) {
    const { decision } = await decide(reply);
    assert.equal(decision.to, "claude", reply);
    assert.equal(decision.to === "claude" && decision.reason, "triage", reply);
  }
});

test("a triage reply that is neither word goes to the local model", async () => {
  for (const reply of ["MAYBE", "I think this is something Claude could do well, but ".repeat(20), "local or claude", "The answer is CLAUDE"]) {
    assert.deepEqual((await decide(reply)).decision, { to: "local" }, reply.slice(0, 30));
  }
});

test("a triage that fails goes to the local model, which will report the problem properly", async () => {
  assert.deepEqual((await decide(new BackendError("timeout", "slow"))).decision, { to: "local" });
  assert.deepEqual((await decide(new BackendError("backend_error", "empty reply"))).decision, { to: "local" });
});

test("an unreachable PC goes to Claude", async () => {
  const down = await decide("LOCAL", "hello", false);
  assert.equal(down.decision.to === "claude" && down.decision.reason, "pc_unreachable");
  assert.equal(down.local.requests.length, 0);
  const dropped = await decide(new BackendError("pc_unreachable", "gone"));
  assert.equal(dropped.decision.to === "claude" && dropped.decision.reason, "pc_unreachable");
});

test("a long message skips the triage", async () => {
  const { decision, local } = await decide("LOCAL", "x".repeat(10_000));
  assert.equal(decision.to === "claude" && decision.reason, "too_long");
  assert.equal(local.requests.length, 0);
});

test("the triage request is one user message with no tools", async () => {
  const { local } = await decide("LOCAL", "rename the helper");
  const request = local.requests[0]!;
  assert.deepEqual(request.tools, []);
  assert.deepEqual(request.messages, [{ role: "user", content: TRIAGE_PROMPT("rename the helper") }]);
  assert.ok(TRIAGE_PROMPT("rename the helper").includes("rename the helper"));
  assert.ok(TRIAGE_PROMPT("x").includes("When unsure, reply CLAUDE."));
});

test("looksLikeGivingUp recognises refusals and nothing else", () => {
  for (const answer of ["", "  ", "I can't determine that.", "I cannot access the file.", "sorry, I don't have access", "I don't know.", "I'm not able to run that", "I am unable to help", "Unfortunately, I could not find it", "I’m unable to do that"]) {
    assert.equal(looksLikeGivingUp(answer), true, answer);
  }
  for (const answer of ["The function clamps n.", "I can see that the test fails because of a typo.", "It cannot be null here.", "Sorting happens in sort.ts."]) {
    assert.equal(looksLikeGivingUp(answer), false, answer);
  }
});
