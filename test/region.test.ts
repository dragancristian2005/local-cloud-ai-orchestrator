import { test } from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../src/core/types.ts";
import { findRegion, parseLineRange, regionText, reindent, spliceRegion } from "../src/tasks/region.ts";

const JS = [
  "// helpers", //                       0
  "", //                                 1
  "export function clamp(n, lo, hi) {", // 2
  "  if (n < lo) {", //                  3
  "    return lo;", //                   4
  "  }", //                              5
  "  return n > hi ? hi : n;", //        6
  "}", //                                7
  "", //                                 8
  "export function other() {", //        9
  "  return 1;", //                      10
  "}", //                                11
  "",
].join("\n");

test("parseLineRange reads a 1-based inclusive range", () => {
  assert.deepEqual(parseLineRange("2-4", 10), { start: 1, end: 3 });
  assert.deepEqual(parseLineRange("10-10", 10), { start: 9, end: 9 });
  for (const bad of ["4-2", "0-3", "2-11", "abc", "3", "1-2-3", "-1-2", ""]) assert.throws(() => parseLineRange(bad, 10), InputError, bad);
});

test("findRegion finds a function block", () => {
  assert.deepEqual(findRegion(JS, "js", "clamp"), { start: 2, end: 7 });
  assert.equal(regionText(JS, { start: 9, end: 11 }), "export function other() {\n  return 1;\n}");
});

test("findRegion ignores braces in strings and comments", () => {
  const source = ["function tricky(a) {", '  const s = "}{";', "  const t = `${a}}`;", "  const u = '}';", "  // }", "  /* } */", "  return s + t + u;", "}", "function next() {}", ""].join("\n");
  assert.deepEqual(findRegion(source, "js", "tricky"), { start: 0, end: 7 });
});

test("findRegion finds a one-line arrow function", () => {
  const source = "const a = 1;\nexport const double = (n) => n * 2;\nconst b = 2;\n";
  assert.deepEqual(findRegion(source, "js", "double"), { start: 1, end: 1 });
});

test("findRegion does not stop at braces inside a parameter list", () => {
  const source = "function withDefault(opts = {}) {\n  return opts;\n}\nconst z = 1;\n";
  assert.deepEqual(findRegion(source, "js", "withDefault"), { start: 0, end: 2 });
});

test("findRegion finds a class method", () => {
  const source = ["class Cache {", "  constructor() {", "    this.map = new Map();", "  }", "  get(key) {", "    return this.map.get(key);", "  }", "}", ""].join("\n");
  assert.deepEqual(findRegion(source, "js", "get"), { start: 4, end: 6 });
});

test("findRegion finds a Python function", () => {
  const source = ["import os", "", "def first(x):", "    if x:", "        return 1", "", "    return 2", "", "", "def second():", "    return 3", ""].join("\n");
  assert.deepEqual(findRegion(source, "py", "first"), { start: 2, end: 6 });
  assert.deepEqual(findRegion(source, "py", "second"), { start: 9, end: 10 });
});

test("findRegion rejects a missing symbol", () => {
  assert.throws(() => findRegion(JS, "js", "nothere"), (err: unknown) => err instanceof InputError && /nothere/.test(err.message));
});

test("findRegion rejects an unterminated block and points to --lines", () => {
  const isHelpful = (err: unknown) => err instanceof InputError && /could not find the end of broken: pass --lines <start>-<end>/.test(err.message);
  assert.throws(() => findRegion("function broken() {\n  return 1;\n", "js", "broken"), isHelpful);
  assert.throws(() => findRegion("def broken():\n\nx = 1\n", "py", "broken"), isHelpful);
});

test("reindent restores the original indentation", () => {
  const replacement = "get(key) {\n  if (!key) {\n    return null;\n  }\n\n  return 1;\n}";
  assert.equal(reindent(replacement, "    get(key) {\n      return 1;\n    }"), "    get(key) {\n      if (!key) {\n        return null;\n      }\n\n      return 1;\n    }");
  assert.equal(reindent(replacement, "\tget(key) {\n\t\treturn 1;\n\t}"), "\tget(key) {\n\t  if (!key) {\n\t    return null;\n\t  }\n\n\t  return 1;\n\t}");
  // An answer that kept its indentation is not indented twice.
  assert.equal(reindent("    a();\n      b();", "    x();"), "    a();\n      b();");
});

test("spliceRegion replaces only the region", () => {
  const result = spliceRegion(JS, { start: 2, end: 7 }, "export function clamp(n) {\n  return n;\n}");
  assert.equal(result, ["// helpers", "", "export function clamp(n) {", "  return n;", "}", "", "export function other() {", "  return 1;", "}", ""].join("\n"));
});

test("spliceRegion keeps CRLF", () => {
  const source = "a();\r\nb();\r\nc();\r\n";
  const result = spliceRegion(source, { start: 1, end: 1 }, "x();\ny();\n");
  assert.equal(result, "a();\r\nx();\r\ny();\r\nc();\r\n");
  assert.equal(/[^\r]\n/.test(result), false);
  assert.equal(regionText(source, { start: 0, end: 1 }), "a();\nb();");
});

test("spliceRegion keeps a missing final newline", () => {
  assert.equal(spliceRegion("a();\nb();", { start: 1, end: 1 }, "x();\n"), "a();\nx();");
  assert.equal(spliceRegion("a();\nb();\n", { start: 1, end: 1 }, "x();"), "a();\nx();\n");
});
