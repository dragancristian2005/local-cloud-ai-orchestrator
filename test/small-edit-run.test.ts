import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSmallEdit } from "../src/core/small-edit-run.ts";
import { InputError } from "../src/core/types.ts";
import type { Backend } from "../src/core/types.ts";
import { RunLog } from "../src/log/run-log.ts";
import { BROKEN, editRepo, GOOD, GUARDED, useTestGitIdentity } from "./helpers/edit-fixture.ts";
import { fakeBackend } from "./helpers/fake-backend.ts";
import { gitOut } from "./helpers/temp-repo.ts";

useTestGitIdentity();

function options(repo: string, chain: Backend[], over: Partial<Parameters<typeof runSmallEdit>[0]> = {}) {
  const runsDir = path.join(mkdtempSync(path.join(tmpdir(), "orch-se-")), "runs");
  return {
    repo, file: "math.js", symbol: "clamp", instruction: "use Math.min and Math.max",
    testCommand: "node check.mjs", testTimeoutMs: 20_000, linkPaths: [],
    allowFailingBaseline: false, commit: false,
    chain, retryBeforeEscalate: 1, budgetTokens: 6000, log: new RunLog(runsDir), mode: "run" as const,
    ...over,
  };
}
const worktrees = async (repo: string) => (await gitOut(repo, "worktree", "list")).split("\n").length;
const untouched = async (repo: string) => assert.deepEqual([await gitOut(repo, "status", "--porcelain"), await worktrees(repo)], ["", 1]);

test("returns a patch that applies cleanly", async () => {
  const repo = await editRepo();
  const local = fakeBackend({ id: "pc", replies: [GOOD] });
  const opts = options(repo, [local]);
  const result = await runSmallEdit(opts);

  assert.equal(result.outcome.ok, true);
  assert.match(result.patch ?? "", /^diff --git a\/math\.js b\/math\.js/);
  assert.equal(result.branch, null);
  assert.equal(result.leftAt, undefined);
  assert.ok(path.isAbsolute(result.patchFile!) && result.patchFile!.endsWith(path.join(result.outcome.runId, "change.patch")));
  assert.equal(readFileSync(result.patchFile!, "utf8"), result.patch);
  execFileSync("git", ["-C", repo, "apply", "--check", result.patchFile!]);
  await untouched(repo);
  assert.equal(existsSync(path.join(tmpdir(), `orch-edit-${result.outcome.runId}`)), false);
  // The prompt showed the function, marked, and the record is a small-edit pass.
  assert.ok(local.prompts[0]!.includes("<<<EDIT START>>>\nexport function clamp(n, lo, hi) {"));
  const record = opts.log.readAll()[0]!;
  assert.deepEqual([record.taskType, record.verify, record.mode, record.runId], ["small-edit", "pass", "run", result.outcome.runId]);
});

test("feeds the test failure into the retry", async () => {
  const repo = await editRepo();
  const local = fakeBackend({ id: "pc", replies: [BROKEN, GOOD] });
  const result = await runSmallEdit(options(repo, [local]));
  assert.equal(result.outcome.ok, true);
  assert.equal(result.outcome.attempts.length, 2);
  assert.match(result.outcome.attempts[0]!.verifyDetail, /^tests failed \(exit 1\):\n/);
  assert.ok(local.prompts[1]!.includes("tests failed"));
  assert.ok(result.patch!.includes("+  return Math.min(hi, Math.max(lo, n));") && !result.patch!.includes("+  return n;"));
});

test("a format failure does not run the tests", async () => {
  const repo = await editRepo();
  const local = fakeBackend({ id: "pc", replies: ["export function clamp(n, lo, hi) {\n  if (n < lo) return lo;\n  return n > hi ? hi : n;\n}", GOOD] });
  const result = await runSmallEdit(options(repo, [local]));
  assert.equal(result.outcome.attempts[0]!.verifyDetail, "the answer is identical to the original code");
  assert.equal(result.outcome.ok, true);
});

test("rejects before any call when the file has uncommitted changes", async () => {
  const repo = await editRepo();
  writeFileSync(path.join(repo, "math.js"), "export function clamp(n) {\n  return n;\n}\n");
  const local = fakeBackend({ id: "pc", replies: [GOOD] });
  await assert.rejects(runSmallEdit(options(repo, [local])), (err: unknown) => err instanceof InputError && /math\.js has uncommitted changes/.test(err.message));
  assert.equal(local.prompts.length, 0);
  assert.equal(await worktrees(repo), 1);
});

test("stops when the baseline fails", async () => {
  const repo = await editRepo({ strict: true });
  const local = fakeBackend({ id: "pc", replies: [GOOD] });
  await assert.rejects(
    runSmallEdit(options(repo, [local])),
    (err: unknown) => err instanceof InputError && /the test command fails before any change \(exit 1\)\. Fix the tests first, or pass --allow-failing-baseline/.test(err.message) && /AssertionError/.test(err.message),
  );
  assert.equal(local.prompts.length, 0);
  await untouched(repo);
});

test("--allow-failing-baseline makes a failing test pass", async () => {
  const repo = await editRepo({ strict: true });
  const local = fakeBackend({ id: "pc", replies: [GOOD, GUARDED] });
  const result = await runSmallEdit(options(repo, [local], { allowFailingBaseline: true, instruction: "throw when lo is greater than hi" }));
  assert.equal(result.outcome.ok, true);
  assert.equal(result.outcome.attempts.length, 2, "the first answer still failed the new assertion");
  assert.ok(result.patch!.includes("lo must not be greater than hi"));
  await untouched(repo);
});

test("commit puts the change on a new branch only", async () => {
  const repo = await editRepo();
  const head = await gitOut(repo, "rev-parse", "HEAD");
  const branch = await gitOut(repo, "symbolic-ref", "--short", "HEAD");
  const instruction = "use Math.min and Math.max, " + "and keep everything else exactly as it is ".repeat(4);
  const result = await runSmallEdit(options(repo, [fakeBackend({ id: "pc", replies: [GOOD] })], { commit: true, instruction }));

  assert.equal(result.branch, `orch/small-edit-${result.outcome.runId}`);
  assert.equal(await gitOut(repo, "symbolic-ref", "--short", "HEAD"), branch);
  assert.equal(await gitOut(repo, "rev-parse", "HEAD"), head);
  assert.equal(await gitOut(repo, "rev-parse", `${result.branch}~1`), head);
  assert.equal(await gitOut(repo, "show", "--name-only", "--format=", result.branch!), "math.js");
  const subject = await gitOut(repo, "show", "-s", "--format=%s", result.branch!);
  assert.ok(subject.startsWith("orch: use Math.min and Math.max") && subject.length <= 72, subject);
  await untouched(repo);
});

test("hostile output stays text", async () => {
  const repo = await editRepo();
  const hostile = "export function clamp(n, lo, hi) {\n  // `$(touch pwned)` $(touch pwned) ; touch pwned ../../pwned\n  return Math.min(hi, Math.max(lo, n));\n}";
  const result = await runSmallEdit(options(repo, [fakeBackend({ id: "pc", replies: [hostile] })], { commit: true }));
  assert.equal(result.outcome.ok, true);
  assert.ok(result.patch!.includes("$(touch pwned)"));
  for (const dir of [repo, path.dirname(repo), process.cwd(), tmpdir(), path.dirname(result.patchFile!)]) {
    assert.equal(existsSync(path.join(dir, "pwned")), false, dir);
  }
  await untouched(repo);
});

test("all tiers fail", async () => {
  const repo = await editRepo();
  const branches = await gitOut(repo, "branch", "--list");
  const chain = [fakeBackend({ id: "pc", replies: [BROKEN, BROKEN] }), fakeBackend({ id: "claude", kind: "cloud", replies: [BROKEN, BROKEN] })];
  const result = await runSmallEdit(options(repo, chain, { commit: true }));
  assert.deepEqual([result.outcome.ok, result.patch, result.patchFile, result.branch], [false, null, null, null]);
  assert.equal(result.outcome.attempts.length, 3, "two local tries, then Claude once");
  assert.equal(await gitOut(repo, "branch", "--list"), branches);
  await untouched(repo);
});

test("works with --lines instead of --symbol", async () => {
  const repo = await editRepo();
  const result = await runSmallEdit(options(repo, [fakeBackend({ id: "pc", replies: [GOOD] })], { symbol: undefined, lines: "2-5" }));
  assert.equal(result.outcome.ok, true);
  execFileSync("git", ["-C", repo, "apply", "--check", result.patchFile!]);
});

test("rejects both --symbol and --lines, and neither", async () => {
  const repo = await editRepo();
  const local = fakeBackend({ id: "pc", replies: [GOOD] });
  await assert.rejects(runSmallEdit(options(repo, [local], { lines: "2-5" })), InputError);
  await assert.rejects(runSmallEdit(options(repo, [local], { symbol: undefined })), InputError);
  await assert.rejects(runSmallEdit(options(repo, [local], { file: "../outside.js" })), InputError);
  assert.equal(await worktrees(repo), 1);
});

test("works from a subdirectory of the repository", async () => {
  const repo = await editRepo({ extra: { "sub/keep.txt": "x\n" } });
  const result = await runSmallEdit(options(path.join(repo, "sub"), [fakeBackend({ id: "pc", replies: [GOOD] })], { file: "../math.js" }));
  assert.match(result.patch ?? "", /^diff --git a\/math\.js b\/math\.js/);
});

test("an aborted run cleans up", async () => {
  const repo = await editRepo();
  const stop = new AbortController();
  const local = fakeBackend({ id: "pc", replies: [GOOD] });
  setTimeout(() => stop.abort(), 300);
  const started = Date.now();
  await assert.rejects(
    runSmallEdit(options(repo, [local], { testCommand: `node -e "setInterval(() => {}, 1000)"`, allowFailingBaseline: true, signal: stop.signal })),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.ok(Date.now() - started < 5000);
  assert.equal(local.prompts.length, 0);
  await untouched(repo);
});

test("an abort during a model call does not wait for it, and nothing runs afterwards", async () => {
  const repo = await editRepo();
  const stop = new AbortController();
  let release: (text: string) => void = () => {};
  const slow: Backend = {
    ...fakeBackend({ id: "pc", replies: [] }),
    run: () => new Promise((resolve) => (release = (text) => resolve({ text, durationMs: 1 }))),
  };
  const second = fakeBackend({ id: "claude", kind: "cloud", replies: [GOOD] });
  setTimeout(() => stop.abort(), 600);
  await assert.rejects(runSmallEdit(options(repo, [slow, second], { signal: stop.signal })), (err: unknown) => err instanceof Error && err.name === "AbortError");
  await untouched(repo);
  release(BROKEN);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(second.prompts.length, 0, "no further model call after the abort");
  await untouched(repo);
});
