import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { closedPortUrl, scriptedChat, startFakeOllama, toolCall } from "./helpers/fake-ollama.ts";
import type { ScriptedReply } from "./helpers/fake-ollama.ts";
import { fakeClaudeEnv, runCli, twoTierConfig, writeTempConfig } from "./helpers/run-cli.ts";
import { makeTempRepo } from "./helpers/temp-repo.ts";

const SOURCE = { "src/math.js": "export function clamp(n) {\n  return n;\n}\n" };
const LOCAL: ScriptedReply = { content: "LOCAL" };

async function chat(script: ScriptedReply[], typed: string[], env: Record<string, string> = {}) {
  const server = await startFakeOllama(scriptedChat(script));
  try {
    const repo = realpathSync(await makeTempRepo(SOURCE, { stage: true }));
    const { configPath, runsDir } = writeTempConfig(twoTierConfig(server.url, ["chat"]));
    const result = await runCli(["chat", "--repo", repo, "--config", configPath], env, typed.map((line) => line + "\n").join(""));
    const chats = server.requests.filter((req) => req.path === "/api/chat").map((req) => JSON.parse(req.body) as { messages: { role: string; content: string }[] });
    return { result, repo, runsDir, chats };
  } finally {
    await server.close();
  }
}

function logLines(runsDir: string): Record<string, unknown>[] {
  return readFileSync(path.join(runsDir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("answers a question locally using read_file", async () => {
  const { result, chats, runsDir } = await chat([LOCAL, { tool_calls: [toolCall("read_file", { path: "src/math.js" })] }, { content: "It returns n." }], ["what does clamp do?", "/exit"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes("local> It returns n.\n"), result.stdout);
  assert.match(result.stderr, /\[read_file src\/math\.js\]/);
  const last = chats.at(-1)!.messages.at(-1)!;
  assert.equal(last.role, "tool");
  assert.ok(last.content.includes("1: export function clamp(n) {"));
  const lines = logLines(runsDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.mode, "chat");
});

test("runs an approved command", async () => {
  const { result, chats } = await chat(
    [LOCAL, { tool_calls: [toolCall("run_command", { command: `node -e "console.log(40 + 2)"` })] }, { content: "It printed 42." }],
    ["what is 40 plus 2?", "y", "/exit"],
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(chats.at(-1)!.messages.at(-1)!.content, "exit code 0\n42");
  assert.ok(result.stdout.includes("local> It printed 42.\n"));
});

test("never runs a refused command", async () => {
  const { result, chats, repo } = await chat(
    [LOCAL, { tool_calls: [toolCall("run_command", { command: "rm -rf ." })] }, { content: "I could not clean up." }],
    ["clean the repository", "/exit"],
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(path.join(repo, "src/math.js")), true);
  assert.match(chats.at(-1)!.messages.at(-1)!.content, /^refused:/);
});

test("the triage sends a request to Claude, which runs read-only in the repository", async () => {
  const argsFile = path.join(mkdtempSync(path.join(tmpdir(), "orch-chat-args-")), "args.json");
  const env = fakeClaudeEnv({ FAKE_CLAUDE_REPLY: "Here is the diff.", FAKE_CLAUDE_ARGS: argsFile });
  const { result, repo, runsDir, chats } = await chat([{ content: "CLAUDE" }], ["make clamp generic", "/exit"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes("claude> Here is the diff.\n"), result.stdout);
  assert.match(result.stderr, /\(to claude: the request needs more than the local model\)/);
  assert.equal(chats.length, 1, "only the triage reached the local model");
  const recorded = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[]; cwd: string };
  assert.ok(recorded.args.includes("Read,Grep,Glob"));
  assert.ok(!recorded.args.some((arg) => /Bash|Edit|Write|default/.test(arg)));
  assert.equal(recorded.cwd, repo);
  const lines = logLines(runsDir);
  assert.deepEqual(lines.map((line) => [line.mode, line.tier, line.fallbackReason]), [["chat", 0, "triage"], ["chat", 1, null]]);
});

test("the local model hands over mid-turn", async () => {
  const env = fakeClaudeEnv({ FAKE_CLAUDE_REPLY: "Claude took over." });
  const { result, runsDir } = await chat([LOCAL, { tool_calls: [toolCall("ask_claude", { reason: "too hard" })] }], ["explain the design", "/exit"], env);
  assert.ok(result.stdout.includes("claude> Claude took over.\n"), result.stdout);
  assert.equal(logLines(runsDir)[0]!.fallbackReason, "agent_asked");
});

test("with the PC off, Claude answers", async () => {
  const repo = realpathSync(await makeTempRepo(SOURCE, { stage: true }));
  const { configPath, runsDir } = writeTempConfig(twoTierConfig(await closedPortUrl(), ["chat"]));
  const env = fakeClaudeEnv({ FAKE_CLAUDE_REPLY: "Answer from Claude." });
  const result = await runCli(["chat", "--repo", repo, "--config", configPath], env, "hello\n/exit\n");
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes("claude> Answer from Claude.\n"));
  assert.equal(logLines(runsDir)[0]!.fallbackReason, "pc_unreachable");
});

test("the banner names the model and the folder", async () => {
  const { result, repo } = await chat([], ["/exit"]);
  assert.ok(result.stderr.includes("qwen2.5-coder:7b"));
  assert.ok(result.stderr.includes(repo));
  assert.ok(result.stderr.includes("/help"));
});

test("orch chat refuses the home directory", async () => {
  const { configPath } = writeTempConfig(twoTierConfig("http://127.0.0.1:1", ["chat"]));
  const result = await runCli(["chat", "--repo", homedir(), "--config", configPath], {}, "");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /home directory/);
});

test("the chat chain must start with an Ollama backend", async () => {
  const repo = await makeTempRepo(SOURCE);
  const config = twoTierConfig("http://127.0.0.1:1", ["chat"]);
  const { configPath } = writeTempConfig({ ...config, chains: { chat: ["claude"] } });
  const result = await runCli(["chat", "--repo", repo, "--config", configPath], {}, "");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Ollama/);
});

test("a config with no chat chain is a config error", async () => {
  const repo = await makeTempRepo(SOURCE);
  const { configPath } = writeTempConfig(twoTierConfig("http://127.0.0.1:1", ["commit-message"]));
  const result = await runCli(["chat", "--repo", repo, "--config", configPath], {}, "");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /chat/);
});

test("orch with no arguments and piped input still prints the usage", async () => {
  const result = await runCli([], {}, "");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: orch/i);
});
