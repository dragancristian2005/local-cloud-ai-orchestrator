import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Create a throwaway git repository under the system temp directory and return its path. */
export async function makeTempRepo(
  files: Record<string, string>,
  opts: { stage?: boolean; dirName?: string } = {},
): Promise<string> {
  const parent = mkdtempSync(path.join(tmpdir(), "orch-repo-"));
  const repo = opts.dirName ? path.join(parent, opts.dirName) : parent;
  mkdirSync(repo, { recursive: true });
  await run("git", ["-C", repo, "init", "-q"]);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(repo, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  if (opts.stage) await run("git", ["-C", repo, "add", "-A"]);
  return repo;
}

/** A plain directory that is not a git repository. */
export function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "orch-dir-"));
}
