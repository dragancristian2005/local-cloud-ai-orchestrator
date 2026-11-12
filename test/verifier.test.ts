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
