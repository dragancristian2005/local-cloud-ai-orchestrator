import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODING_SYSTEM_PROMPT, codingToolkit } from "../src/agent/coding-toolkit.ts";
import { readFileTool } from "../src/agent/tools.ts";
import { ToolError } from "../src/agent/toolkit.ts";

function kit(commandTimeoutMs = 5000) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-kit-")));
  writeFileSync(path.join(root, "a.txt"), "hello\n");
  const toolkit = codingToolkit({ root, commandTimeoutMs, allowCommands: ["ls"], onMainBranch: false });
  const tool = (name: string) => toolkit.tools.find((t) => t.definition.function.name === name)!;
  return { root, toolkit, tool };
}

test("the coding toolkit has the four tools, in order, and the coding prompt", () => {
  const { root, toolkit } = kit();
  assert.deepEqual(toolkit.tools.map((t) => t.definition.function.name), ["read_file", "list_dir", "search", "run_command"]);
  assert.equal(toolkit.systemPrompt, CODING_SYSTEM_PROMPT(root));
  assert.ok(toolkit.systemPrompt.includes(root) && toolkit.systemPrompt.includes("ask_claude"));
});

test("each call is described by what it touches", () => {
  const { tool } = kit();
  assert.equal(tool("read_file").describe({ path: "src/a.ts" }), "read_file src/a.ts");
  assert.equal(tool("list_dir").describe({}), "list_dir");
  assert.equal(tool("list_dir").describe({ path: "src" }), "list_dir src");
  assert.equal(tool("search").describe({ query: "clamp" }), 'search "clamp"');
  assert.equal(tool("search").describe({ query: "clamp", path: "src" }), 'search "clamp" in src');
  assert.equal(tool("run_command").describe({ command: "npm test" }), "npm test");
  assert.equal(tool("run_command").describe({ command: 42 }), "");
});

test("the file tools are the existing ones, bound to the repository", async () => {
  const { root, tool } = kit();
  assert.equal(await tool("read_file").run({ path: "a.txt" }, {}), readFileTool(root, { path: "a.txt" }));
  await assert.rejects(async () => tool("read_file").run({ path: "../x" }, {}), ToolError);
});

test("run_command returns the output and the exit code", async () => {
  const { tool } = kit();
  assert.deepEqual(await tool("run_command").run({ command: `node -e "console.log(40 + 2)"` }, {}), { text: "exit code 0\n42", exitCode: 0 });
  assert.deepEqual(await tool("run_command").run({ command: `node -e "process.exit(3)"` }, {}), { text: "exit code 3", exitCode: 3 });
});

test("run_command says when a command was cut off", async () => {
  const { tool } = kit(300);
  const result = await tool("run_command").run({ command: `node -e "setInterval(() => {}, 1000)"` }, {});
  assert.match(typeof result === "string" ? result : result.text, /^timed out after 0 s/);
});

test("run_command rejects a command that is not text", async () => {
  const { tool } = kit();
  for (const bad of [42, "", "  ", undefined]) {
    await assert.rejects(async () => tool("run_command").run({ command: bad }, {}), (err: unknown) => err instanceof ToolError && err.message === '"command" must be a non-empty string');
  }
});
