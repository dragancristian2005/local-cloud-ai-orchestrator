import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listDirTool, MAX_TOOL_RESULT_CHARS, readFileTool, resolveInside, searchTool, TOOL_DEFINITIONS, ToolError,
} from "../src/agent/tools.ts";

function makeFixture(): { root: string; outside: string } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-tools-")));
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside-dir");
  for (const dir of [root, outside, path.join(root, "src"), path.join(root, "keys"), path.join(root, ".git"), path.join(root, "node_modules/dep"), path.join(root, "many")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(root, "src/math.js"), "export function clampValue(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\n");
  writeFileSync(path.join(root, "big.txt"), Array.from({ length: 950 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");
  writeFileSync(path.join(root, ".env"), "API_TOKEN=clampValue-secret\n");
  writeFileSync(path.join(root, "keys/server.pem"), "-----BEGIN PRIVATE KEY-----\n");
  writeFileSync(path.join(root, ".git/config"), "[core]\n\tclampValue = 1\n");
  writeFileSync(path.join(root, "image.bin"), Buffer.from([1, 2, 0, 3, 4]));
  writeFileSync(path.join(root, "node_modules/dep/index.js"), "export const clampValue = 1;\n");
  writeFileSync(path.join(root, "huge-line.txt"), "y".repeat(5_000_000));
  for (let i = 0; i < 300; i++) writeFileSync(path.join(root, "many", `f${String(i).padStart(3, "0")}.txt`), "hit\n");
  writeFileSync(path.join(base, "secret.txt"), "outside the repository\n");
  writeFileSync(path.join(outside, "file.txt"), "outside the repository\n");
  symlinkSync(outside, path.join(root, "outside"));
  return { root, outside };
}

const { root } = makeFixture();

function refuses(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (err: unknown) => err instanceof ToolError && pattern.test(err.message));
}

test("the five tools are defined in Ollama's format", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.function.name), ["read_file", "list_dir", "search", "run_command", "ask_claude"]);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, "function");
    assert.ok(tool.function.description.length > 10);
    assert.equal(tool.function.parameters.type, "object");
    for (const name of tool.function.parameters.required) assert.ok(name in tool.function.parameters.properties);
  }
  const required = Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [tool.function.name, tool.function.parameters.required]));
  assert.deepEqual(required, { read_file: ["path"], list_dir: [], search: ["query"], run_command: ["command"], ask_claude: ["reason"] });
});

test("read_file returns numbered lines", () => {
  assert.equal(readFileTool(root, { path: "src/math.js" }), "1: export function clampValue(n, lo, hi) {\n2:   return Math.min(hi, Math.max(lo, n));\n3: }");
});

test("read_file pages through a long file", () => {
  const first = readFileTool(root, { path: "big.txt" });
  assert.ok(first.startsWith("1: row 1\n"));
  assert.ok(first.includes("200: row 200"));
  assert.ok(!first.includes("201: row 201"));
  assert.ok(first.endsWith("[lines 1-200 of 950; call read_file again with start_line=201]"));
  const second = readFileTool(root, { path: "big.txt", start_line: 201 });
  assert.ok(second.startsWith("201: row 201\n"));
  const last = readFileTool(root, { path: "big.txt", start_line: 900 });
  assert.ok(last.endsWith("950: row 950"));
});

test("read_file refuses paths outside the repository", () => {
  refuses(() => readFileTool(root, { path: "../secret.txt" }), /outside the repository/);
  refuses(() => readFileTool(root, { path: path.join(root, "..", "secret.txt") }), /outside the repository/);
  refuses(() => readFileTool(root, { path: "/etc/hosts" }), /outside the repository/);
  refuses(() => readFileTool(root, { path: "outside/file.txt" }), /outside the repository/);
});

test("read_file refuses secrets files and git internals", () => {
  for (const file of [".env", "keys/server.pem", ".git/config"]) {
    refuses(() => readFileTool(root, { path: file }), /refused/);
  }
});

test("the secrets check ignores letter case, because macOS file names do", () => {
  // On a case-insensitive disk ".ENV" opens ".env". Refuse by name whatever the case.
  mkdirSync(path.join(root, "Case/.GIT"), { recursive: true });
  writeFileSync(path.join(root, "Case/.ENV"), "TOKEN=x\n");
  writeFileSync(path.join(root, "Case/Server.PEM"), "key\n");
  writeFileSync(path.join(root, "Case/ID_RSA"), "key\n");
  writeFileSync(path.join(root, "Case/.GIT/config"), "x\n");
  for (const file of ["Case/.ENV", "Case/Server.PEM", "Case/ID_RSA", "Case/.GIT/config"]) {
    refuses(() => readFileTool(root, { path: file }), /refused/);
  }
  assert.equal(searchTool(root, { query: "TOKEN=x" }), "no matches");
  assert.ok(!listDirTool(root, { path: "Case" }).split("\n").includes(".GIT/"));
});

test("read_file caps a huge line", () => {
  const text = readFileTool(root, { path: "huge-line.txt" });
  assert.ok(text.length <= MAX_TOOL_RESULT_CHARS, `got ${text.length}`);
});

test("read_file rejects a binary file, a directory, a missing file and a missing path", () => {
  refuses(() => readFileTool(root, { path: "image.bin" }), /binary file/);
  refuses(() => readFileTool(root, { path: "src" }), /directory/);
  refuses(() => readFileTool(root, { path: "nope.txt" }), /no such file/);
  refuses(() => readFileTool(root, {}), /path/);
  refuses(() => readFileTool(root, { path: 42 }), /path/);
});

test("resolveInside accepts the root itself and files in it", () => {
  assert.equal(resolveInside(root, "."), root);
  assert.equal(resolveInside(root, "src/math.js"), path.join(root, "src/math.js"));
});

test("list_dir lists entries, marks directories and hides .git", () => {
  const listing = listDirTool(root, {});
  const lines = listing.split("\n");
  assert.ok(lines.includes("src/"));
  assert.ok(lines.includes("big.txt"));
  assert.ok(!lines.includes(".git/"));
  assert.deepEqual(listDirTool(root, { path: "src" }), "math.js");
});

test("list_dir caps a large directory and refuses to leave the repository", () => {
  const listing = listDirTool(root, { path: "many" });
  assert.equal(listing.split("\n").length, 201);
  assert.ok(listing.endsWith("[100 more entries]"));
  refuses(() => listDirTool(root, { path: ".." }), /outside the repository/);
  refuses(() => listDirTool(root, { path: "outside" }), /outside the repository/);
});

test("search finds text case-insensitively with path and line number", () => {
  assert.equal(searchTool(root, { query: "CLAMPVALUE" }), "src/math.js:1: export function clampValue(n, lo, hi) {");
});

test("search never looks in secrets files, node_modules or .git", () => {
  const result = searchTool(root, { query: "clampValue" });
  assert.ok(!result.includes(".env"));
  assert.ok(!result.includes("node_modules"));
  assert.ok(!result.includes(".git"));
});

test("search treats the query as literal text", () => {
  assert.equal(searchTool(root, { query: "Math.max(lo" }), "src/math.js:2:   return Math.min(hi, Math.max(lo, n));");
  assert.equal(searchTool(root, { query: "Math.m.x" }), "no matches");
});

test("search stops at 40 matches and refuses to leave the repository", () => {
  const result = searchTool(root, { query: "hit", path: "many" });
  const lines = result.split("\n");
  assert.equal(lines.length, 41);
  assert.equal(lines.at(-1), "[stopped after 40 matches]");
  refuses(() => searchTool(root, { query: "x", path: "../" }), /outside the repository/);
  refuses(() => searchTool(root, {}), /query/);
});

test("search cuts long matching lines", () => {
  const result = searchTool(root, { query: "yyyy", path: "huge-line.txt" });
  assert.ok(result.length < 400, `got ${result.length}`);
});
