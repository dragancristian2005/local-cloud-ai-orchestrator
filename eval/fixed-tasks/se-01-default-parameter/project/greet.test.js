import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "./greet.js";

test("greets by name", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});

test("greets the world when no name is given", () => {
  assert.equal(greet(), "Hello, world!");
});
