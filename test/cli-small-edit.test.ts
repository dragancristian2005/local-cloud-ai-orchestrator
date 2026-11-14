import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { editRepo, GIT_IDENTITY, GOOD } from "./helpers/edit-fixture.ts";
import { chatReplies, startFakeOllama } from "./helpers/fake-ollama.ts";
import { ollamaOnlyConfig, runCli, writeTempConfig } from "./helpers/run-cli.ts";
import { gitOut } from "./helpers/temp-repo.ts";

const CLI = path.resolve(import.meta.dirname, "../src/cli.ts");
const EDIT = ["run", "--type", "small-edit", "--file", "math.js", "--symbol", "clamp", "--instruction", "use Math.min and Math.max"];

async function withServer<T>(fn: (cfg: { configPath: string; runsDir: string; url: string }) => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
  const server = await startFakeOllama(chatReplies(GOOD));
  try {
    return await fn({ ...writeTempConfig({ ...ollamaOnlyConfig(server.url, ["small-edit", "docstring"]), ...extra }), url: server.url });
  } finally {
    await server.close();
  }
}
const untouched = async (repo: string) =>
  assert.deepEqual([await gitOut(repo, "status", "--porcelain"), (await gitOut(repo, "worktree", "list")).split("\n").length], ["", 1]);

test("prints only the patch on stdout", async () => {
  const repo = await editRepo();
  await withServer(async ({ configPath, runsDir }) => {
    const result = await runCli([...EDIT, "--repo", repo, "--config", configPath, "--test", "node check.mjs"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^diff --git a\/math\.js b\/math\.js\n/);
    const saved = /patch saved to (.*change\.patch)\n/.exec(result.stderr)?.[1];
    assert.ok(saved, result.stderr);
    assert.equal(result.stdout, readFileSync(saved, "utf8"), "stdout is the patch and nothing else");
    assert.match(result.stderr, /apply it with: git apply .*change\.patch\n/);
    const lines = readFileSync(path.join(runsDir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0]!.taskType, lines[0]!.verify, lines[0]!.repo], ["small-edit", "pass", realpathSync(repo)]);
    await untouched(repo);
  });
});

test("the patch on stdout applies with git apply", async () => {
  const repo = await editRepo();
  await withServer(async ({ configPath }) => {
    const result = await runCli([...EDIT, "--repo", repo, "--config", configPath, "--test", "node check.mjs"]);
    execFileSync("git", ["-C", repo, "apply"], { input: result.stdout });
    assert.ok(readFileSync(path.join(repo, "math.js"), "utf8").includes("return Math.min(hi, Math.max(lo, n));"));
    execFileSync("node", ["check.mjs"], { cwd: repo });
  });
});

test("--commit prints the branch name on stderr", async () => {
  const repo = await editRepo();
  await withServer(async ({ configPath }) => {
    const result = await runCli([...EDIT, "--repo", repo, "--config", configPath, "--test", "node check.mjs", "--commit"], GIT_IDENTITY);
    assert.equal(result.code, 0, result.stderr);
    const branch = /committed on branch (orch\/small-edit-\S+); your working tree was not changed/.exec(result.stderr)?.[1];
    assert.ok(branch, result.stderr);
    assert.equal(await gitOut(repo, "show", "--name-only", "--format=", branch), "math.js");
    await untouched(repo);
  });
});

test("no test command is a usage error that names both ways to set one", async () => {
  const repo = await editRepo();
  await withServer(async ({ configPath }) => {
    const result = await runCli([...EDIT, "--repo", repo, "--config", configPath]);
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes("--test") && result.stderr.includes('"repos"'), result.stderr);
    assert.equal(result.stdout, "");
    await untouched(repo);
  });
});

test("config repos supplies the test command and linkPaths", async () => {
  const repo = await editRepo({
    extra: {
      ".gitignore": "node_modules/\n",
      // The check only passes when the dependency is reachable from the worktree.
      "check.mjs": `import ok from "./node_modules/dep/index.js";\nimport { clamp } from "./math.js";\nprocess.exit(ok === 7 && clamp(5, 0, 3) === 3 ? 0 : 1);\n`,
    },
  });
  mkdirSync(path.join(repo, "node_modules/dep"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules/dep/index.js"), "export default 7;\n");
  const repos = { [realpathSync(repo)]: { testCommand: "node check.mjs", linkPaths: ["node_modules"] } };
  await withServer(async ({ configPath }) => {
    const result = await runCli([...EDIT, "--repo", repo, "--config", configPath]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^diff --git/);
    await untouched(repo);
  }, { repos });
});

test("small-edit flags with another task type are a usage error", async () => {
  const repo = await editRepo();
  await withServer(async ({ configPath }) => {
    const base = ["run", "--type", "docstring", "--file", "math.js", "--symbol", "clamp", "--repo", repo, "--config", configPath];
    for (const flags of [["--instruction", "x"], ["--lines", "1-2"], ["--test", "true"], ["--link", "node_modules"], ["--allow-failing-baseline"], ["--commit"]]) {
      const result = await runCli([...base, ...flags]);
      assert.equal(result.code, 2, flags.join(" "));
      assert.match(result.stderr, new RegExp(`${flags[0]} is only for --type small-edit`));
    }
  });
});

test("every tier failing exits 1 with nothing on stdout", async () => {
  const repo = await editRepo();
  await withServer(async ({ configPath }) => {
    const result = await runCli([...EDIT, "--repo", repo, "--config", configPath, "--test", "node -e \"process.exit(1)\"", "--allow-failing-baseline"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /every tier failed/);
    await untouched(repo);
  });
});

test("SIGINT mid-run exits 130 and leaves the repository as it was", async () => {
  const repo = await editRepo();
  await withServer(async ({ configPath }) => {
    const args = [...EDIT, "--repo", repo, "--config", configPath, "--test", `node -e "setInterval(() => {}, 1000)"`, "--allow-failing-baseline"];
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let sent = false;
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (!sent && stderr.includes("\n")) {
        sent = true;
        // Give the test command a moment to start.
        setTimeout(() => child.kill("SIGINT"), 300);
      }
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", (exit) => resolve(exit)));
    assert.equal(code, 130, stderr);
    await untouched(repo);
  });
});
