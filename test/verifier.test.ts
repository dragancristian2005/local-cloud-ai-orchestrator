import { test } from "node:test";
import assert from "node:assert/strict";
import { maxLines, noCodeFence, nonEmpty, runChecks } from "../src/core/verifier.ts";

test("runChecks passes with an empty detail when every check is ok", () => {
  assert.deepEqual(runChecks("hello", [nonEmpty, noCodeFence, maxLines(3)]), { status: "pass", detail: "" });
});

test("runChecks reports the first failing check", () => {
  const first = () => "first problem";
  const second = () => "second problem";
  assert.deepEqual(runChecks("x", [nonEmpty, first, second]), { status: "fail", detail: "first problem" });
});

test("nonEmpty rejects whitespace", () => {
  assert.equal(runChecks("  \n ", [nonEmpty]).status, "fail");
});

test("noCodeFence rejects a fenced block", () => {
  assert.equal(runChecks("text\n```js\ncode\n```", [noCodeFence]).status, "fail");
});

test("maxLines counts lines", () => {
  assert.equal(runChecks("a\nb\nc", [maxLines(3)]).status, "pass");
  assert.match(runChecks("a\nb\nc\nd", [maxLines(3)]).detail, /4 lines \(max 3\)/);
});

test("the verifier module offers the shell-command verifier", async () => {
  const { runCommand } = await import("../src/core/verifier.ts");
  const result = await runCommand(`node -e "console.error('bad'); process.exit(3)"`, { cwd: process.cwd(), timeoutMs: 10_000 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /bad/);
});

test("failureTail keeps the end", async () => {
  const { failureTail } = await import("../src/core/verifier.ts");
  const hundred = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.equal(failureTail(hundred), Array.from({ length: 30 }, (_, i) => `line ${i + 71}`).join("\n"));
  const long = "x".repeat(4999) + "y";
  assert.equal(failureTail(long).length, 1500);
  assert.ok(failureTail(long).endsWith("y"));
  assert.equal(failureTail("a\nb\nc\n", 2), "b\nc");
});
