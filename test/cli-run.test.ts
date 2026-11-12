import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { chatReplies, closedPortUrl, startFakeOllama } from "./helpers/fake-ollama.ts";
import { fakeClaudeEnv, ollamaOnlyConfig, runCli, twoTierConfig, writeTempConfig } from "./helpers/run-cli.ts";
import { makeTempRepo } from "./helpers/temp-repo.ts";

function logLines(runsDir: string): Record<string, unknown>[] {
  return readFileSync(path.join(runsDir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("prints the message and logs one line", async () => {
  const server = await startFakeOllama(chatReplies("Add greeting helper"));
  try {
    const repo = await makeTempRepo({ "greet.ts": "export const hi = 1;\n" }, { stage: true });
    const { configPath, runsDir } = writeTempConfig(ollamaOnlyConfig(server.url));
    const result = await runCli(["run", "--type", "commit-message", "--repo", repo, "--config", configPath]);

    assert.equal(result.stdout, "Add greeting helper\n");
    assert.equal(result.code, 0, result.stderr);
    const lines = logLines(runsDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.verify, "pass");
    assert.equal(lines[0]!.tier, 0);
    assert.equal(lines[0]!.repo, path.resolve(repo));
    assert.equal(lines[0]!.mode, "run");
    assert.match(result.stderr, /tier 0 pc-ollama \(qwen2\.5-coder:7b\): pass/);
    // The prompt was built from the staged diff.
    const chat = server.requests.find((req) => req.path === "/api/chat");
    assert.ok(chat && chat.body.includes("greet.ts"));
  } finally {
    await server.close();
  }
});

test("--model overrides the Ollama model", async () => {
  const server = await startFakeOllama(chatReplies("Add greeting helper"));
  try {
    const repo = await makeTempRepo({ "greet.ts": "export const hi = 1;\n" }, { stage: true });
    const { configPath, runsDir } = writeTempConfig(ollamaOnlyConfig(server.url));
    const result = await runCli(["run", "--type", "commit-message", "--repo", repo, "--config", configPath, "--model", "falcon:7b"]);
    assert.equal(result.code, 0, result.stderr);
    const chat = server.requests.find((req) => req.path === "/api/chat");
    assert.equal((JSON.parse(chat!.body) as { model: string }).model, "falcon:7b");
    assert.equal(logLines(runsDir)[0]!.model, "falcon:7b");
  } finally {
    await server.close();
  }
});

test("nothing staged: exit 2, no backend call, no log", async () => {
  const server = await startFakeOllama(chatReplies("Add greeting helper"));
  try {
    const repo = await makeTempRepo({ "greet.ts": "export const hi = 1;\n" });
    const { configPath, runsDir } = writeTempConfig(ollamaOnlyConfig(server.url));
    const result = await runCli(["run", "--type", "commit-message", "--repo", repo, "--config", configPath]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /nothing staged/);
    assert.equal(result.stdout, "");
    assert.equal(server.requests.filter((req) => req.path === "/api/chat").length, 0);
    assert.equal(existsSync(path.join(runsDir, "log.jsonl")), false);
  } finally {
    await server.close();
  }
});

test("PC unreachable: exit 1, empty stdout, logged as pc_unreachable", async () => {
  const repo = await makeTempRepo({ "greet.ts": "export const hi = 1;\n" }, { stage: true });
  const { configPath, runsDir } = writeTempConfig(ollamaOnlyConfig(await closedPortUrl()));
  const result = await runCli(["run", "--type", "commit-message", "--repo", repo, "--config", configPath]);

  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, "");
  const lines = logLines(runsDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.fallbackReason, "pc_unreachable");
  assert.match(result.stderr, /pc_unreachable/);
});

test("falls through to Claude when the PC is unreachable", async () => {
  const repo = await makeTempRepo({ "greet.ts": "export const hi = 1;\n" }, { stage: true });
  const { configPath, runsDir } = writeTempConfig(twoTierConfig(await closedPortUrl()));
  const env = fakeClaudeEnv({ FAKE_CLAUDE_REPLY: "Add greeting helper" });
  const result = await runCli(["run", "--type", "commit-message", "--repo", repo, "--config", configPath], env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Add greeting helper\n");
  const lines = logLines(runsDir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.fallbackReason, "pc_unreachable");
  assert.equal(lines[0]!.escalated, true);
  assert.equal(lines[1]!.tier, 1);
  assert.equal(lines[1]!.backend, "claude");
  assert.equal(lines[1]!.verify, "pass");
  assert.equal(lines[1]!.model, "fake-model");
});

test("escalates to Claude after the local model fails twice", async () => {
  const server = await startFakeOllama(chatReplies("Here are some thoughts about your diff."));
  try {
    const repo = await makeTempRepo({ "greet.ts": "export const hi = 1;\n" }, { stage: true });
    const { configPath, runsDir } = writeTempConfig(twoTierConfig(server.url));
    const env = fakeClaudeEnv({ FAKE_CLAUDE_REPLY: "Add greeting helper" });
    const result = await runCli(["run", "--type", "commit-message", "--repo", repo, "--config", configPath], env);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Add greeting helper\n");
    const lines = logLines(runsDir);
    assert.deepEqual(lines.map((line) => [line.tier, line.attempt, line.verify]), [[0, 0, "fail"], [0, 1, "fail"], [1, 0, "pass"]]);
    assert.equal(server.requests.filter((req) => req.path === "/api/chat").length, 2);
  } finally {
    await server.close();
  }
});

test("a task type with no chain is a config error", async () => {
  const repo = await makeTempRepo({ "greet.ts": "export const hi = 1;\n" }, { stage: true });
  const { configPath } = writeTempConfig({ ...ollamaOnlyConfig("http://127.0.0.1:1"), chains: { other: ["pc-ollama"] } });
  const result = await runCli(["run", "--type", "commit-message", "--repo", repo, "--config", configPath]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no chain/);
});

test("an unknown flag exits 2 with usage", async () => {
  const result = await runCli(["run", "--type", "commit-message", "--bogus"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: orch/i);
});

test("a missing --type exits 2 with usage", async () => {
  const result = await runCli(["run"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: orch/i);
});

test("no command exits 2 with usage; --help exits 0", async () => {
  assert.equal((await runCli([])).code, 2);
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: orch/i);
});
