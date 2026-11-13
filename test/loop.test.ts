import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn, SYSTEM_PROMPT } from "../src/agent/loop.ts";
import type { AgentEvent, Approval } from "../src/agent/loop.ts";
import type { ChatMessage } from "../src/agent/messages.ts";
import { MAX_TOOL_RESULT_CHARS } from "../src/agent/tools.ts";
import { BackendError } from "../src/core/types.ts";
import type { ChatBackend, ChatResult } from "../src/core/types.ts";
import { call, fakeChatBackend } from "./helpers/fake-chat-backend.ts";

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-loop-")));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/math.js"), "export function clamp(n) {\n  return n;\n}\n");
  for (let i = 0; i < 60; i++) writeFileSync(path.join(root, `note-${i}.txt`), `needle ${"z".repeat(180)}\n`);
  return root;
}

interface Setup {
  backend: ChatBackend & { requests: { messages: ChatMessage[]; tools: unknown[] }[] };
  messages: ChatMessage[];
  approvals: string[];
  events: AgentEvent[];
  root: string;
  run: () => ReturnType<typeof runAgentTurn>;
}

function setup(replies: Array<Partial<ChatResult> | BackendError>, over: { approve?: Approval; healthy?: boolean; maxSteps?: number; allowCommands?: string[] } = {}): Setup {
  const root = makeRoot();
  const backend = fakeChatBackend(replies, { healthy: over.healthy });
  const messages: ChatMessage[] = [{ role: "user", content: "what does clamp do?" }];
  const approvals: string[] = [];
  const events: AgentEvent[] = [];
  const sessionAllowed = new Set<string>();
  return {
    backend, messages, approvals, events, root,
    run: () =>
      runAgentTurn({
        backend, messages, root,
        maxSteps: over.maxSteps ?? 8, historyTokenBudget: 5000, commandTimeoutMs: 5000,
        allowCommands: over.allowCommands ?? ["git status", "ls", "pwd"], sessionAllowed, onMainBranch: false,
        approve: async (command) => {
          approvals.push(command);
          return over.approve ?? "no";
        },
        onEvent: (event) => events.push(event),
      }),
  };
}

function lastToolMessage(messages: ChatMessage[]): string {
  const tool = messages.filter((m) => m.role === "tool").at(-1);
  assert.ok(tool);
  return tool.content;
}

test("answers directly", async () => {
  const s = setup([{ content: " It clamps a number. " }]);
  const result = await s.run();
  assert.deepEqual(result.outcome, { kind: "answer", text: "It clamps a number." });
  assert.equal(result.steps, 1);
  const request = s.backend.requests[0]!;
  assert.deepEqual(request.messages[0], { role: "system", content: SYSTEM_PROMPT(s.root) });
  assert.deepEqual(request.messages[1], { role: "user", content: "what does clamp do?" });
  assert.equal(request.tools.length, 5);
  assert.equal(result.promptTokens, 20);
});

test("the system prompt names the repository and the way out", () => {
  const prompt = SYSTEM_PROMPT("/work/repo");
  assert.ok(prompt.includes("/work/repo"));
  assert.ok(prompt.includes("ask_claude"));
});

test("reads a file then answers", async () => {
  const s = setup([call("read_file", { path: "src/math.js" }), { content: "It returns n." }]);
  const result = await s.run();
  assert.equal(result.steps, 2);
  assert.deepEqual(result.outcome, { kind: "answer", text: "It returns n." });
  const second = s.backend.requests[1]!.messages;
  assert.equal(second.at(-2)!.role, "assistant");
  assert.deepEqual(second.at(-1), { role: "tool", toolName: "read_file", content: "1: export function clamp(n) {\n2:   return n;\n3: }" });
  assert.equal(result.promptTokens, 40);
});

test("runs several calls from one reply in order", async () => {
  const s = setup([{ toolCalls: [{ name: "list_dir", arguments: { path: "src" } }, { name: "search", arguments: { query: "clamp", path: "src" } }] }, { content: "done" }]);
  await s.run();
  const tools = s.messages.filter((m) => m.role === "tool");
  assert.deepEqual(tools.map((m) => m.role === "tool" && m.toolName), ["list_dir", "search"]);
  assert.equal(tools[0]!.content, "math.js");
});

test("feeds a tool error back and carries on", async () => {
  const s = setup([call("read_file", { path: "../outside.txt" }), { content: "I could not read it." }]);
  const result = await s.run();
  assert.match(lastToolMessage(s.messages), /^error: path is outside the repository/);
  assert.equal(result.outcome.kind, "answer");
});

test("an unknown tool and a missing argument are tool errors, not crashes", async () => {
  const s = setup([call("delete_everything", {}), call("read_file", {}), call("run_command", {}), { content: "ok" }]);
  const result = await s.run();
  const tools = s.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(tools[0]!, /^error: unknown tool delete_everything \(available: read_file, list_dir, search, run_command, ask_claude\)/);
  assert.match(tools[1]!, /^error: "path"/);
  assert.match(tools[2]!, /^error: "command"/);
  assert.equal(result.outcome.kind, "answer");
});

test("caps every tool result", async () => {
  const s = setup([call("search", { query: "needle" }), { content: "ok" }]);
  await s.run();
  assert.ok(lastToolMessage(s.messages).length <= MAX_TOOL_RESULT_CHARS, `got ${lastToolMessage(s.messages).length}`);
  assert.match(lastToolMessage(s.messages), /\[result cut\]$/);
});

test("runs an allow-listed command without asking", async () => {
  const s = setup([call("run_command", { command: "pwd" }), { content: "ok" }]);
  await s.run();
  assert.deepEqual(s.approvals, []);
  assert.equal(lastToolMessage(s.messages), `exit code 0\n${s.root}`);
});

test("asks before another command and runs it on yes", async () => {
  const s = setup([call("run_command", { command: `node -e "require('fs').writeFileSync('marker.txt','x'); console.log(40 + 2)"` }), { content: "ok" }], { approve: "yes" });
  await s.run();
  assert.equal(s.approvals.length, 1);
  assert.equal(existsSync(path.join(s.root, "marker.txt")), true);
  assert.equal(lastToolMessage(s.messages), "exit code 0\n42");
});

test("does not run a command the user declines", async () => {
  const s = setup([call("run_command", { command: `node -e "require('fs').writeFileSync('marker.txt','x')"` }), { content: "ok" }], { approve: "no" });
  await s.run();
  assert.equal(existsSync(path.join(s.root, "marker.txt")), false);
  assert.equal(lastToolMessage(s.messages), "the user declined to run this command");
});

test("always is remembered for the session", async () => {
  const command = "node -e \"console.log('x')\"";
  const s = setup([call("run_command", { command }), call("run_command", { command }), { content: "ok" }], { approve: "always" });
  await s.run();
  assert.equal(s.approvals.length, 1);
  assert.equal(s.messages.filter((m) => m.role === "tool").length, 2);
});

test("a refused command never reaches the user or the shell", async () => {
  const s = setup([call("run_command", { command: "rm -rf ." }), { content: "ok" }], { approve: "yes" });
  await s.run();
  assert.deepEqual(s.approvals, []);
  assert.match(lastToolMessage(s.messages), /^refused: rm with -r or -f is not allowed/);
  assert.equal(existsSync(path.join(s.root, "src/math.js")), true);
});

test("reports a failing command's exit code and output", async () => {
  const s = setup([call("run_command", { command: `node -e "console.error('boom'); process.exit(2)"` }), { content: "ok" }], { approve: "yes" });
  await s.run();
  assert.equal(lastToolMessage(s.messages), "exit code 2\nboom");
});

test("ask_claude escalates with the model's reason", async () => {
  const s = setup([call("ask_claude", { reason: "this needs a refactor across files" })]);
  const result = await s.run();
  assert.deepEqual(result.outcome, { kind: "escalate", reason: "agent_asked", detail: "this needs a refactor across files" });
  assert.equal(s.backend.requests.length, 1);
});

test("every tool call left in the history has a result, even after a hand-over", async () => {
  const s = setup([{ toolCalls: [{ name: "ask_claude", arguments: { reason: "too hard" } }, { name: "list_dir", arguments: {} }] }]);
  await s.run();
  const assistant = s.messages.find((m) => m.role === "assistant");
  assert.ok(assistant && assistant.role === "assistant");
  assert.equal(s.messages.filter((m) => m.role === "tool").length, assistant.toolCalls!.length);
});

test("the same call three times escalates", async () => {
  const same = call("read_file", { path: "src/math.js" });
  const s = setup([same, same, same, same, same]);
  const result = await s.run();
  assert.deepEqual(result.outcome, { kind: "escalate", reason: "step_limit", detail: "repeated the same tool call" });
  assert.equal(s.backend.requests.length, 3);
});

test("too many rounds escalate with step_limit", async () => {
  const replies = Array.from({ length: 12 }, (_, i) => call("search", { query: `term${i}` }));
  const s = setup(replies, { maxSteps: 8 });
  const result = await s.run();
  assert.equal(result.outcome.kind, "escalate");
  assert.equal(result.outcome.kind === "escalate" && result.outcome.reason, "step_limit");
  assert.equal(s.backend.requests.length, 8);
});

test("an unreachable PC escalates before any chat request", async () => {
  const s = setup([{ content: "never" }], { healthy: false });
  const result = await s.run();
  assert.equal(result.outcome.kind === "escalate" && result.outcome.reason, "pc_unreachable");
  assert.equal(s.backend.requests.length, 0);
});

test("a timeout and a backend error escalate with their reason", async () => {
  for (const reason of ["timeout", "backend_error", "pc_unreachable"] as const) {
    const s = setup([new BackendError(reason, `it failed: ${reason}`)]);
    const result = await s.run();
    assert.deepEqual(result.outcome, { kind: "escalate", reason, detail: `it failed: ${reason}` });
  }
});

test("events are reported for tools and commands", async () => {
  const s = setup(
    [call("read_file", { path: "src/math.js" }), call("run_command", { command: "pwd" }), call("run_command", { command: "rm -rf ." }), call("run_command", { command: "node -v" }), { content: "ok" }],
    { approve: "no" },
  );
  await s.run();
  assert.deepEqual(s.events, [
    { type: "tool", name: "read_file", summary: "read_file src/math.js" },
    { type: "command", command: "pwd", verdict: "allowed", exitCode: 0 },
    { type: "command", command: "rm -rf .", verdict: "refused", detail: "rm with -r or -f is not allowed" },
    { type: "command", command: "node -v", verdict: "declined" },
  ]);
});

test("the main-branch rule is checked for each command, not once", async () => {
  const root = makeRoot();
  const backend = fakeChatBackend([call("run_command", { command: "git commit -m one" }), call("run_command", { command: "git commit -m two" }), { content: "ok" }]);
  const messages: ChatMessage[] = [{ role: "user", content: "commit twice" }];
  let checks = 0;
  await runAgentTurn({
    backend, messages, root, maxSteps: 8, historyTokenBudget: 5000, commandTimeoutMs: 5000,
    allowCommands: [], sessionAllowed: new Set(),
    // Off main for the first command; on main by the time of the second (someone switched branch).
    onMainBranch: async () => ++checks > 1,
    approve: async () => "no",
  });
  const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.equal(results[0], "the user declined to run this command");
  assert.match(results[1]!, /^refused: commits are not made on the main branch/);
});
