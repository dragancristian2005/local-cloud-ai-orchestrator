import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BILLING_ENV_VARS, ClaudeCliBackend } from "../src/backends/claude-cli.ts";
import { createBackend } from "../src/backends/backend.ts";
import { BackendError } from "../src/core/types.ts";

const FAKE = path.resolve(import.meta.dirname, "fixtures/fake-claude.mjs");
const ENV_KEYS = ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_TRACE", "FAKE_CLAUDE_ARGS", "FAKE_CLAUDE_REPLY"];

// The machine running the tests may have these set; the backend refuses to run when they are.
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of BILLING_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const key of BILLING_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function scratchFile(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "orch-claude-")), name);
}

function backend(model?: string): ClaudeCliBackend {
  return new ClaudeCliBackend("claude", { type: "claude-cli", timeoutMs: 5000, ...(model ? { model } : {}) }, { bin: FAKE });
}

function hasReason(reason: string) {
  return (err: unknown) => err instanceof BackendError && err.reason === reason;
}

test("passes the documented flags and the prompt on stdin", async () => {
  const argsFile = (process.env.FAKE_CLAUDE_ARGS = scratchFile("args.json"));
  const result = await backend().run({ prompt: "abc", timeoutMs: 5000 });
  const call = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[] };
  assert.deepEqual(call.args, ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--safe-mode"]);
  assert.equal(result.text, "cba");
});

test("adds --model when configured", async () => {
  const argsFile = (process.env.FAKE_CLAUDE_ARGS = scratchFile("args.json"));
  await backend("sonnet").run({ prompt: "abc", timeoutMs: 5000 });
  const call = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[] };
  assert.deepEqual(call.args.slice(-2), ["--model", "sonnet"]);
});

test("maps tokens and model", async () => {
  const result = await backend().run({ prompt: "abc", timeoutMs: 5000 });
  assert.equal(result.promptTokens, 5);
  assert.equal(result.outputTokens, 2);
  assert.equal(result.model, "fake-model");
  assert.ok(result.durationMs >= 100);
});

test("describes itself as a cloud backend", () => {
  const b = backend();
  assert.equal(b.id, "claude");
  assert.equal(b.name, "claude-cli");
  assert.equal(b.kind, "cloud");
  assert.equal(b.model, "default");
  assert.equal(b.timeoutMs, 5000);
  assert.equal(backend("opus").model, "opus");
});

for (const mode of ["error", "is_error", "badjson"]) {
  test(`mode ${mode} is a backend error`, async () => {
    process.env.FAKE_CLAUDE_MODE = mode;
    await assert.rejects(backend().run({ prompt: "abc", timeoutMs: 5000 }), hasReason("backend_error"));
  });
}

test("a hanging call times out and the child is gone", async () => {
  process.env.FAKE_CLAUDE_MODE = "hang";
  const traceFile = (process.env.FAKE_CLAUDE_TRACE = scratchFile("trace.txt"));
  await assert.rejects(backend().run({ prompt: "abc", timeoutMs: 300 }), hasReason("timeout"));
  const pid = Number(readFileSync(traceFile, "utf8").split(" ")[1]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), "the child should not be running any more");
});

for (const variable of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"]) {
  test(`refuses to start claude when ${variable} is set`, async () => {
    process.env[variable] = "secret-value-123";
    const traceFile = (process.env.FAKE_CLAUDE_TRACE = scratchFile("trace.txt"));
    await assert.rejects(
      backend().run({ prompt: "abc", timeoutMs: 5000 }),
      (err: unknown) =>
        err instanceof BackendError &&
        err.reason === "backend_error" &&
        err.message.includes(variable) &&
        !err.message.includes("secret-value-123"),
    );
    assert.equal(existsSync(traceFile), false, "claude must not have been started");
  });
}

test("an empty billing variable does not block the call", async () => {
  process.env.ANTHROPIC_API_KEY = "";
  assert.equal((await backend().run({ prompt: "abc", timeoutMs: 5000 })).text, "cba");
});

test("healthCheck is true when the binary answers --version", async () => {
  assert.equal(await backend().healthCheck(), true);
});

test("healthCheck is false when the binary does not exist", async () => {
  const missing = new ClaudeCliBackend("claude", { type: "claude-cli", timeoutMs: 5000 }, { bin: "/nonexistent/claude" });
  assert.equal(await missing.healthCheck(), false);
});

test("a failed health check does not keep the process alive", () => {
  const module = path.resolve(import.meta.dirname, "../src/backends/claude-cli.ts");
  const script = `
    import { ClaudeCliBackend } from ${JSON.stringify(module)};
    const b = new ClaudeCliBackend("claude", { type: "claude-cli", timeoutMs: 5000 }, { bin: "/nonexistent/claude" });
    console.log(await b.healthCheck());
  `;
  const started = Date.now();
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out.trim(), "false");
  assert.ok(Date.now() - started < 3000, `process took ${Date.now() - started} ms to exit`);
});

test("a missing binary is a backend error on run", async () => {
  const missing = new ClaudeCliBackend("claude", { type: "claude-cli", timeoutMs: 5000 }, { bin: "/nonexistent/claude" });
  await assert.rejects(missing.run({ prompt: "abc", timeoutMs: 5000 }), hasReason("backend_error"));
});

test("runs one call at a time, across instances", async () => {
  const traceFile = (process.env.FAKE_CLAUDE_TRACE = scratchFile("trace.txt"));
  await Promise.all([
    backend().run({ prompt: "one", timeoutMs: 5000 }),
    backend().run({ prompt: "two", timeoutMs: 5000 }),
  ]);
  const events = readFileSync(traceFile, "utf8").trim().split("\n").map((line) => line.split(" ")[0]);
  assert.deepEqual(events, ["start", "end", "start", "end"]);
});

test("a failed call does not block the next one", async () => {
  process.env.FAKE_CLAUDE_MODE = "error";
  await assert.rejects(backend().run({ prompt: "abc", timeoutMs: 5000 }));
  process.env.FAKE_CLAUDE_MODE = "ok";
  assert.equal((await backend().run({ prompt: "abc", timeoutMs: 5000 })).text, "cba");
});

test("does not run in the caller's directory", async () => {
  const argsFile = (process.env.FAKE_CLAUDE_ARGS = scratchFile("args.json"));
  await backend().run({ prompt: "abc", timeoutMs: 5000 });
  const call = JSON.parse(readFileSync(argsFile, "utf8")) as { cwd: string };
  assert.ok(call.cwd.startsWith(realpathSync(tmpdir())), call.cwd);
  assert.notEqual(call.cwd, realpathSync(process.cwd()));
});

test("createBackend builds the Claude backend from config", () => {
  const b = createBackend("claude", { type: "claude-cli", timeoutMs: 300000 });
  assert.equal(b.kind, "cloud");
  assert.equal(b.name, "claude-cli");
  assert.equal(b.timeoutMs, 300000);
});
