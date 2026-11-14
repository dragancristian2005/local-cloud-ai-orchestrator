import { test } from "node:test";
import assert from "node:assert/strict";
import { average } from "./average.js";

test("averages numbers", () => {
  assert.equal(average([2, 4]), 3);
  assert.equal(average([5]), 5);
});

test("an empty list averages to 0", () => {
  assert.equal(average([]), 0);
});
