import { test } from "node:test";
import assert from "node:assert/strict";
import { fitHistory, messageTokens, renderTranscript } from "../src/agent/history.ts";
import type { ChatMessage } from "../src/agent/messages.ts";

const SYSTEM: ChatMessage = { role: "system", content: "You are a coding assistant." };

function turn(n: number, toolChars = 0): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: `question ${n}` }];
  if (toolChars > 0) {
    messages.push({ role: "assistant", content: "", toolCalls: [{ name: "read_file", arguments: { path: `f${n}.js` } }], from: "pc" });
    messages.push({ role: "tool", toolName: "read_file", content: "x".repeat(toolChars) });
  }
  messages.push({ role: "assistant", content: `answer ${n}`, from: "pc" });
  return messages;
}

function total(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

test("a short history is returned unchanged", () => {
  const history = [SYSTEM, ...turn(1), ...turn(2)];
  assert.deepEqual(fitHistory(history, 5000), history);
});

test("drops the oldest turns first and marks the cut", () => {
  const history = [SYSTEM, ...turn(1, 3000), ...turn(2, 3000), ...turn(3, 3000), { role: "user", content: "question 4" } as ChatMessage];
  const fitted = fitHistory(history, 1500);
  assert.deepEqual(fitted[0], SYSTEM);
  assert.deepEqual(fitted[1], { role: "user", content: "[earlier conversation omitted]" });
  assert.deepEqual(fitted.at(-1), { role: "user", content: "question 4" });
  assert.ok(!fitted.some((m) => m.role === "user" && m.content === "question 1"));
  assert.ok(total(fitted) <= 1500, `got ${total(fitted)}`);
});

test("never splits a tool-call group", () => {
  const history = [SYSTEM, ...turn(1, 3000), ...turn(2, 3000), { role: "user", content: "question 3" } as ChatMessage];
  for (const budget of [400, 800, 1200, 1300, 1600, 2400]) {
    const fitted = fitHistory(history, budget);
    for (let i = 0; i < fitted.length; i++) {
      const message = fitted[i]!;
      if (message.role === "tool") {
        const before = fitted[i - 1]!;
        assert.ok(before.role === "tool" || (before.role === "assistant" && (before.toolCalls?.length ?? 0) > 0), `orphan tool result at budget ${budget}`);
      }
      if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
        assert.equal(fitted[i + 1]?.role, "tool", `tool call without its result at budget ${budget}`);
      }
    }
  }
});

test("keeps the system message and the last user message whatever the budget", () => {
  const last: ChatMessage = { role: "user", content: "y".repeat(9000) };
  const fitted = fitHistory([SYSTEM, ...turn(1), last], 100);
  assert.deepEqual(fitted[0], SYSTEM);
  assert.deepEqual(fitted.at(-1), last);
});

test("keeps the tool results of the turn in progress", () => {
  const history: ChatMessage[] = [
    SYSTEM, ...turn(1, 3000),
    { role: "user", content: "question 2" },
    { role: "assistant", content: "", toolCalls: [{ name: "search", arguments: { query: "clamp" } }], from: "pc" },
    { role: "tool", toolName: "search", content: "src/math.js:1: clamp" },
  ];
  const fitted = fitHistory(history, 600);
  assert.deepEqual(fitted.at(-1), { role: "tool", toolName: "search", content: "src/math.js:1: clamp" });
  assert.ok(fitted.some((m) => m.role === "user" && m.content === "question 2"));
});

test("forty turns with large tool results fit the budget", () => {
  const history: ChatMessage[] = [SYSTEM];
  for (let n = 1; n <= 40; n++) history.push(...turn(n, 4500));
  history.push({ role: "user", content: "question 41" });
  const fitted = fitHistory(history, 5000);
  assert.ok(total(fitted) <= 5000, `got ${total(fitted)}`);
  assert.deepEqual(fitted.at(-1), { role: "user", content: "question 41" });
});

test("renderTranscript labels each role and shows tool calls with their arguments", () => {
  const text = renderTranscript([SYSTEM, ...turn(1, 20), { role: "assistant", content: "from claude", from: "claude" }, { role: "user", content: "next" }], 5000);
  assert.ok(!text.includes("You are a coding assistant."));
  assert.match(text, /^User:\nquestion 1$/m);
  assert.ok(text.includes('Tool call: read_file({"path":"f1.js"})'));
  assert.ok(text.includes("Tool result (read_file):\nxxxxxxxxxxxxxxxxxxxx"));
  assert.ok(text.includes("Assistant (pc):\nanswer 1"));
  assert.ok(text.includes("Assistant (claude):\nfrom claude"));
  assert.ok(text.trimEnd().endsWith("User:\nnext"));
});

test("renderTranscript stays within its budget and keeps the last user message", () => {
  const history: ChatMessage[] = [SYSTEM];
  for (let n = 1; n <= 40; n++) history.push(...turn(n, 4500));
  history.push({ role: "user", content: "the last question" });
  const text = renderTranscript(history, 3000);
  assert.ok(text.length <= 3000 * 3 + 200, `got ${text.length} chars`);
  assert.ok(text.includes("the last question"));
  assert.ok(text.includes("[earlier conversation omitted]"));
});
