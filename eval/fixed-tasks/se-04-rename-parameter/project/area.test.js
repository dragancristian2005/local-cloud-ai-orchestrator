import { test } from "node:test";
import assert from "node:assert/strict";
import { area } from "./area.js";

test("multiplies the sides", () => {
  assert.equal(area(2, 3), 6);
  assert.equal(area(0, 5), 0);
});

test("takes two parameters", () => {
  assert.equal(area.length, 2);
});
