import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "../src/core/command.ts";

const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-cmd-")));

test("runCommand reports success with its output", async () => {
  const result = await runCommand(`node -e "console.log('hi')"`, { cwd, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /hi/);
});

test("runCommand reports the exit code and captures stderr", async () => {
  const result = await runCommand(`node -e "console.error('bad'); process.exit(3)"`, { cwd, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /bad/);
});

test("runCommand runs in cwd", async () => {
  const result = await runCommand(`node -e "console.log(process.cwd())"`, { cwd, timeoutMs: 5000 });
  assert.equal(result.output.trim(), cwd);
});

test("runCommand kills a hanging command at the timeout", async () => {
  const started = Date.now();
  const result = await runCommand(`node -e "setInterval(() => {}, 1000)"`, { cwd, timeoutMs: 300 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

test("runCommand kills the whole process group, not only the shell", async () => {
  const started = Date.now();
  const result = await runCommand(`node -e "setInterval(() => {}, 1000)" & node -e "setInterval(() => {}, 1000)"`, { cwd, timeoutMs: 300 });
  assert.ok(Date.now() - started < 3000, "a surviving child would keep the pipes open");
  assert.equal(result.timedOut, true);
});

test("runCommand stops when its signal aborts", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const started = Date.now();
  const result = await runCommand(`node -e "setInterval(() => {}, 1000)"`, { cwd, timeoutMs: 60_000, signal: controller.signal });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.ok, false);
});

test("runCommand survives an unknown command", async () => {
  const result = await runCommand("definitely-not-a-command-xyz", { cwd, timeoutMs: 5000 });
  assert.equal(result.ok, false);
});

test("runCommand keeps only the end of a huge output", async () => {
  const result = await runCommand(`node -e "process.stdout.write('x'.repeat(1000000) + 'END')"`, { cwd, timeoutMs: 10_000 });
  assert.equal(result.output.length, 20_000);
  assert.ok(result.output.endsWith("END"));
});

test("runCommand does not wait for input", async () => {
  const result = await runCommand(`node -e "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('eof'))"`, { cwd, timeoutMs: 5000 });
  assert.equal(result.timedOut, false);
  assert.match(result.output, /eof/);
});

test("runCommand never rejects, even for a command the system cannot start", async () => {
  const result = await runCommand("echo a\u0000b", { cwd, timeoutMs: 5000 });
  assert.equal(result.ok, false);
});

test("runCommand returns at the timeout even when a detached child keeps the output open", async () => {
  const detached = `node -e "require('child_process').spawn('node', ['-e', 'setTimeout(() => {}, 6000)'], { detached: true, stdio: 'inherit' }).unref(); setInterval(() => {}, 1000)"`;
  const started = Date.now();
  const result = await runCommand(detached, { cwd, timeoutMs: 300 });
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(result.timedOut, true);
});

test("runCommand does not tell the command it is inside a node:test run", async () => {
  // Inherited, this marker makes a nested `node --test` skip every file and exit 0.
  assert.ok(process.env.NODE_TEST_CONTEXT, "this test itself runs under node:test");
  const result = await runCommand(`node -e "console.log(process.env.NODE_TEST_CONTEXT ?? 'unset')"`, { cwd: process.cwd(), timeoutMs: 10_000 });
  assert.equal(result.output.trim(), "unset");
});
