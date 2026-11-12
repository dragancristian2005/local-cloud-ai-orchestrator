import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaBackend } from "../src/backends/ollama.ts";
import { createBackend } from "../src/backends/backend.ts";
import type { OllamaBackendConfig } from "../src/core/config.ts";
import { BackendError, ConfigError } from "../src/core/types.ts";
import { closedPortUrl, json, startFakeOllama } from "./helpers/fake-ollama.ts";

function cfg(baseUrl: string, over: Partial<OllamaBackendConfig> = {}): OllamaBackendConfig {
  return {
    type: "ollama",
    baseUrl,
    model: "qwen2.5-coder:7b",
    timeoutMs: 5000,
    healthTimeoutMs: 1000,
    options: { num_ctx: 8192, temperature: 0.2 },
    ...over,
  };
}

function hasReason(reason: string) {
  return (err: unknown) => err instanceof BackendError && err.reason === reason;
}

test("sends the chat request and maps the response", async () => {
  const server = await startFakeOllama((_req, _body, res) =>
    json(res, 200, { message: { content: "Add helper" }, prompt_eval_count: 12, eval_count: 3 }),
  );
  try {
    const backend = new OllamaBackend("pc-ollama", cfg(server.url));
    const result = await backend.run({ prompt: "write it", timeoutMs: 5000 });

    const request = server.requests[0];
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/chat");
    assert.deepEqual(JSON.parse(request.body), {
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "write it" }],
      stream: false,
      options: { num_ctx: 8192, temperature: 0.2 },
    });
    assert.equal(result.text, "Add helper");
    assert.equal(result.promptTokens, 12);
    assert.equal(result.outputTokens, 3);
    assert.equal(result.model, "qwen2.5-coder:7b");
    assert.ok(result.durationMs >= 0);
  } finally {
    await server.close();
  }
});

test("describes itself as a local backend", () => {
  const backend = new OllamaBackend("pc-ollama", cfg("http://127.0.0.1:1"));
  assert.equal(backend.id, "pc-ollama");
  assert.equal(backend.name, "ollama:qwen2.5-coder:7b");
  assert.equal(backend.kind, "local");
  assert.equal(backend.timeoutMs, 5000);
});

test("health check is true on 200", async () => {
  const server = await startFakeOllama((_req, _body, res) => json(res, 200, { models: [] }));
  try {
    assert.equal(await new OllamaBackend("pc", cfg(server.url)).healthCheck(), true);
    assert.equal(server.requests[0]?.path, "/api/tags");
  } finally {
    await server.close();
  }
});

test("health check is false when nothing listens", async () => {
  assert.equal(await new OllamaBackend("pc", cfg(await closedPortUrl())).healthCheck(), false);
});

test("health check gives up on a hanging server", async () => {
  const server = await startFakeOllama(() => {});
  try {
    const started = Date.now();
    const healthy = await new OllamaBackend("pc", cfg(server.url, { healthTimeoutMs: 200 })).healthCheck();
    assert.equal(healthy, false);
    assert.ok(Date.now() - started < 1000, "health check should stop at healthTimeoutMs");
  } finally {
    await server.close();
  }
});

test("run times out", async () => {
  const server = await startFakeOllama(() => {});
  try {
    const backend = new OllamaBackend("pc", cfg(server.url));
    await assert.rejects(backend.run({ prompt: "x", timeoutMs: 200 }), hasReason("timeout"));
  } finally {
    await server.close();
  }
});

test("run reports an unreachable host", async () => {
  const backend = new OllamaBackend("pc", cfg(await closedPortUrl()));
  await assert.rejects(backend.run({ prompt: "x", timeoutMs: 2000 }), hasReason("pc_unreachable"));
});

test("model not pulled is a backend error", async () => {
  const server = await startFakeOllama((_req, _body, res) => json(res, 404, { error: "model 'x' not found" }));
  try {
    const backend = new OllamaBackend("pc", cfg(server.url));
    await assert.rejects(
      backend.run({ prompt: "x", timeoutMs: 2000 }),
      (err: unknown) =>
        err instanceof BackendError && err.reason === "backend_error" && err.message.includes("qwen2.5-coder:7b"),
    );
  } finally {
    await server.close();
  }
});

test("empty content is a backend error", async () => {
  const server = await startFakeOllama((_req, _body, res) => json(res, 200, { message: { content: "" } }));
  try {
    const backend = new OllamaBackend("pc", cfg(server.url));
    await assert.rejects(backend.run({ prompt: "x", timeoutMs: 2000 }), hasReason("backend_error"));
  } finally {
    await server.close();
  }
});

test("a prompt that filled the context window is a backend error", async () => {
  const server = await startFakeOllama((_req, _body, res) =>
    json(res, 200, { message: { content: "Add helper" }, prompt_eval_count: 8192, eval_count: 3 }),
  );
  try {
    const backend = new OllamaBackend("pc", cfg(server.url));
    await assert.rejects(
      backend.run({ prompt: "x", timeoutMs: 2000 }),
      (err: unknown) => err instanceof BackendError && err.reason === "backend_error" && /truncated/.test(err.message),
    );
  } finally {
    await server.close();
  }
});

test("createBackend refuses the PC_ADDRESS placeholder", () => {
  assert.throws(
    () => createBackend("pc-ollama", cfg("http://PC_ADDRESS:11434")),
    (err: unknown) => err instanceof ConfigError && /PC_ADDRESS/.test(err.message),
  );
});

test("createBackend builds an Ollama backend and applies a model override", () => {
  const backend = createBackend("pc-ollama", cfg("http://127.0.0.1:1"), { model: "falcon:7b" });
  assert.equal(backend.model, "falcon:7b");
  assert.equal(backend.name, "ollama:falcon:7b");
});
