import { test } from "node:test";
import assert from "node:assert/strict";
import { collectInput, estimateTokens, fitDiff } from "../src/core/context.ts";
import { InputError } from "../src/core/types.ts";
import { commitMessage } from "../src/tasks/commit-message.ts";
import { makeTempDir, makeTempRepo } from "./helpers/temp-repo.ts";

function fileDiff(name: string, addedLines: number): string {
  const lines = [
    `diff --git a/${name} b/${name}`,
    "index 0000000..1111111 100644",
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -0,0 +1,${addedLines} @@`,
  ];
  for (let i = 0; i < addedLines; i++) lines.push(`+line ${i} of ${name}`);
  return lines.join("\n") + "\n";
}

test("estimateTokens is a quarter of the length, rounded up", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("abcdefghi"), 3);
  assert.equal(estimateTokens(""), 0);
});

test("fitDiff leaves a small diff alone", () => {
  const diff = fileDiff("a.ts", 3);
  assert.equal(fitDiff(diff, 1000), diff);
});

test("fitDiff keeps every file and stays in budget", () => {
  const diff = fileDiff("small.ts", 5) + fileDiff("package-lock.json", 20000) + fileDiff("other.ts", 8);
  const fitted = fitDiff(diff, 1000);
  assert.ok(estimateTokens(fitted) <= 1000, `got ${estimateTokens(fitted)} tokens`);
  assert.ok(fitted.includes("diff --git a/small.ts b/small.ts"));
  assert.ok(fitted.includes("diff --git a/package-lock.json b/package-lock.json"));
  assert.ok(fitted.includes("diff --git a/other.ts b/other.ts"));
  assert.match(fitted, /more lines truncated/);
});

test("fitDiff keeps small files whole next to a huge one", () => {
  const small = fileDiff("small.ts", 5);
  const fitted = fitDiff(small + fileDiff("package-lock.json", 20000), 1000);
  assert.ok(fitted.includes(small));
});

test("fitDiff cuts at line boundaries", () => {
  const fitted = fitDiff(fileDiff("a.ts", 5000) + fileDiff("b.ts", 5000), 500);
  for (const line of fitted.split("\n")) {
    assert.ok(
      line === "" || /^(diff --git|index |--- |\+\+\+ |@@ |\+line \d+ of [ab]\.ts$|\[\.\.\. \d+ more lines truncated \.\.\.\]$)/.test(line),
      `unexpected partial line: ${line}`,
    );
  }
});

test("collectInput returns the staged diff and stat", async () => {
  const repo = await makeTempRepo({ "a.txt": "hello\n" }, { stage: true });
  const input = await collectInput("commit-message", { repo });
  assert.match(input.text, /^\+hello$/m);
  assert.match(input.stat ?? "", /a\.txt/);
});

test("collectInput rejects an empty stage", async () => {
  const repo = await makeTempRepo({ "a.txt": "hello\n" });
  await assert.rejects(
    collectInput("commit-message", { repo }),
    (err: unknown) => err instanceof InputError && /nothing staged/.test(err.message),
  );
});

test("collectInput rejects a directory that is not a repository", async () => {
  await assert.rejects(collectInput("commit-message", { repo: makeTempDir() }), InputError);
});

test("collectInput rejects an unknown task type", async () => {
  const repo = await makeTempRepo({ "a.txt": "hello\n" }, { stage: true });
  await assert.rejects(collectInput("poem", { repo }), InputError);
});

test("commit-message prepare trims a large diff", () => {
  const diff = fileDiff("big.json", 9000);
  assert.ok(diff.length > 200_000);
  const task = commitMessage.prepare({ text: diff, stat: " big.json | 9000 +" }, 6000);
  assert.ok(estimateTokens(task.prompt) <= 6000, `got ${estimateTokens(task.prompt)} tokens`);
  assert.ok(task.prompt.includes("diff --git a/big.json b/big.json"));
});
