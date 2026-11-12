import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTable, summarize } from "../src/log/report.ts";
import type { AttemptRecord } from "../src/core/types.ts";
import { ollamaOnlyConfig, runCli, writeTempConfig } from "./helpers/run-cli.ts";

let counter = 0;

function rec(over: Partial<AttemptRecord> = {}): AttemptRecord {
  counter++;
  return {
    runId: `run-${counter}`, ts: "2026-11-12T10:15:00.000Z", repo: "/tmp/repo", taskType: "commit-message",
    tier: 0, attempt: 0, backend: "pc-ollama", model: "qwen2.5-coder:7b", durationMs: 1000,
    promptTokens: 300, outputTokens: 12, verify: "pass", verifyDetail: "", escalated: false,
    fallbackReason: null, outputFile: null, mode: "run", taskId: null,
    ...over,
  };
}

const failed = { verify: "fail", fallbackReason: "verify_failed" } as const;
const unreachable = { verify: "skipped", fallbackReason: "pc_unreachable", durationMs: 0 } as const;

test("pass rate ignores unreachable attempts", () => {
  const rows = summarize([rec(), rec(), rec(), rec(failed), rec(unreachable), rec(unreachable)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.attempts, 4);
  assert.equal(rows[0]!.passRate, 0.75);
  assert.equal(rows[0]!.unreachable, 2);
  assert.equal(rows[0]!.avgMs, 1000);
});

test("groups by model and sorts by pass rate", () => {
  const rows = summarize([rec(failed), rec({ model: "falcon:7b" }), rec()]);
  assert.deepEqual(rows.map((row) => [row.backend, row.model, row.passRate]), [
    ["pc-ollama", "falcon:7b", 1],
    ["pc-ollama", "qwen2.5-coder:7b", 0.5],
  ]);
});

test("escalation rate counts runs, not attempts", () => {
  const rows = summarize([
    rec({ runId: "A", ...failed }),
    rec({ runId: "A", attempt: 1, ...failed, escalated: true }),
    rec({ runId: "B" }),
  ]);
  assert.equal(rows[0]!.escalationRate, 0.5);
  assert.equal(rows[0]!.attempts, 3);
});

test("a run where the PC was only unreachable does not count towards the escalation rate", () => {
  const rows = summarize([rec({ runId: "A", ...unreachable, escalated: true }), rec({ runId: "B" })]);
  assert.equal(rows[0]!.escalationRate, 0);
});

test("eval-only groups have no escalation rate", () => {
  const rows = summarize([rec({ mode: "eval", taskId: "cm-01", repo: null })]);
  assert.equal(rows[0]!.escalationRate, null);
  assert.match(formatTable(rows), /qwen2\.5-coder:7b\s+1\s+100\s+-\s/);
});

test("filters by mode and by task type", () => {
  const records = [rec({ mode: "eval" }), rec(failed), rec({ taskType: "docstring", ...failed })];
  assert.equal(summarize(records, { mode: "eval" })[0]!.passRate, 1);
  assert.equal(summarize(records, { mode: "run" })[0]!.attempts, 2);
  assert.equal(summarize(records, { taskType: "docstring" })[0]!.attempts, 1);
  assert.deepEqual(summarize(records, { taskType: "test-stub" }), []);
});

test("a timeout lowers the pass rate", () => {
  const rows = summarize([rec(), rec({ verify: "skipped", fallbackReason: "timeout", durationMs: 3000 })]);
  assert.equal(rows[0]!.passRate, 0.5);
  assert.equal(rows[0]!.avgMs, 2000);
});

test("a group that was only ever unreachable shows no rates", () => {
  const rows = summarize([rec(unreachable)]);
  assert.equal(rows[0]!.attempts, 0);
  assert.equal(rows[0]!.unreachable, 1);
  assert.match(formatTable(rows), /\s0\s+-\s+-\s+-\s+1$/m);
});

test("formatTable prints a header and one row per model", () => {
  const table = formatTable(summarize([rec(), rec({ backend: "claude", model: "fable", tier: 1, durationMs: 4200 })]));
  const lines = table.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^backend\s+model\s+attempts\s+pass %\s+escalated %\s+avg s\s+pc down$/);
  assert.match(table, /^claude\s+fable\s+1\s+100\s+0\s+4\.2\s+0$/m);
});

test("orch report on an empty log says so and exits 0", async () => {
  const { configPath } = writeTempConfig(ollamaOnlyConfig("http://127.0.0.1:1"));
  const result = await runCli(["report", "--config", configPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "no runs logged yet\n");
});

test("orch report rejects an unknown --mode", async () => {
  const { configPath } = writeTempConfig(ollamaOnlyConfig("http://127.0.0.1:1"));
  assert.equal((await runCli(["report", "--mode", "weekly", "--config", configPath])).code, 2);
});
