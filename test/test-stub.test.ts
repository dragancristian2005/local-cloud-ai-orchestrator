import { test } from "node:test";
import assert from "node:assert/strict";
import { testStub } from "../src/tasks/test-stub.ts";

const TS_SOURCE = "export function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, n));\n}\n";
const PY_SOURCE = "def slugify(title):\n    return title.lower().replace(' ', '-')\n";

const tsTask = testStub.prepare({ text: TS_SOURCE, filePath: "src/clamp.ts", symbol: "clamp" }, 6000);
const pyTask = testStub.prepare({ text: PY_SOURCE, filePath: "slug.py", symbol: "slugify" }, 6000);

const GOOD_TS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./clamp.ts";
test("clamps to the upper bound", () => { assert.equal(clamp(5, 0, 3), 3); });`;

const GOOD_PY = `from slug import slugify

def test_replaces_spaces():
    assert slugify("a b") == "a-b"`;

test("the prompt names the symbol, the framework and the file to import from", () => {
  assert.ok(tsTask.prompt.includes("`clamp`"));
  assert.ok(tsTask.prompt.includes("node:test"));
  assert.ok(tsTask.prompt.includes("./clamp.ts"));
  assert.ok(pyTask.prompt.includes("pytest"));
  assert.equal(tsTask.taskType, "test-stub");
});

test("verify passes a node:test file that imports and calls the symbol", () => {
  assert.deepEqual(tsTask.verify!(GOOD_TS), { status: "pass", detail: "" });
});

test("verify passes a pytest file", () => {
  assert.deepEqual(pyTask.verify!(GOOD_PY), { status: "pass", detail: "" });
});

test("verify fails a file with no test call", () => {
  assert.match(tsTask.verify!('import { clamp } from "./clamp.ts";\nconsole.log(clamp(1, 0, 3));').detail, /test/);
});

test("verify fails a file that never mentions the symbol", () => {
  const output = GOOD_TS.replaceAll("clamp", "clip");
  assert.match(tsTask.verify!(output).detail, /clamp/);
});

test("verify fails a file that looks cut off", () => {
  const cut = GOOD_TS.slice(0, GOOD_TS.lastIndexOf("})"));
  assert.match(tsTask.verify!(cut).detail, /unbalanced/);
});

test("verify fails a pytest file without a test function", () => {
  assert.equal(pyTask.verify!("from slug import slugify\nprint(slugify('a b'))").status, "fail");
});

test("normalize unwraps the code fence models put around code", () => {
  assert.equal(tsTask.normalize("```typescript\n" + GOOD_TS + "\n```"), GOOD_TS);
});

test("normalize drops a closing remark after the fenced file", () => {
  assert.equal(tsTask.normalize("```ts\n" + GOOD_TS + "\n```\n\nThese tests cover the typical cases."), GOOD_TS);
});
