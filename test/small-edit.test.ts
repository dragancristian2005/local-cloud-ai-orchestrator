import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../src/core/context.ts";
import { InputError } from "../src/core/types.ts";
import { EDIT_END, EDIT_START, smallEdit } from "../src/tasks/small-edit.ts";
import { taskModules } from "../src/tasks/task.ts";

const SOURCE = [
  "// math helpers", //                 0
  "class Maths {", //                   1
  "    clamp(n, lo, hi) {", //          2
  "        return n < lo ? lo : n;", // 3
  "    }", //                           4
  "    other() {}", //                  5
  "}", //                               6
  "",
].join("\n");
const REGION = { start: 2, end: 4 };
const input = { text: SOURCE, filePath: "src/maths.js", symbol: "clamp", instruction: "also cap the value at hi", region: REGION };
const GOOD = "    clamp(n, lo, hi) {\n        return Math.min(hi, Math.max(lo, n));\n    }";

test("small-edit is a registered task type", () => {
  assert.equal(taskModules["small-edit"], smallEdit);
  assert.equal(smallEdit.type, "small-edit");
});

test("the prompt holds the instruction, the file, the marked region and context around it", () => {
  const { prompt, taskType } = smallEdit.prepare(input, 6000);
  assert.equal(taskType, "small-edit");
  assert.ok(prompt.includes("Change the code between the markers so that: also cap the value at hi"));
  assert.ok(prompt.includes("File: src/maths.js"));
  assert.ok(prompt.includes(`class Maths {\n${EDIT_START}\n    clamp(n, lo, hi) {\n        return n < lo ? lo : n;\n    }\n${EDIT_END}\n    other() {}`));
  assert.ok(prompt.includes("// math helpers"));
});

test("prepare needs a file, an instruction and a region", () => {
  assert.throws(() => smallEdit.prepare({ ...input, instruction: undefined }, 6000), InputError);
  assert.throws(() => smallEdit.prepare({ ...input, instruction: "  " }, 6000), InputError);
  assert.throws(() => smallEdit.prepare({ ...input, region: undefined }, 6000), InputError);
  assert.throws(() => smallEdit.prepare({ ...input, filePath: undefined }, 6000), InputError);
});

test("prepare refuses a region larger than half the budget", () => {
  const big = Array.from({ length: 400 }, (_, i) => `  const value${i} = compute(${i});`).join("\n");
  assert.throws(
    () => smallEdit.prepare({ ...input, text: big, region: { start: 0, end: 399 } }, 1000),
    (err: unknown) => err instanceof InputError && /small-edit takes at most 500: choose a smaller range with --lines/.test(err.message),
  );
});

test("the prompt stays inside the budget for a huge file", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `const line${i} = "${"x".repeat(40)}";`);
  const { prompt } = smallEdit.prepare({ ...input, text: lines.join("\n"), region: { start: 2500, end: 2509 } }, 2000);
  assert.ok(estimateTokens(prompt) <= 2000, `${estimateTokens(prompt)} tokens`);
  assert.ok(prompt.includes("const line2500 ") && prompt.includes("const line2509 "));
  assert.ok(prompt.includes("const line2499 ") && prompt.includes("const line2510 "), "context on both sides");
  assert.ok(!prompt.includes("const line0 ") && !prompt.includes("const line4999 "));
});

test("normalize unwraps a fence, drops echoed markers and restores the indentation", () => {
  const task = smallEdit.prepare(input, 6000);
  const bare = "clamp(n, lo, hi) {\n    return Math.min(hi, Math.max(lo, n));\n}";
  assert.equal(task.normalize("```js\n" + bare + "\n```"), GOOD);
  assert.equal(task.normalize(`${EDIT_START}\n${bare}\n${EDIT_END}\n`), GOOD);
  // An answer that kept the original indentation is not indented twice.
  assert.equal(task.normalize(GOOD + "\n"), GOOD);
  assert.equal(task.normalize("```\n" + GOOD + "\n```"), GOOD);
});

test("verify passes a changed function", () => {
  assert.deepEqual(smallEdit.prepare(input, 6000).verify(GOOD), { status: "pass", detail: "" });
});

test("verify fails an unchanged answer", () => {
  const task = smallEdit.prepare(input, 6000);
  const verdict = task.verify(task.normalize("clamp(n, lo, hi) {\n    return n < lo ? lo : n;\n}"));
  assert.deepEqual(verdict, { status: "fail", detail: "the answer is identical to the original code" });
});

test("verify fails an answer far longer than the original", () => {
  const long = ["    clamp(n, lo, hi) {", ...Array.from({ length: 198 }, (_, i) => `        step${i}();`), "    }"].join("\n");
  const verdict = smallEdit.prepare(input, 6000).verify(long);
  assert.deepEqual(verdict, { status: "fail", detail: "answer is 200 lines for a 3-line original: change only what the instruction asks" });
  const fits = ["    clamp(n, lo, hi) {", ...Array.from({ length: 41 }, (_, i) => `        step${i}();`), "    }"].join("\n");
  assert.equal(smallEdit.prepare(input, 6000).verify(fits).status, "pass", "43 lines is the limit for a 3-line original");
});

test("verify fails an answer that lost the symbol", () => {
  const task = smallEdit.prepare(input, 6000);
  assert.deepEqual(task.verify("    clampAll(n) {\n        return n;\n    }"), { status: "fail", detail: "the answer no longer contains clamp" });
  // Without --symbol (a --lines edit) there is nothing to look for.
  assert.equal(smallEdit.prepare({ ...input, symbol: undefined }, 6000).verify("    renamed() {}").status, "pass");
});
