import { test } from "node:test";
import assert from "node:assert/strict";
import { docstring } from "../src/tasks/docstring.ts";
import { languageOf, taskModules } from "../src/tasks/task.ts";
import { InputError } from "../src/core/types.ts";

const TS_SOURCE = "export function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, n));\n}\n";
const PY_SOURCE = "def slugify(title):\n    return title.lower().replace(' ', '-')\n";

const tsTask = docstring.prepare({ text: TS_SOURCE, filePath: "src/a.ts", symbol: "clamp" }, 6000);
const pyTask = docstring.prepare({ text: PY_SOURCE, filePath: "a.py", symbol: "slugify" }, 6000);

test("languageOf maps extensions", () => {
  assert.equal(languageOf("a.ts"), "js");
  assert.equal(languageOf("dir/a.test.tsx"), "js");
  assert.equal(languageOf("a.mjs"), "js");
  assert.equal(languageOf("a.py"), "py");
  assert.throws(() => languageOf("a.rb"), InputError);
});

test("the prompt names the symbol, the format and holds the source", () => {
  assert.ok(tsTask.prompt.includes("`clamp`"));
  assert.ok(tsTask.prompt.includes("/**"));
  assert.ok(tsTask.prompt.includes("Math.min(hi, Math.max(lo, n))"));
  assert.ok(pyTask.prompt.includes('"""'));
  assert.equal(tsTask.taskType, "docstring");
});

test("verify passes a JSDoc comment for a TypeScript file", () => {
  assert.deepEqual(tsTask.verify!("/**\n * Clamp n to [lo, hi].\n * @param n value\n */"), { status: "pass", detail: "" });
});

test("verify passes a docstring for a Python file", () => {
  assert.deepEqual(pyTask.verify!('"""Slugify a title."""'), { status: "pass", detail: "" });
});

test("verify fails a comment followed by code", () => {
  assert.equal(tsTask.verify!("/** x */\nfunction f() {}").status, "fail");
});

test("verify fails a comment with tags only", () => {
  assert.match(tsTask.verify!("/**\n * @param n\n */").detail, /description/);
});

test("verify fails a JSDoc answer for a Python file", () => {
  assert.equal(pyTask.verify!("/**\n * Slugify a title.\n */").status, "fail");
});

test("verify fails two comments in one answer", () => {
  assert.equal(tsTask.verify!("/** one */\n/** two */").status, "fail");
});

test("normalize unwraps a fenced comment", () => {
  assert.equal(tsTask.normalize("```ts\n/**\n * Clamp.\n */\n```"), "/**\n * Clamp.\n */");
});

test("normalize drops an intro line in front of a fenced comment", () => {
  assert.equal(tsTask.normalize("Here is the JSDoc comment:\n\n```ts\n/**\n * Clamp n.\n */\n```"), "/**\n * Clamp n.\n */");
});

test("normalize keeps a one-line Python docstring intact", () => {
  const answer = '"""Slugify a title."""';
  assert.equal(pyTask.normalize(answer), answer);
  assert.equal(pyTask.verify!(pyTask.normalize(answer)).status, "pass");
});

test("prepare needs a file and a symbol", () => {
  assert.throws(() => docstring.prepare({ text: TS_SOURCE }, 6000), InputError);
});

test("the registry knows docstring and test-stub", () => {
  assert.deepEqual(Object.keys(taskModules).sort(), ["commit-message", "docstring", "small-edit", "test-stub"]);
});
