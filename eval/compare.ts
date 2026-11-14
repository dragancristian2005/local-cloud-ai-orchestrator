import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runTask } from "../src/core/orchestrator.ts";
import type { RunOutcome } from "../src/core/orchestrator.ts";
import { runSmallEdit } from "../src/core/small-edit-run.ts";
import { BackendError, ConfigError, InputError } from "../src/core/types.ts";
import type { Backend, FallbackReason, TaskInput } from "../src/core/types.ts";
import type { RunLog } from "../src/log/run-log.ts";
import { taskModules } from "../src/tasks/task.ts";

/** One task of the fixed set: the same input every time, so models can be compared. */
export interface FixedTask {
  id: string;
  taskType: string;
  input: TaskInput;
  /** small-edit: the tiny project the edit is made in and tested against. */
  projectDir?: string;
  testCommand?: string;
  /** small-edit: the lines to change, instead of the symbol. */
  lines?: string;
  /** small-edit: the tests fail before the edit, and the edit should make them pass. */
  allowFailingBaseline?: boolean;
}

const exec = promisify(execFile);
const EVAL_TEST_TIMEOUT_MS = 60_000;

/** A fresh, committed copy of a fixture project, so the edit has a HEAD to start from. */
async function projectCopy(fixed: FixedTask): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "orch-eval-"));
  cpSync(fixed.projectDir!, repo, { recursive: true });
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "-q");
  await git("add", "-A");
  await git("-c", "user.name=orch-eval", "-c", "user.email=orch-eval@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  return repo;
}

export interface EvalResult {
  id: string;
  ok: boolean;
  reason: FallbackReason | null;
  durationMs: number;
}

/** Load every `<dir>/<id>/task.json` with its input file. Sorted by id. */
export function loadFixedTasks(dir: string): FixedTask[] {
  if (!existsSync(dir)) throw new ConfigError(`fixed task directory not found: ${dir}`);
  const tasks: FixedTask[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDir = path.join(dir, entry.name);
    let meta: {
      taskType?: unknown; inputFile?: unknown; symbol?: unknown; instruction?: unknown;
      testCommand?: unknown; lines?: unknown; allowFailingBaseline?: unknown;
    };
    try {
      meta = JSON.parse(readFileSync(path.join(taskDir, "task.json"), "utf8")) as typeof meta;
    } catch (err) {
      throw new ConfigError(`fixed task ${entry.name}: cannot read task.json (${(err as Error).message})`);
    }
    if (typeof meta.taskType !== "string" || typeof meta.inputFile !== "string") {
      throw new ConfigError(`fixed task ${entry.name}: task.json needs "taskType" and "inputFile"`);
    }
    const isEdit = meta.taskType === "small-edit";
    const sourceDir = isEdit ? path.join(taskDir, "project") : taskDir;
    let text: string;
    try {
      text = readFileSync(path.join(sourceDir, meta.inputFile), "utf8");
    } catch {
      throw new ConfigError(`fixed task ${entry.name}: cannot read ${meta.inputFile}`);
    }
    const input: TaskInput = { text, filePath: meta.inputFile };
    if (typeof meta.symbol === "string") input.symbol = meta.symbol;
    const task: FixedTask = { id: entry.name, taskType: meta.taskType, input };
    if (isEdit) {
      if (typeof meta.instruction !== "string" || typeof meta.testCommand !== "string") {
        throw new ConfigError(`fixed task ${entry.name}: a small-edit task.json needs "instruction" and "testCommand"`);
      }
      input.instruction = meta.instruction;
      task.projectDir = sourceDir;
      task.testCommand = meta.testCommand;
      if (typeof meta.lines === "string") task.lines = meta.lines;
      if (meta.allowFailingBaseline === true) task.allowFailingBaseline = true;
    }
    tasks.push(task);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Run the fixed tasks against one backend: one attempt each, no retry, no escalation, so the
 * numbers measure the model's first answer. Stops as soon as the PC is unreachable or the backend
 * reports an error, so an outage or a mistyped model name does not turn into a column of failures.
 */
export async function runEval(opts: {
  backend: Backend;
  tasks: FixedTask[];
  budgetTokens: number;
  log: RunLog;
  onProgress?: (line: string) => void;
}): Promise<EvalResult[]> {
  if (opts.backend.kind === "cloud") {
    throw new InputError("eval refuses cloud backends: no bulk runs against the subscription");
  }
  if (!(await opts.backend.healthCheck())) {
    throw new BackendError("pc_unreachable", `${opts.backend.name} is unreachable; nothing was run or logged`);
  }
  const results: EvalResult[] = [];
  for (const fixed of opts.tasks) {
    const module = taskModules[fixed.taskType];
    if (!module) throw new ConfigError(`fixed task ${fixed.id}: unknown task type ${fixed.taskType}`);
    const onProgress = (line: string) => opts.onProgress?.(`${fixed.id}: ${line}`);
    let outcome: RunOutcome;
    if (fixed.taskType === "small-edit") {
      try {
        const edit = await runSmallEdit({
          repo: await projectCopy(fixed),
          file: fixed.input.filePath!,
          symbol: fixed.lines === undefined ? fixed.input.symbol : undefined,
          lines: fixed.lines,
          instruction: fixed.input.instruction!,
          testCommand: fixed.testCommand!,
          testTimeoutMs: EVAL_TEST_TIMEOUT_MS,
          linkPaths: [],
          allowFailingBaseline: fixed.allowFailingBaseline ?? false,
          commit: false,
          chain: [opts.backend],
          retryBeforeEscalate: 0,
          budgetTokens: opts.budgetTokens,
          log: opts.log,
          mode: "eval",
          taskId: fixed.id,
          decide: () => "stop",
          onProgress,
        });
        outcome = edit.outcome;
      } catch (err) {
        // A fixture whose tests do not behave as declared is a mistake in the fixed set, not a model result.
        if (err instanceof InputError) throw new ConfigError(`fixed task ${fixed.id}: ${err.message}`);
        throw err;
      }
    } else {
      outcome = await runTask({
        task: module.prepare(fixed.input, opts.budgetTokens),
        chain: [opts.backend],
        retryBeforeEscalate: 0,
        log: opts.log,
        repo: null,
        mode: "eval",
        taskId: fixed.id,
        decide: () => "stop",
        onProgress,
      });
    }
    const last = outcome.attempts.at(-1);
    const reason = last?.fallbackReason ?? null;
    results.push({ id: fixed.id, ok: outcome.ok, reason, durationMs: last?.durationMs ?? 0 });
    // Not the model's fault and not going to change for the next task: an outage, or a model
    // that is not pulled. Stop instead of logging a row of identical failures.
    if (reason === "pc_unreachable" || reason === "backend_error") break;
  }
  return results;
}

/** The result table `orch eval` prints. */
export function formatEvalTable(results: EvalResult[]): string {
  const width = Math.max(4, ...results.map((r) => r.id.length));
  const rows = results.map((r) => `${r.id.padEnd(width)}  ${(r.reason ?? "pass").padEnd(14)}  ${String(r.durationMs).padStart(7)}`);
  const header = `${"task".padEnd(width)}  ${"result".padEnd(14)}  ${"ms".padStart(7)}`;
  const passed = results.filter((r) => r.ok).length;
  return [header, ...rows, `${passed}/${results.length} passed`].join("\n") + "\n";
}
