import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTask } from "../src/core/orchestrator.ts";
import { BackendError } from "../src/core/types.ts";
import type { PreparedTask } from "../src/core/types.ts";
import { RunLog } from "../src/log/run-log.ts";
import { fakeBackend } from "./helpers/fake-backend.ts";

// A tiny task: the answer must not end with a period.
const task: PreparedTask = {
  taskType: "commit-message",
  prompt: "PROMPT",
  normalize: (raw) => raw.trim(),
  verify: (out) => (out.endsWith(".") ? { status: "fail", detail: "ends with a period" } : { status: "pass", detail: "" }),
};

function setup() {
  const runsDir = path.join(mkdtempSync(path.join(tmpdir(), "orch-run-")), "runs");
  return { runsDir, log: new RunLog(runsDir) };
}

const common = { task, retryBeforeEscalate: 1, repo: "/tmp/repo", mode: "run" as const };

test("passes on the first try", async () => {
  const { log, runsDir } = setup();
  const local = fakeBackend({ id: "pc", replies: ["  Add x\n"] });
  const outcome = await runTask({ ...common, chain: [local], log });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, "Add x");
  assert.equal(outcome.attempts.length, 1);
  const rec = outcome.attempts[0]!;
  assert.equal(rec.tier, 0);
  assert.equal(rec.attempt, 0);
  assert.equal(rec.verify, "pass");
  assert.equal(rec.escalated, false);
  assert.equal(rec.fallbackReason, null);
  assert.equal(rec.backend, "pc");
  assert.equal(rec.model, "pc-model");
  assert.equal(rec.repo, "/tmp/repo");
  assert.equal(rec.promptTokens, 10);
  assert.equal(rec.runId, outcome.runId);
  assert.deepEqual(log.readAll(), outcome.attempts);
  // The raw output is kept as the model sent it.
  assert.equal(readFileSync(path.join(runsDir, outcome.runId, "tier0-attempt0.txt"), "utf8"), "  Add x\n");
  assert.equal(rec.outputFile, `runs/${outcome.runId}/tier0-attempt0.txt`);
});

test("retries once with the failure in the prompt", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", replies: ["Added x.", "Add x"] });
  const outcome = await runTask({ ...common, chain: [local], log });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, "Add x");
  assert.equal(outcome.attempts.length, 2);
  const [first, second] = outcome.attempts;
  assert.equal(first!.attempt, 0);
  assert.equal(first!.verify, "fail");
  assert.equal(first!.fallbackReason, "verify_failed");
  assert.equal(first!.verifyDetail, "ends with a period");
  assert.equal(first!.escalated, false);
  assert.equal(second!.attempt, 1);
  assert.equal(second!.verify, "pass");
  assert.equal(local.prompts[0], "PROMPT");
  assert.ok(local.prompts[1]!.includes("Reason: ends with a period"));
  assert.ok(local.prompts[1]!.includes("Added x."));
});

test("escalates after the retry fails", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", replies: ["Bad one.", "Bad two."] });
  const cloud = fakeBackend({ id: "claude", kind: "cloud", replies: ["Add x"] });
  const outcome = await runTask({ ...common, chain: [local, cloud], log });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, "Add x");
  assert.equal(outcome.attempts.length, 3);
  assert.equal(outcome.attempts[0]!.escalated, false);
  assert.equal(outcome.attempts[1]!.escalated, true);
  assert.equal(outcome.attempts[2]!.tier, 1);
  assert.equal(outcome.attempts[2]!.backend, "claude");
  assert.equal(outcome.attempts[2]!.attempt, 0);
  // The stronger tier starts from the original prompt, not the retry prompt.
  assert.deepEqual(cloud.prompts, ["PROMPT"]);
});

test("skips an unreachable PC", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", healthy: false, replies: [] });
  const cloud = fakeBackend({ id: "claude", kind: "cloud", replies: ["Add x"] });
  const outcome = await runTask({ ...common, chain: [local, cloud], log });

  const first = outcome.attempts[0]!;
  assert.equal(first.fallbackReason, "pc_unreachable");
  assert.equal(first.verify, "skipped");
  assert.equal(first.outputFile, null);
  assert.equal(first.escalated, true);
  assert.equal(first.durationMs, 0);
  assert.deepEqual(local.prompts, []);
  assert.equal(outcome.ok, true);
});

test("an unavailable cloud backend is a backend error, not a PC outage", async () => {
  const { log } = setup();
  const cloud = fakeBackend({ id: "claude", kind: "cloud", healthy: false, replies: [] });
  const outcome = await runTask({ ...common, chain: [cloud], log });
  assert.equal(outcome.attempts[0]!.fallbackReason, "backend_error");
  assert.equal(outcome.ok, false);
});

test("a timeout escalates without a retry", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", replies: [new BackendError("timeout", "too slow")] });
  const cloud = fakeBackend({ id: "claude", kind: "cloud", replies: ["Add x"] });
  const outcome = await runTask({ ...common, chain: [local, cloud], log });

  const localRecords = outcome.attempts.filter((rec) => rec.backend === "pc");
  assert.equal(localRecords.length, 1);
  assert.equal(localRecords[0]!.fallbackReason, "timeout");
  assert.equal(localRecords[0]!.verify, "skipped");
  assert.equal(localRecords[0]!.escalated, true);
  assert.equal(localRecords[0]!.outputFile, null);
});

test("an unexpected error from a backend is recorded as a backend error", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", replies: [] }); // run() throws a plain Error
  const outcome = await runTask({ ...common, chain: [local], log });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts[0]!.fallbackReason, "backend_error");
});

test("all tiers fail", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", replies: ["Bad one.", "Bad two."] });
  const cloud = fakeBackend({ id: "claude", kind: "cloud", replies: ["Bad three."] });
  const outcome = await runTask({ ...common, chain: [local, cloud], log });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.text, null);
  assert.equal(outcome.attempts.length, 3);
  assert.equal(outcome.attempts.at(-1)!.escalated, false);
  assert.equal(outcome.attempts.at(-1)!.fallbackReason, "verify_failed");
});

test("never retries more often than retryBeforeEscalate, whatever the policy says", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", replies: ["Bad.", "Bad.", "Bad.", "Bad."] });
  const outcome = await runTask({ ...common, chain: [local], log, decide: () => "retry" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts.length, 2);
  assert.equal(local.prompts.length, 2);
});

test("a task with no verifier is logged as skipped and succeeds", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", replies: ["anything."] });
  const outcome = await runTask({ ...common, task: { ...task, verify: undefined }, chain: [local], log });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, "anything.");
  assert.equal(outcome.attempts[0]!.verify, "skipped");
  assert.equal(outcome.attempts[0]!.fallbackReason, null);
});

test("eval mode stamps the records", async () => {
  const { log } = setup();
  const local = fakeBackend({ id: "pc", replies: ["Add x"] });
  const outcome = await runTask({ ...common, chain: [local], log, mode: "eval", taskId: "cm-01", repo: null });
  assert.equal(outcome.attempts[0]!.mode, "eval");
  assert.equal(outcome.attempts[0]!.taskId, "cm-01");
  assert.equal(outcome.attempts[0]!.repo, null);
});

test("run mode leaves taskId null and reports progress", async () => {
  const { log, runsDir } = setup();
  const lines: string[] = [];
  const local = fakeBackend({ id: "pc", replies: ["Add x"] });
  const outcome = await runTask({ ...common, chain: [local], log, onProgress: (line) => lines.push(line) });
  assert.equal(outcome.attempts[0]!.taskId, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^tier 0 pc \(pc-model\): pass/);
  assert.ok(existsSync(path.join(runsDir, "log.jsonl")));
});
