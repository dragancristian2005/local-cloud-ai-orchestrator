import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { stagedDiff } from "../src/workspace/git.ts";
import { InputError } from "../src/core/types.ts";
import { makeTempDir, makeTempRepo } from "./helpers/temp-repo.ts";

test("stagedDiff returns the staged change", async () => {
  const repo = await makeTempRepo({ "a.txt": "hello\n" }, { stage: true });
  const { stat, diff } = await stagedDiff(repo);
  assert.match(diff, /^\+hello$/m);
  assert.match(stat, /a\.txt/);
});

test("stagedDiff is empty when nothing is staged", async () => {
  const repo = await makeTempRepo({ "a.txt": "hello\n" });
  assert.deepEqual(await stagedDiff(repo), { stat: "", diff: "" });
});

test("stagedDiff works with a space in the repo path", async () => {
  const repo = await makeTempRepo({ "a.txt": "hello\n" }, { stage: true, dirName: "my repo" });
  assert.match((await stagedDiff(repo)).diff, /^\+hello$/m);
});

test("stagedDiff rejects a directory that is not a repository", async () => {
  await assert.rejects(
    stagedDiff(makeTempDir()),
    (err: unknown) => err instanceof InputError && /not a git repository/.test(err.message),
  );
});

test("repoRoot returns the top-level directory from a subdirectory", async () => {
  const { repoRoot } = await import("../src/workspace/git.ts");
  const { realpathSync } = await import("node:fs");
  const repo = await makeTempRepo({ "src/deep/a.js": "1\n" });
  assert.equal(await repoRoot(path.join(repo, "src/deep")), realpathSync(repo));
  await assert.rejects(repoRoot(makeTempDir()), (err: unknown) => err instanceof InputError && /not a git repository/.test(err.message));
});

test("assertEditable accepts a committed file and names a file that is not", async () => {
  const { assertEditable } = await import("../src/workspace/git.ts");
  const { commitAll } = await import("./helpers/temp-repo.ts");
  const { execFileSync } = await import("node:child_process");
  const repo = await makeTempRepo({ "a.js": "1\n", "b.js": "1\n", "c.js": "1\n" });
  await commitAll(repo);
  writeFileSync(path.join(repo, "new.js"), "1\n");
  writeFileSync(path.join(repo, "b.js"), "2\n");
  writeFileSync(path.join(repo, "c.js"), "2\n");
  execFileSync("git", ["-C", repo, "add", "c.js"]);
  await assertEditable(repo, "a.js");
  await assert.rejects(assertEditable(repo, "new.js"), (err: unknown) => err instanceof InputError && /new\.js is not tracked/.test(err.message));
  await assert.rejects(assertEditable(repo, "b.js"), (err: unknown) => err instanceof InputError && /b\.js has uncommitted changes/.test(err.message));
  await assert.rejects(assertEditable(repo, "c.js"), (err: unknown) => err instanceof InputError && /c\.js has uncommitted changes/.test(err.message));
});
