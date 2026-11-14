import { realpathSync } from "node:fs";
import path from "node:path";
import type { RunLog } from "../log/run-log.ts";
import { languageOf } from "../tasks/language.ts";
import { findRegion, parseLineRange, spliceRegion } from "../tasks/region.ts";
import type { Region } from "../tasks/region.ts";
import { smallEdit } from "../tasks/small-edit.ts";
import { createEditWorkspace } from "../workspace/edit-workspace.ts";
import { assertEditable, repoRoot } from "../workspace/git.ts";
import { runTask } from "./orchestrator.ts";
import type { RunOutcome, RunTaskOptions } from "./orchestrator.ts";
import { decideNext } from "./policy.ts";
import { InputError } from "./types.ts";
import type { Backend, VerifyResult } from "./types.ts";
import { failureTail } from "./verifier.ts";

export interface SmallEditResult {
  outcome: RunOutcome;
  /** The change as a patch against HEAD; null when every tier failed. */
  patch: string | null;
  /** Absolute path of runs/<runId>/change.patch. */
  patchFile: string | null;
  /** Set only with commit. */
  branch: string | null;
  /** The worktree's path, when cleanup could not remove it. */
  leftAt?: string;
}

export interface SmallEditOptions {
  repo: string;
  /** Relative to `repo`. */
  file: string;
  symbol?: string;
  lines?: string;
  instruction: string;
  testCommand: string;
  testTimeoutMs: number;
  linkPaths: string[];
  allowFailingBaseline: boolean;
  commit: boolean;
  chain: Backend[];
  retryBeforeEscalate: number;
  budgetTokens: number;
  log: RunLog;
  mode: "run" | "eval";
  taskId?: string;
  decide?: RunTaskOptions["decide"];
  onProgress?: (line: string) => void;
  /** Aborting kills a running test command, removes the worktree and rejects. */
  signal?: AbortSignal;
}

const MAX_SUBJECT_CHARS = 72;

function abortError(): Error {
  const err = new Error("the edit was interrupted");
  err.name = "AbortError";
  return err;
}

/**
 * Ask a model to change one region of one file, and accept the answer only when the project's
 * own tests pass with it. Everything happens in a throwaway worktree: the user's working tree,
 * index and branch are never touched. The model's answer is only ever file content.
 */
export async function runSmallEdit(opts: SmallEditOptions): Promise<SmallEditResult> {
  const { signal, log } = opts;
  if ((opts.symbol === undefined) === (opts.lines === undefined)) {
    throw new InputError("small-edit needs the code to change: pass exactly one of --symbol and --lines");
  }
  let start: string;
  try {
    start = realpathSync(path.resolve(opts.repo));
  } catch {
    throw new InputError(`no such folder: ${opts.repo}`);
  }
  const root = await repoRoot(start);
  const file = path.relative(root, path.resolve(start, opts.file));
  if (file === "" || file.startsWith("..") || path.isAbsolute(file)) {
    throw new InputError(`${opts.file} is not a file inside the repository ${root}`);
  }
  const language = opts.symbol === undefined ? undefined : languageOf(file);
  await assertEditable(root, file);
  if (signal?.aborted) throw abortError();

  const runId = log.newRunId();
  const ws = await createEditWorkspace({
    repoRoot: root,
    id: runId,
    testCommand: opts.testCommand,
    testTimeoutMs: opts.testTimeoutMs,
    linkPaths: opts.linkPaths,
    signal,
  });
  const timeoutSeconds = Math.round(opts.testTimeoutMs / 1000);

  async function work(): Promise<Omit<SmallEditResult, "leftAt">> {
    const source = ws.read(file);
    let region: Region;
    if (opts.symbol !== undefined) region = findRegion(source, language!, opts.symbol);
    else region = parseLineRange(opts.lines!, source.replace(/\r?\n$/, "").split("\n").length);
    const task = smallEdit.prepare(
      { text: source, filePath: file, symbol: opts.symbol, instruction: opts.instruction, region },
      opts.budgetTokens,
    );

    opts.onProgress?.(`running the tests before any change: ${opts.testCommand}`);
    const baseline = await ws.test();
    if (signal?.aborted) throw abortError();
    if (!baseline.ok && !opts.allowFailingBaseline) {
      const how = baseline.timedOut ? `timed out after ${timeoutSeconds} s` : `exit ${baseline.exitCode ?? "unknown"}`;
      throw new InputError(
        `the test command fails before any change (${how}). Fix the tests first, or pass --allow-failing-baseline if the edit is meant to make them pass.\n${failureTail(baseline.output)}`,
      );
    }
    opts.onProgress?.(baseline.ok ? "the tests pass before the change" : "the tests fail before the change (allowed)");

    const verify = async (answer: string): Promise<VerifyResult> => {
      const format = task.verify(answer);
      if (format.status === "fail") return format;
      // After an interruption the worktree is gone: nothing is written and nothing runs.
      if (signal?.aborted) return { status: "fail", detail: "interrupted" };
      ws.write(file, spliceRegion(source, region, answer));
      const tests = await ws.test();
      if (tests.ok) return { status: "pass", detail: "" };
      if (tests.timedOut) return { status: "fail", detail: `tests timed out after ${timeoutSeconds} s` };
      return { status: "fail", detail: `tests failed (exit ${tests.exitCode ?? "unknown"}):\n${failureTail(tests.output)}` };
    };
    const decide = opts.decide ?? decideNext;
    const outcome = await runTask({
      task: { ...task, verify },
      chain: opts.chain,
      retryBeforeEscalate: opts.retryBeforeEscalate,
      log,
      repo: root,
      mode: opts.mode,
      taskId: opts.taskId,
      runId,
      onProgress: opts.onProgress,
      // An interrupted run makes no further model call.
      decide: (state) => (signal?.aborted ? "stop" : decide(state)),
    });
    if (signal?.aborted) throw abortError();
    if (!outcome.ok) return { outcome, patch: null, patchFile: null, branch: null };

    const patch = await ws.diff(file);
    const patchFile = log.writeArtifact(runId, "change.patch", patch);
    let branch: string | null = null;
    if (opts.commit) {
      branch = `orch/small-edit-${runId}`;
      const subject = `orch: ${opts.instruction.replace(/\s+/g, " ").trim()}`.slice(0, MAX_SUBJECT_CHARS).trimEnd();
      await ws.commit(file, branch, subject);
    }
    return { outcome, patch, patchFile, branch };
  }

  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  // Both are raced below; whichever loses must not become an unhandled rejection.
  interrupted.catch(() => {});
  const working = work();
  working.catch(() => {});

  let result: Omit<SmallEditResult, "leftAt">;
  try {
    // An interruption does not wait for a model call that is in flight.
    result = await Promise.race([working, interrupted]);
  } catch (err) {
    await ws.dispose();
    throw err;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
  const { leftAt } = await ws.dispose();
  return leftAt === undefined ? result : { ...result, leftAt };
}
