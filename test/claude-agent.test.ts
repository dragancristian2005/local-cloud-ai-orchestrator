import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BILLING_ENV_VARS, CHAT_TOOLS, ClaudeCliBackend } from "../src/backends/claude-cli.ts";
import { BackendError } from "../src/core/types.ts";

const FAKE = path.resolve(import.meta.dirname, "fixtures/fake-claude.mjs");
const ENV_KEYS = ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_TRACE", "FAKE_CLAUDE_ARGS", "FAKE_CLAUDE_REPLY"];
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

function scratch(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "orch-claude-agent-")), name);
}

function backend(model?: string): ClaudeCliBackend {
  return new ClaudeCliBackend("claude", { type: "claude-cli", timeoutMs: 5000, ...(model ? { model } : {}) }, { bin: FAKE });
}

function hasReason(reason: string) {
  return (err: unknown) => err instanceof BackendError && err.reason === reason;
}

const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-claude-repo-")));

test("the chat tool list is read-only", () => {
  assert.equal(CHAT_TOOLS, "Read,Grep,Glob");
});

test("runAgent passes the read-only tool list and no other tools", async () => {
  const argsFile = (process.env.FAKE_CLAUDE_ARGS = scratch("args.json"));
  const result = await backend().runAgent({ prompt: "abc", cwd: repo, timeoutMs: 5000 });
  const recorded = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[]; cwd: string };
  assert.deepEqual(recorded.args, ["-p", "--output-format", "json", "--tools", "Read,Grep,Glob", "--permission-prompts", "none", "--no-session-persistence", "--safe-mode"]);
  assert.equal(result.text, "cba");
  assert.equal(result.model, "fake-model");
});

test("runAgent runs in the given directory and leaves it in place", async () => {
  const argsFile = (process.env.FAKE_CLAUDE_ARGS = scratch("args.json"));
  await backend().runAgent({ prompt: "abc", cwd: repo, timeoutMs: 5000 });
  assert.equal((JSON.parse(readFileSync(argsFile, "utf8")) as { cwd: string }).cwd, repo);
  assert.equal(existsSync(repo), true);
});

test("runAgent adds --model when configured", async () => {
  const argsFile = (process.env.FAKE_CLAUDE_ARGS = scratch("args.json"));
  await backend("sonnet").runAgent({ prompt: "abc", cwd: repo, timeoutMs: 5000 });
  assert.deepEqual((JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[] }).args.slice(-2), ["--model", "sonnet"]);
});

test("run and runAgent share one queue", async () => {
  const traceFile = (process.env.FAKE_CLAUDE_TRACE = scratch("trace.txt"));
  await Promise.all([backend().run({ prompt: "one", timeoutMs: 5000 }), backend().runAgent({ prompt: "two", cwd: repo, timeoutMs: 5000 })]);
  const events = readFileSync(traceFile, "utf8").trim().split("\n").map((line) => line.split(" ")[0]);
  assert.deepEqual(events, ["start", "end", "start", "end"]);
});

test("runAgent refuses when a billing variable is set", async () => {
  process.env.ANTHROPIC_API_KEY = "secret-value-123";
  const traceFile = (process.env.FAKE_CLAUDE_TRACE = scratch("trace.txt"));
  await assert.rejects(
    backend().runAgent({ prompt: "abc", cwd: repo, timeoutMs: 5000 }),
    (err: unknown) => err instanceof BackendError && err.message.includes("ANTHROPIC_API_KEY") && !err.message.includes("secret-value-123"),
  );
  assert.equal(existsSync(traceFile), false);
});

test("runAgent times out and reports errors like run", async () => {
  process.env.FAKE_CLAUDE_MODE = "hang";
  await assert.rejects(backend().runAgent({ prompt: "abc", cwd: repo, timeoutMs: 300 }), hasReason("timeout"));
  process.env.FAKE_CLAUDE_MODE = "is_error";
  await assert.rejects(backend().runAgent({ prompt: "abc", cwd: repo, timeoutMs: 5000 }), hasReason("backend_error"));
});

test("run is unchanged: no tools, no permission flag", async () => {
  const argsFile = (process.env.FAKE_CLAUDE_ARGS = scratch("args.json"));
  await backend().run({ prompt: "abc", timeoutMs: 5000 });
  const { args } = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[] };
  assert.deepEqual(args, ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--safe-mode"]);
});

function projectWithSettings(file: string, content: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-claude-settings-")));
  mkdirSync(path.join(dir, ".claude"));
  writeFileSync(path.join(dir, ".claude", file), content);
  return dir;
}

test("runAgent refuses a project whose Claude settings would change who is billed", async () => {
  const cases: [string, string, RegExp][] = [
    ["settings.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "secret-value-123" } }), /ANTHROPIC_API_KEY/],
    ["settings.local.json", JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }), /CLAUDE_CODE_USE_BEDROCK/],
    ["settings.json", JSON.stringify({ apiKeyHelper: "/bin/print-key" }), /apiKeyHelper/],
    ["settings.json", "{ not json", /cannot be read/],
  ];
  for (const [file, content, expected] of cases) {
    const dir = projectWithSettings(file, content);
    const traceFile = (process.env.FAKE_CLAUDE_TRACE = scratch("trace.txt"));
    await assert.rejects(
      backend().runAgent({ prompt: "abc", cwd: dir, timeoutMs: 5000 }),
      (err: unknown) => err instanceof BackendError && err.reason === "backend_error" && expected.test(err.message) && err.message.includes(file) && !err.message.includes("secret-value-123"),
      `${file}: ${content}`,
    );
    assert.equal(existsSync(traceFile), false);
  }
});

test("runAgent accepts a project with ordinary Claude settings", async () => {
  const dir = projectWithSettings("settings.json", JSON.stringify({ permissions: { allow: ["Read"] }, env: { NODE_ENV: "test" } }));
  assert.equal((await backend().runAgent({ prompt: "abc", cwd: dir, timeoutMs: 5000 })).text, "cba");
});
