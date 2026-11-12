import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InputError } from "../core/types.ts";

// Read-only git queries. Nothing here may modify a repository (writes arrive with M4, on a throwaway branch).

const run = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;

async function git(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new InputError("git is not installed or not on PATH");
    const detail = (e.stderr ?? e.message).trim().split("\n")[0];
    throw new InputError(`git failed in ${repo}: ${detail}`);
  }
}

/** The staged change of a repository: the full diff and its --stat summary. Both empty when nothing is staged. */
export async function stagedDiff(repo: string): Promise<{ stat: string; diff: string }> {
  const base = ["diff", "--staged", "--no-color", "--no-ext-diff"];
  const diff = await git(repo, base);
  const stat = await git(repo, [...base, "--stat"]);
  return { stat, diff };
}
