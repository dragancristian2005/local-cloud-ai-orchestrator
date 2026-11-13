import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AttemptRecord } from "../core/types.ts";

/** Append-only record of every attempt: one JSON line per attempt, plus the raw model output per attempt. */
export class RunLog {
  private readonly runsDir: string;
  private readonly logFile: string;

  constructor(runsDir: string) {
    this.runsDir = runsDir;
    this.logFile = path.join(runsDir, "log.jsonl");
  }

  /** "YYYYMMDD-HHMMSS-xxxxxx" (UTC), so run directories sort by time. */
  newRunId(): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    return `${stamp}-${randomBytes(3).toString("hex")}`;
  }

  /** Save one attempt's raw output. Returns its path as logged: "<runs dir name>/<runId>/tier<T>-attempt<A>.txt". */
  writeOutput(runId: string, tier: number, attempt: number, text: string): string {
    const name = `tier${tier}-attempt${attempt}.txt`;
    mkdirSync(path.join(this.runsDir, runId), { recursive: true });
    writeFileSync(path.join(this.runsDir, runId, name), text);
    return [path.basename(this.runsDir), runId, name].join("/");
  }

  /** Append one line to a file in a run's directory. Returns its path as logged: "<runs dir name>/<runId>/<name>". */
  appendArtifact(runId: string, name: string, line: string): string {
    mkdirSync(path.join(this.runsDir, runId), { recursive: true });
    appendFileSync(path.join(this.runsDir, runId, name), line + "\n");
    return [path.basename(this.runsDir), runId, name].join("/");
  }

  append(rec: AttemptRecord): void {
    mkdirSync(this.runsDir, { recursive: true });
    appendFileSync(this.logFile, JSON.stringify(rec) + "\n");
  }

  /** Every complete record, oldest first. Lines that are not valid JSON (a write cut short) are skipped. */
  readAll(): AttemptRecord[] {
    if (!existsSync(this.logFile)) return [];
    const records: AttemptRecord[] = [];
    for (const line of readFileSync(this.logFile, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        records.push(JSON.parse(line) as AttemptRecord);
      } catch {
        // skip
      }
    }
    return records;
  }
}
