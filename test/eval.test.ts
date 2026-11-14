import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFixedTasks, runEval } from "../eval/compare.ts";
import type { FixedTask } from "../eval/compare.ts";
import { PROJECT_ROOT } from "../src/core/config.ts";
import { runCommand } from "../src/core/command.ts";
import { BackendError, ConfigError } from "../src/core/types.ts";
import { RunLog } from "../src/log/run-log.ts";
import { taskModules } from "../src/tasks/task.ts";
import { fakeBackend } from "./helpers/fake-backend.ts";
import { closedPortUrl, json, startFakeOllama } from "./helpers/fake-ollama.ts";
import { fakeClaudeEnv, ollamaOnlyConfig, runCli, twoTierConfig, writeTempConfig } from "./helpers/run-cli.ts";

const FIXED_DIR = path.join(PROJECT_ROOT, "eval", "fixed-tasks");
const GOOD_COMMENT = "/**\n * Does the thing.\n */";

function docTask(id: string): FixedTask {
  return {
    id,
    taskType: "docstring",
    input: { text: "export function clamp(n: number) {\n  return n;\n}\n", filePath: "clamp.ts", symbol: "clamp" },
  };
}

function newLog(): RunLog {
  return new RunLog(path.join(mkdtempSync(path.join(tmpdir(), "orch-eval-")), "runs"));
}

test("the fixed task set has 16 well-formed tasks", () => {
  const tasks = loadFixedTasks(FIXED_DIR);
  assert.equal(tasks.length, 16);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 16);
  assert.deepEqual(tasks.map((task) => task.id), tasks.map((task) => task.id).toSorted());
  for (const task of tasks) {
    const module = taskModules[task.taskType];
    assert.ok(module, `${task.id}: unknown task type ${task.taskType}`);
    assert.ok(task.input.text.length > 0, `${task.id}: empty input`);
    if (task.taskType === "small-edit") {
      assert.ok(task.projectDir && existsSync(path.join(task.projectDir, task.input.filePath!)), `${task.id}: project file`);
      assert.ok(task.testCommand, `${task.id}: test command`);
      assert.ok(task.input.instruction, `${task.id}: instruction`);
      continue;
    }
    const prepared = module.prepare(task.input, 6000);
    assert.ok(prepared.prompt.length > task.input.text.length, task.id);
  }
  const count = (type: string) => tasks.filter((task) => task.taskType === type).length;
  assert.equal(count("commit-message"), 5);
  assert.equal(count("docstring"), 4);
  assert.equal(count("test-stub"), 3);
  assert.equal(count("small-edit"), 4);
});

const smallEditTasks = () => loadFixedTasks(FIXED_DIR).filter((task) => task.taskType === "small-edit");
const GREET = 'export function greet(name = "world") {\n  return `Hello, ${name}!`;\n}';

test("each small-edit fixture behaves as declared at HEAD", async () => {
  for (const task of smallEditTasks()) {
    const copy = mkdtempSync(path.join(tmpdir(), "orch-fixture-"));
    cpSync(task.projectDir!, copy, { recursive: true });
    const result = await runCommand(task.testCommand!, { cwd: copy, timeoutMs: 30_000 });
    assert.equal(result.ok, task.allowFailingBaseline !== true, `${task.id}:\n${result.output}`);
  }
  assert.deepEqual(smallEditTasks().map((task) => task.allowFailingBaseline === true), [true, true, true, false]);
});

test("runEval runs a small-edit task through the worktree", async () => {
  const log = newLog();
  const backend = fakeBackend({ id: "pc", replies: [GREET] });
  const results = await runEval({ backend, tasks: smallEditTasks().slice(0, 1), budgetTokens: 6000, log });
  assert.deepEqual(results.map((r) => [r.id, r.ok, r.reason]), [["se-01-default-parameter", true, null]]);
  const records = log.readAll();
  assert.equal(records.length, 1);
  assert.deepEqual([records[0]!.mode, records[0]!.taskType, records[0]!.taskId, records[0]!.verify], ["eval", "small-edit", "se-01-default-parameter", "pass"]);
  assert.ok(backend.prompts[0]!.includes("<<<EDIT START>>>\nexport function greet(name) {"));
  // The fixture in the project is never edited.
  assert.ok(readFileSync(path.join(FIXED_DIR, "se-01-default-parameter/project/greet.js"), "utf8").includes("greet(name) {"));
});

test("runEval scores a wrong edit as verify_failed", async () => {
  const log = newLog();
  const backend = fakeBackend({ id: "pc", replies: ["export function greet(name) {\n  return `Hello, ${name}!`; // unchanged behaviour\n}", GREET] });
  const results = await runEval({ backend, tasks: smallEditTasks().slice(0, 1), budgetTokens: 6000, log });
  assert.deepEqual(results.map((r) => [r.ok, r.reason]), [[false, "verify_failed"]]);
  assert.match(log.readAll()[0]!.verifyDetail, /^tests failed/);
  assert.equal(backend.prompts.length, 1, "no retry in eval");
});

test("runEval reports a broken small-edit fixture as a config problem", async () => {
  const task = { ...smallEditTasks()[3]!, id: "se-broken", testCommand: `node -e "process.exit(1)"` };
  const backend = fakeBackend({ id: "pc", replies: [GREET] });
  await assert.rejects(runEval({ backend, tasks: [task], budgetTokens: 6000, log: newLog() }), (err: unknown) => err instanceof ConfigError && /se-broken/.test(err.message));
  assert.equal(backend.prompts.length, 0);
});

test("runEval logs one eval record per task", async () => {
  const log = newLog();
  const backend = fakeBackend({ id: "pc", replies: [GOOD_COMMENT, GOOD_COMMENT] });
  const results = await runEval({ backend, tasks: [docTask("ds-a"), docTask("ds-b")], budgetTokens: 6000, log });

  assert.deepEqual(results.map((r) => [r.id, r.ok, r.reason]), [["ds-a", true, null], ["ds-b", true, null]]);
  const records = log.readAll();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((rec) => [rec.mode, rec.taskId, rec.repo]), [["eval", "ds-a", null], ["eval", "ds-b", null]]);
});

test("runEval does not retry", async () => {
  const log = newLog();
  const backend = fakeBackend({ id: "pc", replies: ["not a comment", GOOD_COMMENT] });
  const results = await runEval({ backend, tasks: [docTask("ds-a")], budgetTokens: 6000, log });

  assert.deepEqual(results.map((r) => [r.ok, r.reason]), [[false, "verify_failed"]]);
  assert.equal(log.readAll().length, 1);
  assert.equal(backend.prompts.length, 1);
});

test("runEval aborts on an unreachable backend before logging anything", async () => {
  const log = newLog();
  const backend = fakeBackend({ id: "pc", healthy: false, replies: [] });
  await assert.rejects(
    runEval({ backend, tasks: [docTask("ds-a")], budgetTokens: 6000, log }),
    (err: unknown) => err instanceof BackendError && err.reason === "pc_unreachable",
  );
  assert.deepEqual(log.readAll(), []);
});

test("runEval stops when the PC goes away mid-run", async () => {
  const log = newLog();
  const backend = fakeBackend({ id: "pc", replies: [GOOD_COMMENT, new BackendError("pc_unreachable", "gone")] });
  const results = await runEval({ backend, tasks: [docTask("a"), docTask("b"), docTask("c")], budgetTokens: 6000, log });
  assert.deepEqual(results.map((r) => [r.id, r.reason]), [["a", null], ["b", "pc_unreachable"]]);
});

test("runEval itself refuses a cloud backend", async () => {
  const log = newLog();
  const cloud = fakeBackend({ id: "claude", kind: "cloud", replies: [GOOD_COMMENT] });
  await assert.rejects(runEval({ backend: cloud, tasks: [docTask("ds-a")], budgetTokens: 6000, log }), /refuses cloud backends/);
  assert.deepEqual(cloud.prompts, []);
  assert.deepEqual(log.readAll(), []);
});

test("runEval stops at the first backend error, so a mistyped model does not fill the log", async () => {
  const log = newLog();
  const backend = fakeBackend({ id: "pc", replies: [new BackendError("backend_error", "model 'typo' not found"), GOOD_COMMENT] });
  const results = await runEval({ backend, tasks: [docTask("a"), docTask("b"), docTask("c")], budgetTokens: 6000, log });
  assert.deepEqual(results.map((r) => [r.id, r.reason]), [["a", "backend_error"]]);
  assert.equal(log.readAll().length, 1);
});

test("orch eval refuses a cloud backend", async () => {
  const { configPath, runsDir } = writeTempConfig(twoTierConfig("http://127.0.0.1:1"));
  const env = fakeClaudeEnv();
  const result = await runCli(["eval", "--backend", "claude", "--config", configPath], env);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /refuses cloud backends/);
  assert.doesNotMatch(result.stderr, /usage:/i);
  assert.equal(existsSync(env.FAKE_CLAUDE_TRACE!), false, "claude must not have been started");
  assert.equal(existsSync(path.join(runsDir, "log.jsonl")), false);
});

test("orch eval runs the fixed set and prints a table", async () => {
  const server = await startFakeOllama((req, _body, res) =>
    req.url === "/api/tags" ? json(res, 200, { models: [] }) : json(res, 200, { message: { content: GOOD_COMMENT } }),
  );
  try {
    const { configPath, runsDir } = writeTempConfig(ollamaOnlyConfig(server.url));
    const result = await runCli(["eval", "--backend", "pc-ollama", "--config", configPath, "--model", "falcon:7b"]);
    assert.equal(result.code, 0, result.stderr);
    // The same JSDoc answer is right for the three TypeScript docstring tasks and wrong for everything else.
    assert.match(result.stdout, /^3\/16 passed$/m);
    assert.match(result.stdout, /^se-01-default-parameter\s+verify_failed\s+\d+$/m);
    assert.match(result.stdout, /^ds-01-ts-pure-function\s+pass\s+\d+$/m);
    assert.match(result.stdout, /^ds-04-py-function\s+verify_failed\s+\d+$/m);
    const lines = readFileSync(path.join(runsDir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 16);
    assert.ok(lines.every((line) => line.mode === "eval" && line.model === "falcon:7b" && line.attempt === 0));
  } finally {
    await server.close();
  }
});

test("orch eval --type runs only that task type", async () => {
  const server = await startFakeOllama((req, _body, res) =>
    req.url === "/api/tags" ? json(res, 200, { models: [] }) : json(res, 200, { message: { content: GOOD_COMMENT } }),
  );
  try {
    const { configPath } = writeTempConfig(ollamaOnlyConfig(server.url));
    const result = await runCli(["eval", "--backend", "pc-ollama", "--type", "docstring", "--config", configPath]);
    assert.match(result.stdout, /^3\/4 passed$/m);
    const edits = await runCli(["eval", "--backend", "pc-ollama", "--type", "small-edit", "--config", configPath]);
    assert.match(edits.stdout, /^0\/4 passed$/m);
  } finally {
    await server.close();
  }
});

test("orch eval with the PC off exits 1 and logs nothing", async () => {
  const { configPath, runsDir } = writeTempConfig(ollamaOnlyConfig(await closedPortUrl()));
  const result = await runCli(["eval", "--backend", "pc-ollama", "--config", configPath]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unreachable/);
  assert.equal(existsSync(path.join(runsDir, "log.jsonl")), false);
});

test("orch eval needs a known --backend", async () => {
  const { configPath } = writeTempConfig(ollamaOnlyConfig("http://127.0.0.1:1"));
  assert.equal((await runCli(["eval", "--config", configPath])).code, 2);
  const unknown = await runCli(["eval", "--backend", "ghost", "--config", configPath]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /ghost/);
});
