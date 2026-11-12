import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runTask } from "../src/core/orchestrator.ts";
import { BackendError, ConfigError, InputError } from "../src/core/types.ts";
import type { Backend, FallbackReason, TaskInput } from "../src/core/types.ts";
import type { RunLog } from "../src/log/run-log.ts";
import { taskModules } from "../src/tasks/task.ts";

/** One task of the fixed set: the same input every time, so models can be compared. */
export interface FixedTask {
  id: string;
  taskType: string;
  input: TaskInput;
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
    let meta: { taskType?: unknown; inputFile?: unknown; symbol?: unknown };
    try {
      meta = JSON.parse(readFileSync(path.join(taskDir, "task.json"), "utf8")) as typeof meta;
    } catch (err) {
      throw new ConfigError(`fixed task ${entry.name}: cannot read task.json (${(err as Error).message})`);
    }
    if (typeof meta.taskType !== "string" || typeof meta.inputFile !== "string") {
      throw new ConfigError(`fixed task ${entry.name}: task.json needs "taskType" and "inputFile"`);
    }
    const input: TaskInput = {
      text: readFileSync(path.join(taskDir, meta.inputFile), "utf8"),
      filePath: meta.inputFile,
    };
    if (typeof meta.symbol === "string") input.symbol = meta.symbol;
    tasks.push({ id: entry.name, taskType: meta.taskType, input });
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
    const outcome = await runTask({
      task: module.prepare(fixed.input, opts.budgetTokens),
      chain: [opts.backend],
      retryBeforeEscalate: 0,
      log: opts.log,
      repo: null,
      mode: "eval",
      taskId: fixed.id,
      decide: () => "stop",
      onProgress: (line) => opts.onProgress?.(`${fixed.id}: ${line}`),
    });
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
