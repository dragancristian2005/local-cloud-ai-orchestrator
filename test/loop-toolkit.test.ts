import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn } from "../src/agent/loop.ts";
import type { AgentEvent, Approval } from "../src/agent/loop.ts";
import type { ChatMessage } from "../src/agent/messages.ts";
import { ToolError } from "../src/agent/toolkit.ts";
import type { Tool, Toolkit, ToolOutput, Verdict } from "../src/agent/toolkit.ts";
import type { ChatResult } from "../src/core/types.ts";
import { call, fakeChatBackend } from "./helpers/fake-chat-backend.ts";

// A toolkit that has nothing to do with code: the loop must not care.
function house(check: (tool: string, args: Record<string, unknown>) => Verdict | Promise<Verdict>, replies: Partial<ChatResult>[], answers: Approval[] = []) {
  const ran: string[] = [];
  const tool = (name: string, output: ToolOutput = "done"): Tool => ({
    definition: { type: "function", function: { name, description: name, parameters: { type: "object", required: [], properties: {} } } },
    describe: (args) => String(args.room ?? name),
    run: async (args) => {
      ran.push(name);
      if (args.fail === true) throw new ToolError("no such room");
      return output;
    },
  });
  const toolkit: Toolkit = {
    systemPrompt: "You run a house.",
    tools: [tool("read_sensor"), tool("set_light"), tool("unlock_door", { text: "exit code 0", exitCode: 0 })],
    policy: { check },
  };
  const backend = fakeChatBackend(replies);
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const asked: string[] = [];
  const events: AgentEvent[] = [];
  const run = () =>
    runAgentTurn({
      backend, messages, toolkit, maxSteps: 8, historyTokenBudget: 5000, sessionAllowed: new Set<string>(),
      approve: async (description) => {
        asked.push(description);
        return answers.shift() ?? "no";
      },
      onEvent: (event) => events.push(event),
    });
  const results = () => messages.filter((m) => m.role === "tool").map((m) => m.content);
  return { run, ran, asked, events, results, backend };
}

const allow = (): Verdict => ({ decision: "allow" });
const ask = (): Verdict => ({ decision: "ask" });
const DONE = { content: "ok" };

test("the system prompt and the tool list come from the toolkit, plus ask_claude", async () => {
  const h = house(allow, [DONE]);
  await h.run();
  const request = h.backend.requests[0]!;
  assert.deepEqual(request.messages[0], { role: "system", content: "You run a house." });
  assert.deepEqual((request.tools as { function: { name: string } }[]).map((t) => t.function.name), ["read_sensor", "set_light", "unlock_door", "ask_claude"]);
});

test("an allowed call runs without asking and is reported as a tool event", async () => {
  const h = house(allow, [call("read_sensor", { room: "kitchen" }), DONE]);
  await h.run();
  assert.deepEqual([h.ran, h.asked, h.results()], [["read_sensor"], [], ["done"]]);
  assert.deepEqual(h.events, [{ type: "tool", name: "read_sensor", summary: "kitchen" }]);
});

test("an asked call shows the tool's description and runs only on yes", async () => {
  const yes = house(ask, [call("set_light", { room: "hall" }), DONE], ["yes"]);
  await yes.run();
  assert.deepEqual([yes.asked, yes.ran], [["hall"], ["set_light"]]);

  const no = house(ask, [call("set_light", { room: "hall" }), DONE], ["no"]);
  await no.run();
  assert.deepEqual([no.ran, no.results()], [[], ["the user declined to run this command"]]);
  assert.deepEqual(no.events, [{ type: "command", command: "hall", verdict: "declined" }]);
});

test("a result with an exit code is reported as a command event", async () => {
  const allowed = house(allow, [call("unlock_door", { room: "front" }), DONE]);
  await allowed.run();
  assert.deepEqual(allowed.events, [{ type: "command", command: "front", verdict: "allowed", exitCode: 0 }]);
  assert.deepEqual(allowed.results(), ["exit code 0"]);

  const approved = house(ask, [call("unlock_door", { room: "front" }), DONE], ["yes"]);
  await approved.run();
  assert.deepEqual(approved.events, [{ type: "command", command: "front", verdict: "approved", exitCode: 0 }]);
});

test("always is remembered per tool, not per description", async () => {
  const h = house(ask, [call("set_light", { room: "hall" }), call("set_light", { room: "hall", again: true }), call("unlock_door", { room: "hall" }), DONE], ["always", "no"]);
  await h.run();
  assert.deepEqual(h.asked, ["hall", "hall"], "set_light was asked once, unlock_door was asked for itself");
  assert.deepEqual(h.ran, ["set_light", "set_light"]);
});

test("a refusal beats an earlier always", async () => {
  let checks = 0;
  // Asked the first time; refused from the second check on (as when the branch became main).
  const check = (): Verdict => (++checks === 1 ? { decision: "ask" } : { decision: "deny", reason: "night mode" });
  const h = house(check, [call("set_light", { room: "hall" }), call("set_light", { room: "hall", again: true }), DONE], ["always"]);
  await h.run();
  assert.deepEqual(h.ran, ["set_light"], "only the first call ran");
  assert.deepEqual(h.results(), ["done", "refused: night mode"]);
  assert.deepEqual(h.events.at(-1), { type: "command", command: "hall", verdict: "refused", detail: "night mode" });
});

test("a permission check that fails blocks the call", async () => {
  const h = house(() => { throw new Error("git is not installed"); }, [call("unlock_door", { room: "front" }), DONE], ["yes"]);
  await h.run();
  assert.deepEqual([h.ran, h.asked], [[], []]);
  assert.deepEqual(h.results(), ["error: the permission check failed: git is not installed"]);
});

test("tool names that exist on every object are unknown tools", async () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    const h = house(allow, [call(name, {}), DONE]);
    await h.run();
    assert.match(h.results()[0]!, new RegExp(`^error: unknown tool ${name} \\(available: read_sensor, set_light, unlock_door, ask_claude\\)`));
    assert.deepEqual(h.events, []);
  }
});

test("a tool's own error is fed back to the model", async () => {
  const h = house(allow, [call("read_sensor", { room: "attic", fail: true }), DONE]);
  const turn = await h.run();
  assert.deepEqual(h.results(), ["error: no such room"]);
  assert.deepEqual(turn.outcome, { kind: "answer", text: "ok" });
});

test("ask_claude hands over with any toolkit", async () => {
  const h = house(allow, [call("ask_claude", { reason: "too hard" })]);
  assert.deepEqual((await h.run()).outcome, { kind: "escalate", reason: "agent_asked", detail: "too hard" });
});
