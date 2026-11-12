import { test } from "node:test";
import assert from "node:assert/strict";
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
  await assert.rejects(stagedDiff(makeTempDir()), InputError);
});
