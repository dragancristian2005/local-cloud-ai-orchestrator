import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, PROJECT_ROOT } from "../src/core/config.ts";
import { ConfigError } from "../src/core/types.ts";

const BASE = {
  backends: {
    "pc-ollama": { type: "ollama", baseUrl: "http://PC_ADDRESS:11434", model: "qwen2.5-coder:7b", timeoutMs: 120000 },
  },
  chains: { "commit-message": ["pc-ollama"] },
  retryBeforeEscalate: 1,
};

function writeConfig(config: unknown, local?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "orch-config-"));
  const file = path.join(dir, "orchestrator.config.json");
  writeFileSync(file, JSON.stringify(config));
  if (local !== undefined) writeFileSync(path.join(dir, "orchestrator.local.json"), JSON.stringify(local));
  return file;
}

test("applies defaults", () => {
  const cfg = loadConfig(writeConfig(BASE));
  const ollama = cfg.backends["pc-ollama"];
  assert.ok(ollama && ollama.type === "ollama");
  assert.equal(ollama.healthTimeoutMs, 3000);
  assert.deepEqual(ollama.options, { num_ctx: 8192, temperature: 0.2 });
  assert.equal(cfg.promptTokenBudget, 6000);
  assert.equal(cfg.runsDir, path.join(PROJECT_ROOT, "runs"));
  assert.equal(cfg.retryBeforeEscalate, 1);
});

test("merges the local file", () => {
  const file = writeConfig(BASE, { backends: { "pc-ollama": { baseUrl: "http://10.0.0.5:11434" } } });
  const ollama = loadConfig(file).backends["pc-ollama"];
  assert.ok(ollama && ollama.type === "ollama");
  assert.equal(ollama.baseUrl, "http://10.0.0.5:11434");
  assert.equal(ollama.model, "qwen2.5-coder:7b");
});

test("rejects a chain naming an unknown backend", () => {
  const file = writeConfig({ ...BASE, chains: { "commit-message": ["pc-ollama", "ghost"] } });
  assert.throws(() => loadConfig(file), (err: unknown) => err instanceof ConfigError && /ghost/.test(err.message));
});

test("rejects an unknown backend type", () => {
  const file = writeConfig({ ...BASE, backends: { "pc-ollama": { type: "openai", timeoutMs: 1 } } });
  assert.throws(() => loadConfig(file), ConfigError);
});

test("rejects retryBeforeEscalate of 3", () => {
  assert.throws(() => loadConfig(writeConfig({ ...BASE, retryBeforeEscalate: 3 })), ConfigError);
});

test("rejects a missing file", () => {
  assert.throws(() => loadConfig(path.join(tmpdir(), "orch-does-not-exist", "x.json")), ConfigError);
});

test("rejects extra keys on a claude-cli backend", () => {
  const file = writeConfig({
    ...BASE,
    backends: { ...BASE.backends, claude: { type: "claude-cli", timeoutMs: 1, bin: "/tmp/x" } },
  });
  assert.throws(() => loadConfig(file), (err: unknown) => err instanceof ConfigError && /bin/.test(err.message));
});

test("the committed config loads", () => {
  const cfg = loadConfig();
  assert.ok(cfg.chains["commit-message"]);
});

test("rejects a baseUrl that is not an http URL", () => {
  for (const baseUrl of ["192.168.1.50:11434", "mypc:11434", "ftp://mypc:11434"]) {
    const file = writeConfig({ ...BASE, backends: { "pc-ollama": { ...BASE.backends["pc-ollama"], baseUrl } } });
    assert.throws(() => loadConfig(file), (err: unknown) => err instanceof ConfigError && /baseUrl/.test(err.message), baseUrl);
  }
});

test("agent settings have defaults", () => {
  const cfg = loadConfig(writeConfig(BASE));
  assert.deepEqual(cfg.agent, {
    maxSteps: 8,
    commandTimeoutMs: 60000,
    allowCommands: ["git status", "git diff", "git log", "ls", "pwd"],
    historyTokenBudget: 5000,
    claudeTranscriptTokens: 20000,
  });
});

test("the local file can extend the allow-list and keep the other agent defaults", () => {
  const file = writeConfig(BASE, { agent: { allowCommands: ["git status", "npm test"] } });
  const cfg = loadConfig(file);
  assert.deepEqual(cfg.agent.allowCommands, ["git status", "npm test"]);
  assert.equal(cfg.agent.maxSteps, 8);
});

test("rejects invalid agent settings", () => {
  assert.throws(() => loadConfig(writeConfig({ ...BASE, agent: { maxSteps: 0 } })), ConfigError);
  assert.throws(() => loadConfig(writeConfig({ ...BASE, agent: { allowCommands: "git status" } })), ConfigError);
  assert.throws(() => loadConfig(writeConfig({ ...BASE, agent: { allowCommands: ["ok", 5] } })), ConfigError);
  assert.throws(() => loadConfig(writeConfig({ ...BASE, agent: { commandTimeoutMs: -1 } })), ConfigError);
});
