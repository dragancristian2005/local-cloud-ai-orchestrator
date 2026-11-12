# Small-Edit (M4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orch run --type small-edit` asks a model to change one function, applies the answer in a throwaway git worktree, runs the project's own test command there, and prints a patch only when the tests pass.

**Architecture:** The model stays a stateless worker: it receives one marked region of one file plus an instruction, and returns the new version of that region as plain text. `orch` splices the answer into a copy of the repository (a detached `git worktree` in the temp directory), runs the test command, and feeds a failure back through the existing retry and escalation loop. The user's working tree, index and branch are never touched; the result is a patch on stdout, or a commit on a new branch with `--commit`.

**Tech Stack:** unchanged. Node >= 22.18 running TypeScript directly, `node:test`, zero runtime dependencies, `git` through `execFile`.

**Spec:** `CLAUDE.md` (repo root): milestone M4 and the Hard rules. This plan builds on `docs/superpowers/plans/2026-11-12-tiered-orchestrator.md` (M1–M3, merged).

## Decisions (need your OK)

- **A worktree in the temp directory, not a branch in your working tree.** `git worktree add --detach` gives the tests a full checkout of `HEAD` somewhere else. Your files, your index and your current branch are never changed, even if `orch` is killed mid-run. Checked: creating, editing, committing on a new branch and removing the worktree leave the main repository's `git status` empty.
- **The result is a patch on stdout.** `orch run --type small-edit ... | git apply` applies it. The patch is also saved to `runs/<runId>/change.patch`. With `--commit`, the change is committed on a new branch `orch/small-edit-<runId>` and your current branch still does not move.
- **The model returns the new version of a marked region, not a diff.** Small models write broken diffs. `orch` marks the function, the model rewrites it, `orch` splices it in.
- **You pick the region with `--symbol` or `--lines`.** `--symbol clamp` finds the function's block (brace matching for JS/TS, indentation for Python). `--lines 12-30` is the escape hatch when that guess is wrong.
- **The test command comes from you.** `--test "npm test"`, or once per repository in `config/orchestrator.local.json` under `repos`. It is the only thing `orch` runs through a shell. Model output is never put into a command line.
- **The tests execute the model's code on your Mac, unsandboxed.** That is what "verified by the project's own tests" means. Use small-edit only on repositories you trust.
- **Dependencies are symlinked.** A fresh worktree has no `node_modules`. `--link node_modules` (or `linkPaths` in config) symlinks ignored directories from your checkout into the worktree.
- **The tests run once before any model call.** If they pass, the edit must keep them passing. If they fail, `orch` stops, unless you pass `--allow-failing-baseline`: that is the write-the-test-first flow ("these tests fail now, make them pass") and the most meaningful way to use small-edit.
- **The target file must have no uncommitted changes.** The worktree is `HEAD`, so an edit based on it would silently ignore your unsaved work. `orch` refuses instead.
- **Never `--force`, never `rm -rf`.** Cleanup restores the edited file, removes its own symlinks and runs a plain `git worktree remove`. If the tests left untracked files behind and git refuses, the worktree stays and its path is printed.
- **Four fixed small-edit tasks join the eval set**, all JavaScript and all test-first, so local models can be compared on edits too.

## Global Constraints

- The Hard rules in `CLAUDE.md` apply verbatim.
- In the user's repository, `orch` runs only: read-only git queries, `git worktree add --detach`, `git worktree remove` (no `--force`). Never `switch`, `checkout`, `reset`, `stash`, `clean`, `add` or `commit` there.
- Git writes happen only inside the worktree `orch` created: `<os.tmpdir()>/orch-edit-<runId>`.
- A commit is made only with `--commit`, only on a new branch `orch/small-edit-<runId>`, and `git add` names the one edited file.
- Only the user's test command goes through a shell (`spawn(command, { shell: true })`). Everything else uses argument arrays. Nothing derived from model output is ever part of a command or a path.
- Test command timeout: `300000` ms by default. On timeout the whole process group is killed.
- stdout carries only the patch. Progress, the patch file path and the branch name go to stderr.
- Exit codes are unchanged: `0` patch produced, `1` every tier failed, `2` bad usage, config or input.
- Zero runtime dependencies. Tests first. `npm test` needs neither the PC nor the real `claude`.

## Review Focus

1. **Killed mid-run** (Ctrl-C while the tests run): the user's repository is exactly as before, and the leftover worktree does not block the next run. (Task 5)
2. **Uncommitted changes in the target file:** refused with a clear message before any model call or worktree. (Task 5)
3. **Hostile model output:** an answer containing `$(touch pwned)`, backticks or `../` ends up as file content only. Nothing executes, nothing is written outside the worktree. (Tasks 4 and 5)
4. **Tests that leave untracked files in the worktree:** cleanup does not force anything; it reports where the worktree was left. (Task 4)
5. **CRLF line endings and tab indentation:** the spliced file keeps both. (Task 2)

## File map

| File | Responsibility |
|---|---|
| `src/core/types.ts`, `src/core/orchestrator.ts` | async `verify`, optional `runId` |
| `src/core/verifier.ts` | `runCommand`: the shell-command verifier |
| `src/tasks/region.ts` | find a symbol's block, parse `--lines`, splice, re-indent |
| `src/tasks/small-edit.ts` | prompt, normalise, format checks |
| `src/workspace/git.ts` | `repoRoot`, `assertEditable` (still read-only) |
| `src/workspace/edit-workspace.ts` | worktree lifecycle: create, link, write, test, diff, commit, dispose |
| `src/core/small-edit-run.ts` | the small-edit flow, used by the CLI and by eval |
| `src/core/config.ts`, `src/cli.ts`, `src/log/run-log.ts` | `repos` config, new flags, `writeArtifact` |
| `eval/compare.ts`, `eval/fixed-tasks/se-*` | small-edit in the fixed set |

---

### Task 1: Async verification and the shell-command verifier

**Files:**
- Modify: `src/core/types.ts`, `src/core/orchestrator.ts`, `src/core/verifier.ts`
- Test: `test/verifier.test.ts`, `test/orchestrator.test.ts`

**Interfaces — Produces:**

```ts
// src/core/types.ts
verify?(output: string): VerifyResult | Promise<VerifyResult>;   // in PreparedTask

// src/core/orchestrator.ts — RunTaskOptions gains
runId?: string;   // default: log.newRunId()

// src/core/verifier.ts
export interface CommandResult { ok: boolean; exitCode: number | null; timedOut: boolean; output: string }
export function runCommand(command: string, opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<CommandResult>;
export function failureTail(output: string, maxLines?: number, maxChars?: number): string;   // defaults 30 and 1500
```

`runCommand` spawns with `{ shell: true, cwd, detached: true }`, merges stdout and stderr in arrival order into `output` (keeping the last 20 000 characters), and never rejects. `ok` is `exitCode === 0 && !timedOut`. On timeout, or when `signal` aborts, it kills the process group with `process.kill(-pid, "SIGKILL")`; an aborted run resolves with `ok false`.

- [ ] **Step 1: Write the failing tests**
  - `runCommand reports success`: `node -e "console.log('hi')"` gives `ok true`, `exitCode 0`, `output` containing `hi`.
  - `runCommand reports the exit code and stderr`: `node -e "console.error('bad'); process.exit(3)"` gives `ok false`, `exitCode 3`, `output` containing `bad`.
  - `runCommand runs in cwd`: `node -e "console.log(process.cwd())"` in a temp directory prints that directory.
  - `runCommand kills a hanging command`: `node -e "setInterval(() => {}, 1000)"` with `timeoutMs: 300` resolves in under 3000 ms with `timedOut true`, `ok false`.
  - `runCommand stops when its signal aborts`: the same hanging command with a 60 000 ms timeout and a signal aborted after 200 ms resolves in under 3000 ms with `ok false`.
  - `runCommand survives an unknown command`: `definitely-not-a-command-xyz` resolves with `ok false`.
  - `failureTail keeps the end`: a 100-line string gives its last 30 lines; a single 5000-character line is cut to its last 1500 characters.
  - `runTask awaits an async verifier`: a task whose `verify` is `async` and returns `fail` then `pass` produces two records and `ok true`.
  - `runTask uses a given runId`: with `runId: "fixed-id"`, every record and the output path carry `fixed-id`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL (`runCommand` is not exported; the async verifier's result is treated as truthy garbage).
- [ ] **Step 3: Implement.** In `runTask`, `await task.verify(text)`.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: async verifiers and a shell-command verifier`.

### Task 2: Finding, splicing and re-indenting a region

**Files:**
- Create: `src/tasks/region.ts`
- Modify: `src/core/context.ts` (export `findSymbolLine`)
- Test: `test/region.test.ts`

**Interfaces:**
- Consumes: `findSymbolLine(lines: string[], symbol: string): number`, `Language` from `src/tasks/language.ts`, `InputError`.
- Produces:

```ts
export interface Region { start: number; end: number }   // 0-based line indexes, both inclusive
export function parseLineRange(text: string, lineCount: number): Region;   // "12-30" is 1-based and inclusive
export function findRegion(source: string, language: Language, symbol: string): Region;
export function regionText(source: string, region: Region): string;        // the lines, joined with "\n"
export function reindent(replacement: string, original: string): string;
export function spliceRegion(source: string, region: Region, replacement: string): string;
```

`findRegion`, JavaScript and TypeScript: the region starts at the declaration line. Scan characters from there, skipping `'…'`, `"…"` and `` `…` `` strings and `//` and `/* */` comments. The region ends on the line where the brace depth returns to 0 after the first `{`. If a `;` is met at depth 0, with no open parenthesis, before any `{`, the region ends on that line (a one-statement declaration). Reaching the end of the file throws `InputError("could not find the end of <symbol>: pass --lines <start>-<end>")`.

`findRegion`, Python: the region starts at the declaration line and runs to the last following non-blank line that is indented more than it. A declaration with no such line throws the same `InputError`.

`reindent`: remove the smallest indentation shared by the replacement's non-blank lines, then put the indentation of the original's first line in front of every non-blank line.

`spliceRegion`: replace the region's lines with the replacement's lines. A source that uses `\r\n` keeps `\r\n` on every line of the result. The file's final newline, or its absence, is kept.

- [ ] **Step 1: Write the failing tests**
  - `parseLineRange("2-4", 10)` is `{ start: 1, end: 3 }`. `"4-2"`, `"0-3"`, `"2-11"`, `"abc"` and `"3"` each throw `InputError`.
  - `findRegion finds a function block`: in a file with `clamp` on lines 3–8 and another function after it, the region is exactly lines 3–8.
  - `findRegion ignores braces in strings and comments`: a body containing `const s = "}{";`, `` `${a}}` `` and `// }` still ends at the real closing brace.
  - `findRegion finds a one-line arrow function`: `export const double = (n) => n * 2;` gives a one-line region.
  - `findRegion finds a class method`: `get(key) { ... }` inside a class gives the method's lines only.
  - `findRegion finds a Python function`: ends before the next `def` at the same indentation; trailing blank lines are not included.
  - `findRegion rejects a missing symbol` and `an unterminated block`: `InputError`, the second message containing `--lines`.
  - `reindent restores the original indentation`: a replacement with no indentation, for an original indented four spaces, comes back with four spaces on every non-blank line and inner indentation preserved. Same with a tab-indented original. *(Review Focus 5)*
  - `spliceRegion replaces only the region`: lines before and after are byte-identical.
  - `spliceRegion keeps CRLF`: a `\r\n` source spliced with an `\n` replacement has no bare `\n`. *(Review Focus 5)*
  - `spliceRegion keeps a missing final newline`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: locate, splice and re-indent a code region`.

### Task 3: The `small-edit` task module

**Files:**
- Create: `src/tasks/small-edit.ts`
- Modify: `src/core/types.ts` (`TaskInput` gains `instruction?: string` and `region?: { start: number; end: number }`), `src/tasks/task.ts` (register it)
- Test: `test/small-edit.test.ts`

**Interfaces:**
- Consumes: `regionText`, `reindent` (Task 2), `cleanModelOutput`, `runChecks`, `estimateTokens`.
- Produces: `export const smallEdit: TaskModule` (type `"small-edit"`), `export const EDIT_START = "<<<EDIT START>>>"`, `export const EDIT_END = "<<<EDIT END>>>"`.

`prepare(input, budgetTokens)` needs `filePath`, `instruction` and `region`, else `InputError`. If the region is more than half the budget, it throws `InputError("the code to edit is about N tokens; small-edit takes at most M: choose a smaller range with --lines")`. The rest of the budget goes to context: whole lines nearest the region, half before and half after.

Prompt (exact copy):

```
You edit code.

Change the code between the markers so that: {instruction}

Rules:
- Reply with the complete new version of the marked code and nothing else.
- Change only what the instruction asks. Keep everything else as it is.
- Do not include the marker lines. No code fences, no explanation.

File: {file}
{context before}
<<<EDIT START>>>
{region}
<<<EDIT END>>>
{context after}
```

`normalize`: `cleanModelOutput`, then drop any line that is exactly a marker, then `reindent` against the original region.

Format checks, in order: `nonEmpty`; `noCodeFence`; the answer differs from the original region (`the answer is identical to the original code`); the answer has at most `max(3 × original lines, original lines + 40)` lines (`answer is N lines for an M-line original: change only what the instruction asks`); when `input.symbol` is set, the symbol still appears as a whole word (`the answer no longer contains <symbol>`).

These checks are the task's `verify`. The test run is added around them in Task 5.

- [ ] **Step 1: Write the failing tests**
  - The prompt contains the instruction, the file name, both markers with the region between them, and context lines from before and after the region.
  - `prepare` throws without an instruction, without a region, and for a region larger than half the budget (message contains `--lines`).
  - With a 5000-line file and a 10-line region, `estimateTokens(prompt) <= budget`.
  - `normalize` unwraps a fenced answer, drops echoed marker lines, and restores a four-space indentation the model dropped.
  - `verify` passes a changed function. It fails an unchanged one, a 200-line answer for a 5-line original, and an answer where the symbol is gone.
  - `taskModules["small-edit"]` is `smallEdit`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass. (`test/docstring.test.ts` asserts the list of registered task types: add `small-edit` to it.)
- [ ] **Step 5: Commit** — `feat: small-edit task module`.

### Task 4: The edit workspace

**Files:**
- Create: `src/workspace/edit-workspace.ts`
- Modify: `src/workspace/git.ts`
- Test: `test/edit-workspace.test.ts`, additions to `test/git.test.ts`; `test/helpers/temp-repo.ts` gains `commitAll(repo)` (commits with `-c user.name=orch-test -c user.email=orch-test@localhost`)

**Interfaces:**
- Consumes: `runCommand`, `CommandResult` (Task 1).
- Produces:

```ts
// src/workspace/git.ts — both read-only
export function repoRoot(dir: string): Promise<string>;                        // git rev-parse --show-toplevel; InputError outside a repository
export function assertEditable(root: string, file: string): Promise<void>;     // InputError if the file is untracked or has uncommitted changes

// src/workspace/edit-workspace.ts
export interface EditWorkspace {
  dir: string;
  read(file: string): string;                          // file is relative to the repository root
  write(file: string, content: string): void;
  test(): Promise<CommandResult>;
  diff(file: string): Promise<string>;                 // git diff --no-color -- <file>, in the worktree
  commit(file: string, branch: string, message: string): Promise<void>;
  dispose(): Promise<{ removed: boolean; leftAt?: string }>;
}
export function createEditWorkspace(opts: {
  repoRoot: string; id: string; testCommand: string; testTimeoutMs: number; linkPaths: string[];
  signal?: AbortSignal;        // passed to every test run
}): Promise<EditWorkspace>;
```

- `createEditWorkspace` runs `git -C <repoRoot> worktree add --detach <os.tmpdir()>/orch-edit-<id> HEAD`, then symlinks each `linkPaths` entry that exists in `repoRoot` and not in the worktree. An entry that is absolute or contains `..` is a `ConfigError`.
- `read` and `write` refuse a path that is absolute or leaves the worktree (`InputError`). `write` remembers the file's original content the first time.
- `commit` runs, in the worktree: `git switch -c <branch>`, `git add -- <file>`, `git commit -m <message>`. A failure becomes `InputError("git commit failed: <first line of stderr>")`.
- `dispose` writes remembered originals back (skipped after a commit), unlinks the symlinks it made, and runs `git -C <repoRoot> worktree remove <dir>` without `--force`. If git refuses, it returns `{ removed: false, leftAt: dir }` and deletes nothing. A second call does nothing.

Why the symlinks are unlinked first (checked): `.gitignore`'s `node_modules/` matches directories only, so a symlink named `node_modules` shows up as untracked and blocks the removal. Ignored files left by a test run do not block it.

- [ ] **Step 1: Write the failing tests** (fixture: a temp repo with `value.js` containing `export default 1;` and `check.mjs` that exits 0 only when the default export is `2`; committed)
  - `creates a worktree and leaves the repository alone`: `dir` is under `os.tmpdir()` and named `orch-edit-<id>`; in the repository `git status --porcelain` is empty and `git worktree list` has 2 lines.
  - `write then test`: `test()` is `ok false` first; after `write("value.js", "export default 2;\n")` it is `ok true`. The repository's own `value.js` still says `1`.
  - `diff shows the change`: contains `-export default 1;` and `+export default 2;`.
  - `links dependencies`: with an ignored `node_modules/dep/index.js` in the repository and `linkPaths: ["node_modules"]`, the file is readable through the worktree.
  - `dispose removes the worktree`: `removed true`, the directory is gone, `git worktree list` has 1 line, branches and `HEAD` are unchanged, `git status --porcelain` is empty. Calling it again resolves.
  - `commit creates a branch with one commit touching one file`: with a linked `node_modules`, after `write`, `commit("value.js", "orch/small-edit-t1", "orch: set value")` and `dispose`: the repository has the branch, `git show --stat` on it lists only `value.js`, and the repository is still on its original branch with a clean status.
  - `dispose does not force` *(Review Focus 4)*: after writing an untracked, unignored file directly into the worktree, `dispose` returns `removed false` with `leftAt`, and the directory still exists.
  - `write refuses to leave the worktree` *(Review Focus 3)*: `write("../escape.txt", "x")` and `write("/tmp/escape.txt", "x")` throw `InputError`; neither file exists.
  - `rejects a linkPath that leaves the repository`: `linkPaths: ["../x"]` rejects with `ConfigError`.
  - `repoRoot` returns the top-level directory from a subdirectory and throws `InputError` outside a repository.
  - `assertEditable` resolves for a committed file; rejects for an untracked file and for a file with unstaged or staged changes, each with a message naming the file.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: throwaway worktree for verifying edits`.

### Task 5: The small-edit flow and `orch run --type small-edit`

**Files:**
- Create: `src/core/small-edit-run.ts`
- Modify: `src/cli.ts`, `src/core/config.ts`, `src/log/run-log.ts`, `config/orchestrator.config.json` (chain `"small-edit": ["pc-ollama", "claude"]`)
- Test: `test/small-edit-run.test.ts`, `test/cli-small-edit.test.ts`, additions to `test/config.test.ts` and `test/run-log.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, `runTask`, `languageOf`.
- Produces:

```ts
// src/core/small-edit-run.ts
export interface SmallEditResult {
  outcome: RunOutcome;
  patch: string | null;        // null when every tier failed
  patchFile: string | null;    // absolute path of runs/<runId>/change.patch
  branch: string | null;       // set only with commit
  leftAt?: string;             // worktree path, when cleanup could not remove it
}
export function runSmallEdit(opts: {
  repo: string; file: string; symbol?: string; lines?: string; instruction: string;
  testCommand: string; testTimeoutMs: number; linkPaths: string[];
  allowFailingBaseline: boolean; commit: boolean;
  chain: Backend[]; retryBeforeEscalate: number; budgetTokens: number; log: RunLog;
  mode: "run" | "eval"; taskId?: string;
  decide?: RunTaskOptions["decide"]; onProgress?: (line: string) => void;
  signal?: AbortSignal;        // aborting disposes the workspace and rejects
}): Promise<SmallEditResult>;

// src/log/run-log.ts
writeArtifact(runId: string, name: string, text: string): string;   // returns the absolute path

// src/core/config.ts — OrchestratorConfig gains
repos: Record<string, { testCommand?: string; linkPaths?: string[]; testTimeoutMs?: number }>;   // keyed by absolute repository root; default {}
```

`runSmallEdit`, in order:
1. Exactly one of `symbol` and `lines`, else `InputError`. `repoRoot(repo)`. Make `file` relative to the root. `languageOf(file)` when `symbol` is used. `assertEditable(root, file)`.
2. `runId = log.newRunId()`; `createEditWorkspace({ id: runId, ... })`. Everything from here runs inside `try`/`finally` with `dispose()` in the `finally`.
3. Read the file from the workspace, compute the region, `smallEdit.prepare(...)`.
4. Baseline: `ws.test()`. Passing with `allowFailingBaseline` is fine. Failing without it throws `InputError("the test command fails before any change (exit N). Fix the tests first, or pass --allow-failing-baseline if the edit is meant to make them pass.\n<failureTail>")`. No backend has been called at this point.
5. `runTask` with `runId` and a `verify` that runs the task's format checks first, then `ws.write(file, spliceRegion(source, region, answer))` and `ws.test()`. A failing run gives `{ status: "fail", detail: "tests failed (exit N):\n<failureTail>" }`, or `tests timed out after N s`.
6. On success: `patch = await ws.diff(file)`, saved with `writeArtifact(runId, "change.patch", patch)`. With `commit`: `ws.commit(file, "orch/small-edit-<runId>", "orch: <instruction>")`, the subject cut to 72 characters.
7. `dispose()`; a worktree that could not be removed is returned as `leftAt`.

When `signal` aborts, the running test command is killed, the workspace is disposed and `runSmallEdit` rejects with an `AbortError`. It does not wait for a model call that is in flight.

CLI: `orch run --type small-edit --file <path> (--symbol <name> | --lines <a>-<b>) --instruction "<text>" [--test "<command>"] [--link <path>]... [--allow-failing-baseline] [--commit]`.
- The test command is `--test`, else `config.repos[<repository root>].testCommand`, else `UsageError` naming both ways to set it. `--link` values are added to the configured `linkPaths`.
- `--instruction`, `--lines`, `--test`, `--link`, `--allow-failing-baseline` and `--commit` with any other task type are a `UsageError`.
- stdout: the patch. stderr on success: `patch saved to <path>` and `apply it with: git apply <path>`, or with `--commit`: `committed on branch orch/small-edit-<runId>; your working tree was not changed`.
- `SIGINT` and `SIGTERM` abort the `signal`; the process exits `130` after the workspace is disposed.

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`: `repos` defaults to `{}`; an entry with `testCommand`, `linkPaths` and `testTimeoutMs` loads; a non-string `testCommand` or a non-array `linkPaths` is a `ConfigError`.

`test/run-log.test.ts`: `writeArtifact(id, "change.patch", "x")` returns an absolute path under `<runsDir>/<id>/` whose file contains `x`.

`test/small-edit-run.test.ts`, with `fakeBackend` and a fixture repo (`math.js` exporting `clamp(n, lo, hi)`, `check.mjs` asserting `clamp(5, 0, 3) === 3` and `clamp(-1, 0, 3) === 0`; test command `node check.mjs`; committed):
  - `returns a patch that applies cleanly`: a good replacement gives `patch` containing `diff --git`; `git apply --check` of that patch succeeds in the repository; the repository's status is empty and `git worktree list` has 1 line afterwards.
  - `feeds the test failure into the retry`: replies `[breaks clamp, good]`; two records; the second prompt contains `tests failed`.
  - `rejects before any call when the file has uncommitted changes` *(Review Focus 2)*: `InputError`; the backend saw no prompt; 1 worktree.
  - `stops when the baseline fails`: with a `check.mjs` that fails at `HEAD`, `InputError` matching `/fails before any change/`; no prompt; 1 worktree.
  - `--allow-failing-baseline makes a failing test pass`: `check.mjs` also asserts `clamp(1, 3, 0)` throws; the good reply adds the guard; `ok true`.
  - `commit puts the change on a new branch only`: `branch` matches `/^orch\/small-edit-/`; the repository is still on its original branch at the same commit; the branch's tip changes only `math.js`.
  - `hostile output stays text` *(Review Focus 3)*: the reply is a function body containing `` `$(touch pwned)` `` in a comment and passes the tests; no `pwned` file exists in the repository, the worktree's former location or the current directory.
  - `all tiers fail`: `patch null`, `ok false`, 1 worktree, no new branch.
  - `works with --lines instead of --symbol`; `rejects both and neither`.
  - `an aborted run cleans up` *(Review Focus 1)*: test command `node -e "setInterval(() => {}, 1000)"` with `allowFailingBaseline`, abort after 300 ms; the promise rejects; `git worktree list` has 1 line; status is empty.

`test/cli-small-edit.test.ts`, with `startFakeOllama` and the same fixture:
  - `prints only the patch on stdout`; stderr contains `patch saved to` and `git apply`; exit `0`; the log line has `taskType "small-edit"` and `verify "pass"`.
  - `orch run ... | git apply` end to end: applying stdout in the repository changes `math.js` and `node check.mjs` still passes.
  - `--commit` prints the branch name on stderr.
  - `no test command` exits `2` and names `--test` and `repos`.
  - `config repos supplies the test command and linkPaths`.
  - `--instruction with another task type` exits `2`.
  - `SIGINT mid-run` *(Review Focus 1)*: start the CLI with a hanging test command, send `SIGINT` after the first progress line; exit code `130`; `git worktree list` has 1 line; status is empty.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: orch run --type small-edit`.

### Task 6: Small-edit in the eval set, and the documentation

**Files:**
- Create: `eval/fixed-tasks/se-01-default-parameter/`, `se-02-off-by-one/`, `se-03-empty-input/`, `se-04-rename-parameter/` (each: `task.json` and a `project/` directory)
- Modify: `eval/compare.ts`, `test/eval.test.ts`, `README.md`, `docs/SETUP.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `runSmallEdit` (Task 5).
- Produces: `FixedTask` gains `projectDir?: string`, `testCommand?: string`, `lines?: string`, `allowFailingBaseline?: boolean`; `input.instruction` is filled from `task.json`.

A small-edit `task.json`:

```json
{ "taskType": "small-edit", "inputFile": "greet.js", "symbol": "greet",
  "instruction": "make the name parameter optional, defaulting to \"world\"",
  "testCommand": "node --test", "allowFailingBaseline": true }
```

`project/` holds a tiny JavaScript project: the file to edit and a `node:test` file. `runEval`, for a small-edit task: copy `project/` to a fresh temp directory, `git init`, commit everything (`-c user.name=orch-eval -c user.email=orch-eval@localhost`), then call `runSmallEdit` with `chain: [backend]`, `retryBeforeEscalate: 0`, `decide: () => "stop"`, `mode: "eval"`, `taskId`, `commit: false`. An `InputError` from a task (a broken fixture) is rethrown as `ConfigError` naming the task.

The four tasks, each with tests that fail before the edit and pass after it, except the last:

| id | file and symbol | instruction | tests |
|---|---|---|---|
| `se-01-default-parameter` | `greet.js`, `greet` | make `name` optional, defaulting to `"world"` | fail first |
| `se-02-off-by-one` | `range.js`, `range` | include `end` in the result | fail first |
| `se-03-empty-input` | `average.js`, `average` | return `0` for an empty array instead of `NaN` | fail first |
| `se-04-rename-parameter` | `area.js`, `area` | rename the parameters `a` and `b` to `width` and `height` | pass first and after |

- [ ] **Step 1: Write the failing tests**
  - Update `the fixed task set has 12 well-formed tasks` to 16 tasks, with 4 of type `small-edit`, each having `projectDir`, `testCommand` and an instruction.
  - `each small-edit fixture behaves as declared at HEAD`: for every `se-*` task, running its `testCommand` in a copy of `project/` fails when `allowFailingBaseline` is true and passes otherwise.
  - `runEval runs a small-edit task through the worktree`: with `fakeBackend` replying a correct `greet`, the result for `se-01` is `ok true` and one `eval` record with `taskType "small-edit"` is logged.
  - `runEval scores a wrong edit as verify_failed`: a reply that does not change behaviour gives `reason "verify_failed"`.
  - Update the CLI eval tests: the fake server's JSDoc answer now gives `3/16 passed`, and `--type small-edit` runs 4 tasks.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Write the four fixtures, then implement the `runEval` branch.**
- [ ] **Step 4: Write the documentation.**
  - `README.md`: a section "Editing code (small-edit)" with the command, the two ways to use it (keep tests green; make a failing test pass), `| git apply`, `--commit`, the `repos` config, and the warning that the tests execute model-written code. Update "Rules this project keeps": `orch` never changes your working tree; small-edit works in a temporary worktree and commits only with `--commit`, on a new branch.
  - `docs/SETUP.md`: Part 3 gains step 5, "Let it make a failing test pass", with exact commands; add its line to the not-yet-verified list; add troubleshooting rows for `the test command fails before any change`, `has uncommitted changes` and `could not find the end of`.
  - `CLAUDE.md`: mark M4 as built and add its decisions to "Decisions".
- [ ] **Step 5: Run every command of the new SETUP step** in a temp repository against a stand-in Ollama, as was done for the first tutorial, and fix the text where the output differs.
- [ ] **Step 6: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 7: Commit** — `feat: small-edit in the eval set; docs for M4`.

---

## Not in this plan

- Edits that span several regions or several files.
- A sandbox for the test run.
- Languages beyond JavaScript, TypeScript and Python for `--symbol` (any file works with `--lines`).
- Applying the patch to your working tree for you: that stays one explicit `git apply`.
