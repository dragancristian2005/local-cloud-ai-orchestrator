import { test } from "node:test";
import assert from "node:assert/strict";
import { collectInput, estimateTokens, fitDiff, fitSource } from "../src/core/context.ts";
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

test("fitSource returns a small file whole", () => {
  const source = "export function clamp(n: number) {\n  return n;\n}\n";
  assert.equal(fitSource(source, "clamp", 1000), source);
});

test("fitSource keeps a window around the symbol in a large file", () => {
  const lines: string[] = [];
  for (let i = 0; i < 5000; i++) lines.push(`const filler${i} = ${i}; // padding line number ${i}`);
  lines[2500] = "export function target(n: number): number {";
  const fitted = fitSource(lines.join("\n"), "target", 1000);
  assert.ok(estimateTokens(fitted) <= 1000, `got ${estimateTokens(fitted)} tokens`);
  assert.ok(fitted.includes("export function target(n: number): number {"));
  assert.ok(fitted.includes("filler2499 "), "some lines before the declaration");
  assert.ok(fitted.includes("filler2520 "), "more lines after the declaration");
  assert.match(fitted, /lines omitted/);
});

test("fitSource finds a class method", () => {
  const source = "class Cache {\n  get(key: string) {\n    return this.map.get(key);\n  }\n}\n";
  assert.equal(fitSource(source, "get", 1000), source);
});

test("fitSource rejects a missing symbol, even in a small file", () => {
  assert.throws(() => fitSource("const a = 1;\n", "clamp", 1000), InputError);
});

test("collectInput reads the file for a docstring task", async () => {
  const repo = await makeTempRepo({ "src/a.ts": "export function clamp(n: number) {\n  return n;\n}\n" });
  const input = await collectInput("docstring", { repo, file: "src/a.ts", symbol: "clamp" });
  assert.match(input.text, /export function clamp/);
  assert.equal(input.filePath, "src/a.ts");
  assert.equal(input.symbol, "clamp");
});

test("collectInput needs --file and --symbol for a test-stub task", async () => {
  const repo = await makeTempRepo({ "src/a.ts": "export const a = 1;\n" });
  await assert.rejects(collectInput("test-stub", { repo, file: "src/a.ts" }), /--file and --symbol/);
});

test("collectInput rejects a missing file, a missing symbol and an unsupported file type", async () => {
  const repo = await makeTempRepo({ "src/a.ts": "export const a = 1;\n", "a.rb": "def clamp; end\n" });
  await assert.rejects(collectInput("docstring", { repo, file: "src/nope.ts", symbol: "a" }), InputError);
  await assert.rejects(
    collectInput("docstring", { repo, file: "src/a.ts", symbol: "clamp" }),
    (err: unknown) => err instanceof InputError && /symbol clamp not found in src\/a\.ts/.test(err.message),
  );
  await assert.rejects(collectInput("docstring", { repo, file: "a.rb", symbol: "clamp" }), /unsupported file type/);
});
