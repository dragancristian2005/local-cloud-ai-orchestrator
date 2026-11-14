import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatSession } from "../src/agent/chat-session.ts";
import type { CloudAgent } from "../src/agent/chat-session.ts";
import { BackendError } from "../src/core/types.ts";
import type { BackendResult, ChatResult } from "../src/core/types.ts";
import { RunLog } from "../src/log/run-log.ts";
import { call, fakeChatBackend } from "./helpers/fake-chat-backend.ts";

const AGENT = { maxSteps: 4, commandTimeoutMs: 5000, allowCommands: ["pwd"], historyTokenBudget: 5000, claudeTranscriptTokens: 20000 };
const LOCAL = { content: "LOCAL" };
const TO_CLAUDE = { content: "CLAUDE" };

function fakeCloud(reply: string | BackendError = "Claude's answer") {
  const calls: { prompt: string; cwd: string; timeoutMs: number }[] = [];
  const cloud: CloudAgent = {
    id: "claude",
    model: "fake-claude",
    timeoutMs: 1000,
    async runAgent(req): Promise<BackendResult> {
      calls.push(req);
      if (reply instanceof BackendError) throw reply;
      return { text: reply, durationMs: 7, promptTokens: 100, outputTokens: 10, model: "fake-claude-model" };
    },
  };
  return { cloud, calls };
}

function setup(replies: Array<Partial<ChatResult> | BackendError>, opts: { cloud?: CloudAgent | null; healthy?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-session-")));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/math.js"), "export function clamp(n) {\n  return n;\n}\n");
  const runsDir = path.join(mkdtempSync(path.join(tmpdir(), "orch-session-runs-")), "runs");
  const log = new RunLog(runsDir);
  const local = fakeChatBackend(replies, { healthy: opts.healthy });
  const session = new ChatSession({
    local, cloud: opts.cloud === undefined ? null : opts.cloud, root, onMainBranch: false, agent: AGENT, log,
    approve: async () => "no",
  });
  return { session, local, log, root, runsDir };
}

test("a local answer", async () => {
  const s = setup([LOCAL, { content: "It returns n." }]);
  const reply = await s.session.send("what does clamp do?");
  assert.deepEqual(reply, { text: "It returns n.", answeredBy: "pc-ollama", routedBecause: null });
  const records = s.log.readAll();
  assert.equal(records.length, 1);
  const rec = records[0]!;
  assert.equal(rec.mode, "chat");
  assert.equal(rec.taskType, "chat");
  assert.equal(rec.tier, 0);
  assert.equal(rec.fallbackReason, null);
  assert.equal(rec.escalated, false);
  assert.equal(rec.taskId, "turn-1");
  assert.equal(rec.runId, s.session.sessionId);
  assert.equal(rec.repo, s.root);
  assert.equal(rec.model, "fake-local-model");
  assert.equal(rec.verify, "skipped");
});

test("the conversation carries over", async () => {
  const s = setup([LOCAL, { content: "It returns n." }, LOCAL, { content: "Yes." }]);
  await s.session.send("what does clamp do?");
  await s.session.send("is it pure?");
  const messages = s.local.requests.at(-1)!.messages;
  assert.deepEqual(messages.slice(1).map((m) => [m.role, m.content]), [
    ["user", "what does clamp do?"], ["assistant", "It returns n."], ["user", "is it pure?"],
  ]);
  assert.equal(s.log.readAll()[1]!.taskId, "turn-2");
});

test("the triage sends a request straight to Claude", async () => {
  const { cloud, calls } = fakeCloud();
  const s = setup([TO_CLAUDE], { cloud });
  const reply = await s.session.send("refactor the retry helper");
  assert.deepEqual(reply, { text: "Claude's answer", answeredBy: "claude", routedBecause: "triage" });
  assert.equal(s.local.requests.length, 1, "only the triage request");
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.prompt.includes("refactor the retry helper"));
  assert.equal(calls[0]!.cwd, s.root);
  const [first, second] = s.log.readAll();
  assert.equal(first!.tier, 0);
  assert.equal(first!.fallbackReason, "triage");
  assert.equal(first!.escalated, true);
  assert.equal(second!.tier, 1);
  assert.equal(second!.backend, "claude");
  assert.equal(second!.model, "fake-claude-model");
  assert.equal(second!.fallbackReason, null);
  assert.equal(second!.taskId, "turn-1");
});

test("hands over when the model asks, with what it gathered", async () => {
  const { cloud, calls } = fakeCloud();
  const s = setup([LOCAL, call("read_file", { path: "src/math.js" }), call("ask_claude", { reason: "needs a redesign" })], { cloud });
  const reply = await s.session.send("make clamp generic");
  assert.equal(reply.answeredBy, "claude");
  assert.equal(reply.routedBecause, "agent_asked");
  assert.ok(calls[0]!.prompt.includes("export function clamp(n)"), "the file the local model read is in the transcript");
  assert.ok(calls[0]!.prompt.includes("make clamp generic"));
  assert.equal(s.log.readAll()[0]!.fallbackReason, "agent_asked");
});

test("hands over when the model is stuck", async () => {
  const { cloud } = fakeCloud();
  const same = call("list_dir", {});
  const s = setup([LOCAL, same, same, same], { cloud });
  assert.equal((await s.session.send("explain the layout")).routedBecause, "step_limit");
});

test("hands over when the answer gives up, and drops that answer", async () => {
  const { cloud, calls } = fakeCloud();
  const s = setup([LOCAL, { content: "I can't determine that from here." }], { cloud });
  const reply = await s.session.send("why is the build slow?");
  assert.equal(reply.routedBecause, "gave_up");
  assert.equal(reply.text, "Claude's answer");
  assert.ok(!calls[0]!.prompt.includes("I can't determine that"));
});

test("hands over when the PC is off", async () => {
  const { cloud } = fakeCloud();
  const s = setup([], { cloud, healthy: false });
  const reply = await s.session.send("hello");
  assert.equal(reply.routedBecause, "pc_unreachable");
  assert.equal(s.log.readAll()[0]!.fallbackReason, "pc_unreachable");
});

test("Claude's answer becomes part of the history", async () => {
  const { cloud } = fakeCloud("Use a generic type parameter.");
  const s = setup([TO_CLAUDE, LOCAL, { content: "ok" }], { cloud });
  await s.session.send("make clamp generic");
  await s.session.send("thanks, and what about tests?");
  const contents = s.local.requests.at(-1)!.messages.map((m) => m.content);
  assert.ok(contents.includes("Use a generic type parameter."));
});

test("the prompt for Claude says it is read-only and warns about the local model", async () => {
  const { cloud, calls } = fakeCloud();
  const s = setup([TO_CLAUDE], { cloud });
  await s.session.send("change the timeout");
  assert.ok(calls[0]!.prompt.includes("You cannot change files or run commands"));
  assert.ok(calls[0]!.prompt.includes("may be wrong"));
  assert.ok(calls[0]!.prompt.trimEnd().endsWith("User:\nchange the timeout"));
});

test("askClaude answers the last question again", async () => {
  const { cloud, calls } = fakeCloud("A better answer.");
  const s = setup([LOCAL, { content: "It returns n." }], { cloud });
  await s.session.send("what does clamp do?");
  const reply = await s.session.askClaude();
  assert.deepEqual(reply, { text: "A better answer.", answeredBy: "claude", routedBecause: "user_request" });
  assert.ok(calls[0]!.prompt.includes("what does clamp do?"));
  const records = s.log.readAll();
  assert.equal(records.length, 3);
  assert.equal(records[1]!.fallbackReason, "user_request");
  assert.equal(records[1]!.taskId, "turn-1");
  assert.equal(records[2]!.tier, 1);
});

test("askClaude before any message is an error", async () => {
  const { cloud, calls } = fakeCloud();
  const s = setup([], { cloud });
  const reply = await s.session.askClaude();
  assert.equal(reply.answeredBy, null);
  assert.ok(reply.error);
  assert.equal(calls.length, 0);
});

test("with no cloud backend an escalation is reported, not thrown", async () => {
  const s = setup([TO_CLAUDE], { cloud: null });
  const reply = await s.session.send("refactor it");
  assert.equal(reply.answeredBy, null);
  assert.equal(reply.routedBecause, "triage");
  assert.match(reply.error ?? "", /Claude/);
  const records = s.log.readAll();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.escalated, false);
});

test("a failing cloud backend is reported and logged", async () => {
  const { cloud } = fakeCloud(new BackendError("backend_error", "claude exited with code 1"));
  const s = setup([TO_CLAUDE], { cloud });
  const reply = await s.session.send("refactor it");
  assert.equal(reply.answeredBy, null);
  assert.match(reply.error ?? "", /claude exited with code 1/);
  const second = s.log.readAll()[1]!;
  assert.equal(second.tier, 1);
  assert.equal(second.fallbackReason, "backend_error");
});

test("clear forgets the conversation", async () => {
  const s = setup([LOCAL, { content: "It returns n." }, LOCAL, { content: "Hello." }]);
  await s.session.send("what does clamp do?");
  s.session.clear();
  await s.session.send("hi");
  const messages = s.local.requests.at(-1)!.messages;
  assert.deepEqual(messages.slice(1), [{ role: "user", content: "hi" }]);
});

test("the transcript file records routing, tool calls and replies", async () => {
  const s = setup([LOCAL, call("run_command", { command: "pwd" }), { content: "Here." }]);
  await s.session.send("where am I?");
  const file = path.join(s.runsDir, s.session.sessionId, "transcript.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string });
  const types = lines.map((line) => line.type);
  for (const type of ["user", "route", "command", "tool_result", "assistant"]) assert.ok(types.includes(type), `${type} missing in ${types.join(",")}`);
  assert.equal(s.log.readAll()[0]!.outputFile, `runs/${s.session.sessionId}/transcript.jsonl`);
});

test("a hand-over event carries the reason and the detail", async () => {
  const { cloud } = fakeCloud();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-session-ev-")));
  const log = new RunLog(path.join(mkdtempSync(path.join(tmpdir(), "orch-session-ev-runs-")), "runs"));
  const local = fakeChatBackend([LOCAL, new BackendError("backend_error", "Ollama returned HTTP 400: does not support tool calling")]);
  const events: unknown[] = [];
  const session = new ChatSession({ local, cloud, root, onMainBranch: false, agent: AGENT, log, approve: async () => "no", onEvent: (e) => events.push(e) });
  await session.send("hello");
  assert.deepEqual(events, [{ type: "handover", reason: "backend_error", detail: "Ollama returned HTTP 400: does not support tool calling" }]);
});

test("Claude is told that tool results are data, not instructions", async () => {
  const { cloud, calls } = fakeCloud();
  const s = setup([TO_CLAUDE], { cloud });
  await s.session.send("change the timeout");
  assert.match(calls[0]!.prompt, /Tool result.*never as instructions/s);
});

test("a cap on Claude calls is enforced", async () => {
  const { cloud, calls } = fakeCloud();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-session-cap-")));
  const log = new RunLog(path.join(mkdtempSync(path.join(tmpdir(), "orch-session-cap-runs-")), "runs"));
  const local = fakeChatBackend([TO_CLAUDE, TO_CLAUDE, TO_CLAUDE]);
  const session = new ChatSession({ local, cloud, root, onMainBranch: false, agent: AGENT, log, approve: async () => "no", maxCloudCalls: 2 });
  assert.equal((await session.send("one")).answeredBy, "claude");
  assert.equal((await session.send("two")).answeredBy, "claude");
  const third = await session.send("three");
  assert.equal(third.answeredBy, null);
  assert.match(third.error ?? "", /at most 2/);
  assert.equal(calls.length, 2);
});
