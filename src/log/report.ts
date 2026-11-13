import type { AttemptRecord } from "../core/types.ts";

/** One line of the report: how one model on one backend has done so far. */
export interface ModelRow {
  backend: string;
  model: string;
  /** Attempts that reached the backend. Attempts lost to an unreachable PC are not counted here. */
  attempts: number;
  /** Share of `attempts` whose answer was accepted. A timeout counts against the model. */
  passRate: number;
  /** Share of `orch run` runs in which this model's tier handed over to a stronger one. Null without run records. */
  escalationRate: number | null;
  avgMs: number;
  /** Attempts skipped because the PC was off or asleep. Kept apart so outages do not look like bad answers. */
  unreachable: number;
}

export interface ReportFilter {
  /** Without a mode, task runs and eval runs are shown and chat turns are left out. */
  mode?: "run" | "eval" | "chat";
  taskType?: string;
}

export function summarize(records: AttemptRecord[], filter: ReportFilter = {}): ModelRow[] {
  const groups = new Map<string, AttemptRecord[]>();
  for (const rec of records) {
    if (filter.mode === undefined ? rec.mode === "chat" : rec.mode !== filter.mode) continue;
    if (filter.taskType !== undefined && rec.taskType !== filter.taskType) continue;
    const key = `${rec.backend}\u0000${rec.model}`;
    const group = groups.get(key);
    if (group) group.push(rec);
    else groups.set(key, [rec]);
  }

  const rows: ModelRow[] = [];
  for (const group of groups.values()) {
    const counted = group.filter((rec) => rec.fallbackReason !== "pc_unreachable");
    const passed = counted.filter((rec) => rec.fallbackReason === null).length;
    // The unit that can escalate: one `orch run`, or one turn of a chat session.
    const unit = (rec: AttemptRecord) => (rec.mode === "chat" ? `${rec.runId}/${rec.taskId}` : rec.runId);
    const runRecords = counted.filter((rec) => rec.mode !== "eval");
    const runs = new Set(runRecords.map(unit));
    const escalatedRuns = new Set(runRecords.filter((rec) => rec.escalated).map(unit));
    rows.push({
      backend: group[0]!.backend,
      model: group[0]!.model,
      attempts: counted.length,
      passRate: counted.length === 0 ? 0 : passed / counted.length,
      escalationRate: runs.size === 0 ? null : escalatedRuns.size / runs.size,
      avgMs: counted.length === 0 ? 0 : counted.reduce((sum, rec) => sum + rec.durationMs, 0) / counted.length,
      unreachable: group.length - counted.length,
    });
  }
  // Best pass rate first; models that were never reached go last.
  return rows.sort(
    (a, b) =>
      Number(b.attempts > 0) - Number(a.attempts > 0) ||
      b.passRate - a.passRate ||
      `${a.backend} ${a.model}`.localeCompare(`${b.backend} ${b.model}`),
  );
}

const HEADER = ["backend", "model", "attempts", "pass %", "escalated %", "avg s", "pc down"];

function percent(rate: number): string {
  return String(Math.round(rate * 100));
}

export function formatTable(rows: ModelRow[]): string {
  const cells = rows.map((row) => [
    row.backend,
    row.model,
    String(row.attempts),
    row.attempts === 0 ? "-" : percent(row.passRate),
    row.escalationRate === null ? "-" : percent(row.escalationRate),
    row.attempts === 0 ? "-" : (row.avgMs / 1000).toFixed(1),
    String(row.unreachable),
  ]);
  const widths = HEADER.map((title, col) => Math.max(title.length, ...cells.map((row) => row[col]!.length)));
  // Names are left-aligned, numbers right-aligned.
  const line = (row: string[]) =>
    row.map((cell, col) => (col < 2 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!))).join("  ");
  return [HEADER, ...cells].map(line).join("\n") + "\n";
}
