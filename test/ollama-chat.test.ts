import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaBackend } from "../src/backends/ollama.ts";
import type { OllamaBackendConfig } from "../src/core/config.ts";
import { BackendError } from "../src/core/types.ts";
import type { ChatMessage } from "../src/agent/messages.ts";
import { TOOL_DEFINITIONS } from "../src/agent/tools.ts";
import { closedPortUrl, json, scriptedChat, startFakeOllama, toolCall } from "./helpers/fake-ollama.ts";
import type { ScriptedReply } from "./helpers/fake-ollama.ts";

function cfg(baseUrl: string): OllamaBackendConfig {
  return { type: "ollama", baseUrl, model: "qwen3:8b", timeoutMs: 5000, healthTimeoutMs: 1000, options: { num_ctx: 8192, temperature: 0.2 } };
}

const QUESTION: ChatMessage[] = [{ role: "user", content: "what does clamp do?" }];

async function withServer<T>(replies: ScriptedReply[], fn: (backend: OllamaBackend, requests: { path: string; body: string }[]) => Promise<T>): Promise<T> {
  const server = await startFakeOllama(scriptedChat(replies));
  try {
    return await fn(new OllamaBackend("pc-ollama", cfg(server.url)), server.requests);
  } finally {
    await server.close();
  }
}

function hasReason(reason: string) {
  return (err: unknown) => err instanceof BackendError && err.reason === reason;
}

test("sends messages and tools in Ollama's format", async () => {
  await withServer([{ content: "It clamps." }], async (backend, requests) => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "what does clamp do?" },
      { role: "assistant", content: "", toolCalls: [{ name: "read_file", arguments: { path: "a.js" } }], from: "pc-ollama" },
      { role: "tool", toolName: "read_file", content: "1: export function clamp() {}" },
    ];
    await backend.chat({ messages, tools: TOOL_DEFINITIONS, timeoutMs: 5000 });
    const body = JSON.parse(requests.at(-1)!.body) as Record<string, unknown>;
    assert.equal(body.model, "qwen3:8b");
    assert.equal(body.stream, false);
    assert.deepEqual(body.options, { num_ctx: 8192, temperature: 0.2 });
    assert.deepEqual(body.tools, TOOL_DEFINITIONS);
    assert.deepEqual(body.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "what does clamp do?" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.js" } } }] },
      { role: "tool", tool_name: "read_file", content: "1: export function clamp() {}" },
    ]);
  });
});

test("maps a tool call", async () => {
  await withServer([{ tool_calls: [toolCall("read_file", { path: "a.js" })] }], async (backend) => {
    const result = await backend.chat({ messages: QUESTION, tools: TOOL_DEFINITIONS, timeoutMs: 5000 });
    assert.deepEqual(result.toolCalls, [{ name: "read_file", arguments: { path: "a.js" } }]);
    assert.equal(result.content, "");
    assert.equal(result.promptTokens, 50);
    assert.equal(result.outputTokens, 5);
  });
});

test("maps several calls in one reply", async () => {
  await withServer([{ tool_calls: [toolCall("list_dir", {}), toolCall("search", { query: "clamp" })] }], async (backend) => {
    const result = await backend.chat({ messages: QUESTION, tools: TOOL_DEFINITIONS, timeoutMs: 5000 });
    assert.deepEqual(result.toolCalls.map((call) => call.name), ["list_dir", "search"]);
  });
});

test("maps a plain answer", async () => {
  await withServer([{ content: "It clamps." }], async (backend) => {
    const result = await backend.chat({ messages: QUESTION, tools: TOOL_DEFINITIONS, timeoutMs: 5000 });
    assert.equal(result.content, "It clamps.");
    assert.deepEqual(result.toolCalls, []);
  });
});

test("tolerates malformed tool calls", async () => {
  const calls = [{ function: { name: "read_file", arguments: "not json" } }, { function: { arguments: { path: "a.js" } } }, "junk", { function: { name: "search", arguments: ["a"] } }];
  await withServer([{ tool_calls: calls }], async (backend) => {
    const result = await backend.chat({ messages: QUESTION, tools: TOOL_DEFINITIONS, timeoutMs: 5000 });
    assert.deepEqual(result.toolCalls, [{ name: "read_file", arguments: {} }, { name: "search", arguments: {} }]);
  });
});

test("an empty reply with no tool call is a backend error", async () => {
  await withServer([{ content: "  " }], async (backend) => {
    await assert.rejects(backend.chat({ messages: QUESTION, tools: TOOL_DEFINITIONS, timeoutMs: 5000 }), hasReason("backend_error"));
  });
});

test("a model without tool support gets a clear error", async () => {
  await withServer([{ status: 400, error: "registry.ollama.ai/library/tiny:1b does not support tools" }], async (backend) => {
    await assert.rejects(
      backend.chat({ messages: QUESTION, tools: TOOL_DEFINITIONS, timeoutMs: 5000 }),
      (err: unknown) => err instanceof BackendError && err.reason === "backend_error" && /does not support tool calling/.test(err.message),
    );
  });
});

test("chat times out, reports an unreachable host and a truncated prompt like run", async () => {
  const hanging = await startFakeOllama(() => {});
  try {
    const backend = new OllamaBackend("pc", cfg(hanging.url));
    await assert.rejects(backend.chat({ messages: QUESTION, tools: [], timeoutMs: 200 }), hasReason("timeout"));
  } finally {
    await hanging.close();
  }
  const gone = new OllamaBackend("pc", cfg(await closedPortUrl()));
  await assert.rejects(gone.chat({ messages: QUESTION, tools: [], timeoutMs: 2000 }), hasReason("pc_unreachable"));

  const full = await startFakeOllama((_req, _body, res) => json(res, 200, { message: { content: "x" }, prompt_eval_count: 8192 }));
  try {
    const backend = new OllamaBackend("pc", cfg(full.url));
    await assert.rejects(
      backend.chat({ messages: QUESTION, tools: [], timeoutMs: 2000 }),
      (err: unknown) => err instanceof BackendError && /truncated/.test(err.message),
    );
  } finally {
    await full.close();
  }
});

test("chat without tools sends no tools key", async () => {
  await withServer([{ content: "LOCAL" }], async (backend, requests) => {
    await backend.chat({ messages: QUESTION, tools: [], timeoutMs: 5000 });
    assert.equal("tools" in (JSON.parse(requests.at(-1)!.body) as object), false);
  });
});
