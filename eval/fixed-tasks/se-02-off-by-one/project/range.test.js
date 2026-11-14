import { test } from "node:test";
import assert from "node:assert/strict";
import { range } from "./range.js";

test("includes both ends", () => {
  assert.deepEqual(range(1, 3), [1, 2, 3]);
});

test("a range of one number", () => {
  assert.deepEqual(range(2, 2), [2]);
});

test("an inverted range is empty", () => {
  assert.deepEqual(range(3, 1), []);
});
