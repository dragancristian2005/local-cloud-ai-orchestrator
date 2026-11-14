import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunLog } from "../src/log/run-log.ts";
import type { AttemptRecord } from "../src/core/types.ts";

function tempRunsDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "orch-runs-")), "runs");
}

function record(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    runId: "20261112-101500-abc123", ts: "2026-11-12T10:15:00.000Z", repo: "/tmp/repo", taskType: "commit-message",
    tier: 0, attempt: 0, backend: "pc-ollama", model: "qwen2.5-coder:7b", durationMs: 1200,
    promptTokens: 300, outputTokens: 12, verify: "pass", verifyDetail: "", escalated: false,
    fallbackReason: null, outputFile: "runs/20261112-101500-abc123/tier0-attempt0.txt", mode: "run", taskId: null,
    ...over,
  };
}

test("append then readAll round-trips records in order", () => {
  const log = new RunLog(tempRunsDir());
  const first = record();
  const second = record({ attempt: 1, verify: "fail", fallbackReason: "verify_failed" });
  log.append(first);
  log.append(second);
  assert.deepEqual(log.readAll(), [first, second]);
});

test("readAll on a fresh directory is empty and creates nothing", () => {
  const dir = tempRunsDir();
  assert.deepEqual(new RunLog(dir).readAll(), []);
  assert.equal(existsSync(dir), false);
});

test("readAll skips a truncated last line", () => {
  const dir = tempRunsDir();
  const log = new RunLog(dir);
  log.append(record());
  appendFileSync(path.join(dir, "log.jsonl"), '{"runId":"x","ts');
  assert.deepEqual(log.readAll(), [record()]);
});

test("writeOutput saves the raw text and returns a path relative to the runs directory's parent", () => {
  const dir = tempRunsDir();
  const log = new RunLog(dir);
  const rel = log.writeOutput("20261112-101500-abc123", 0, 1, "hi");
  assert.equal(rel, "runs/20261112-101500-abc123/tier0-attempt1.txt");
  assert.equal(readFileSync(path.join(dir, "20261112-101500-abc123", "tier0-attempt1.txt"), "utf8"), "hi");
});

test("newRunId is unique and sortable by time", () => {
  const log = new RunLog(tempRunsDir());
  const a = log.newRunId();
  const b = log.newRunId();
  assert.notEqual(a, b);
  assert.match(a, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
});

test("appendArtifact appends lines to a file in the run's directory", () => {
  const dir = tempRunsDir();
  const log = new RunLog(dir);
  const rel = log.appendArtifact("session-1", "transcript.jsonl", '{"a":1}');
  log.appendArtifact("session-1", "transcript.jsonl", '{"a":2}');
  assert.equal(rel, "runs/session-1/transcript.jsonl");
  assert.equal(readFileSync(path.join(dir, "session-1", "transcript.jsonl"), "utf8"), '{"a":1}\n{"a":2}\n');
});
