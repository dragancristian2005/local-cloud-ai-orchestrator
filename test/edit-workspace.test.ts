import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, InputError } from "../src/core/types.ts";
import { createEditWorkspace } from "../src/workspace/edit-workspace.ts";
import { commitAll, gitOut, makeTempRepo } from "./helpers/temp-repo.ts";

// ws.commit uses the user's git identity; the tests bring their own.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "orch-test", GIT_AUTHOR_EMAIL: "orch-test@localhost",
  GIT_COMMITTER_NAME: "orch-test", GIT_COMMITTER_EMAIL: "orch-test@localhost",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
});

const CHECK = `import value from "./value.js";\nprocess.exit(value === 2 ? 0 : 1);\n`;
let counter = 0;

async function fixture(extra: Record<string, string> = {}, linkPaths: string[] = []) {
  const repo = await makeTempRepo({ "value.js": "export default 1;\n", "check.mjs": CHECK, ".gitignore": "node_modules/\n", ...extra });
  await commitAll(repo);
  const id = `t${process.pid}-${++counter}`;
  const ws = await createEditWorkspace({ repoRoot: repo, id, testCommand: "node check.mjs", testTimeoutMs: 20_000, linkPaths });
  return { repo, id, ws };
}
const worktrees = async (repo: string) => (await gitOut(repo, "worktree", "list")).split("\n").length;

test("creates a worktree and leaves the repository alone", async () => {
  const { repo, id, ws } = await fixture();
  assert.equal(ws.dir, path.join(tmpdir(), `orch-edit-${id}`));
  assert.equal(ws.read("value.js"), "export default 1;\n");
  assert.equal(await gitOut(repo, "status", "--porcelain"), "");
  assert.equal(await worktrees(repo), 2);
  await ws.dispose();
});

test("write then test", async () => {
  const { repo, ws } = await fixture();
  assert.equal((await ws.test()).ok, false);
  ws.write("value.js", "export default 2;\n");
  assert.equal((await ws.test()).ok, true);
  assert.equal(readFileSync(path.join(repo, "value.js"), "utf8"), "export default 1;\n");
  await ws.dispose();
});

test("diff shows the change", async () => {
  const { ws } = await fixture();
  ws.write("value.js", "export default 2;\n");
  const diff = await ws.diff("value.js");
  assert.match(diff, /^diff --git a\/value\.js b\/value\.js/);
  assert.ok(diff.includes("-export default 1;") && diff.includes("+export default 2;"));
  await ws.dispose();
});

test("links dependencies", async () => {
  const { ws } = await fixture({ "node_modules/dep/index.js": "export default 7;\n" }, ["node_modules", "not-there"]);
  assert.equal(ws.read("node_modules/dep/index.js"), "export default 7;\n");
  assert.equal(existsSync(path.join(ws.dir, "not-there")), false);
  assert.deepEqual(await ws.dispose(), { removed: true });
});

test("dispose removes the worktree and can be called again", async () => {
  const { repo, ws } = await fixture();
  const head = await gitOut(repo, "rev-parse", "HEAD");
  const branches = await gitOut(repo, "branch", "--list");
  ws.write("value.js", "export default 2;\n");
  assert.deepEqual(await ws.dispose(), { removed: true });
  assert.equal(existsSync(ws.dir), false);
  assert.equal(await worktrees(repo), 1);
  assert.equal(await gitOut(repo, "rev-parse", "HEAD"), head);
  assert.equal(await gitOut(repo, "branch", "--list"), branches);
  assert.equal(await gitOut(repo, "status", "--porcelain"), "");
  assert.deepEqual(await ws.dispose(), { removed: true });
});

test("commit creates a branch with one commit touching one file", async () => {
  const { repo, ws } = await fixture({ "node_modules/dep/index.js": "export default 7;\n" }, ["node_modules"]);
  const original = await gitOut(repo, "symbolic-ref", "--short", "HEAD");
  const head = await gitOut(repo, "rev-parse", "HEAD");
  ws.write("value.js", "export default 2;\n");
  await ws.commit("value.js", "orch/small-edit-t1", "orch: set value");
  assert.deepEqual(await ws.dispose(), { removed: true });

  assert.equal(await gitOut(repo, "rev-parse", "orch/small-edit-t1~1"), head);
  assert.equal(await gitOut(repo, "show", "--stat", "--format=%s", "orch/small-edit-t1"), "orch: set value\n\n value.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)");
  assert.equal(await gitOut(repo, "symbolic-ref", "--short", "HEAD"), original);
  assert.equal(await gitOut(repo, "rev-parse", "HEAD"), head);
  assert.equal(await gitOut(repo, "status", "--porcelain"), "");
  assert.equal(readFileSync(path.join(repo, "value.js"), "utf8"), "export default 1;\n");
});

test("a failed commit is reported, not thrown raw", async () => {
  const { ws } = await fixture();
  await assert.rejects(ws.commit("value.js", "orch/small-edit-t2", "nothing changed"), (err: unknown) => err instanceof InputError && /^git commit failed: /.test(err.message));
  await ws.dispose();
});

test("dispose does not force", async () => {
  const { repo, ws } = await fixture();
  writeFileSync(path.join(ws.dir, "left-by-the-tests.txt"), "x");
  assert.deepEqual(await ws.dispose(), { removed: false, leftAt: ws.dir });
  assert.equal(existsSync(path.join(ws.dir, "left-by-the-tests.txt")), true);
  assert.equal(await gitOut(repo, "status", "--porcelain"), "");
});

test("write refuses to leave the worktree", async () => {
  const { repo, ws } = await fixture({ "node_modules/dep/index.js": "export default 7;\n" }, ["node_modules"]);
  const outside = path.join(tmpdir(), `orch-escape-${process.pid}.txt`);
  assert.throws(() => ws.write("../escape.txt", "x"), InputError);
  assert.throws(() => ws.write(outside, "x"), InputError);
  assert.throws(() => ws.read("../escape.txt"), InputError);
  // A linked directory points into the user's checkout: writing through it would change their files.
  assert.throws(() => ws.write("node_modules/dep/index.js", "x"), InputError);
  assert.equal(existsSync(path.join(path.dirname(ws.dir), "escape.txt")), false);
  assert.equal(existsSync(outside), false);
  assert.equal(readFileSync(path.join(repo, "node_modules/dep/index.js"), "utf8"), "export default 7;\n");
  await ws.dispose();
});

test("rejects a linkPath that leaves the repository", async () => {
  const repo = await makeTempRepo({ "value.js": "export default 1;\n" });
  await commitAll(repo);
  for (const bad of ["../x", "/etc", "a/../../x"]) {
    await assert.rejects(createEditWorkspace({ repoRoot: repo, id: `bad${++counter}`, testCommand: "true", testTimeoutMs: 1000, linkPaths: [bad] }), ConfigError);
  }
  assert.equal(await worktrees(repo), 1);
});

test("the diff applies whatever the user's diff settings are", async () => {
  const repo = await makeTempRepo({ "value.js": "export default 1;\n", "check.mjs": CHECK });
  await commitAll(repo);
  await gitOut(repo, "config", "diff.noprefix", "true");
  const ws = await createEditWorkspace({ repoRoot: repo, id: `t${process.pid}-${++counter}`, testCommand: "node check.mjs", testTimeoutMs: 20_000, linkPaths: [] });
  ws.write("value.js", "export default 2;\n");
  assert.match(await ws.diff("value.js"), /^diff --git a\/value\.js b\/value\.js\n/);
  await ws.dispose();
});

test("write refuses a tracked symlink, which could point anywhere", async () => {
  const target = path.join(tmpdir(), `orch-link-target-${process.pid}.txt`);
  writeFileSync(target, "outside\n");
  const repo = await makeTempRepo({ "value.js": "export default 1;\n" });
  symlinkSync(target, path.join(repo, "link.js"));
  await commitAll(repo);
  const ws = await createEditWorkspace({ repoRoot: repo, id: `t${process.pid}-${++counter}`, testCommand: "true", testTimeoutMs: 1000, linkPaths: [] });
  assert.throws(() => ws.write("link.js", "x"), InputError);
  assert.equal(readFileSync(target, "utf8"), "outside\n");
  await ws.dispose();
});
