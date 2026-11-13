import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InputError } from "../core/types.ts";

// Read-only git queries. Nothing here may modify a repository (writes arrive with M4, on a throwaway branch).

const run = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;

async function git(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", repo, ...args], {
      maxBuffer: MAX_BUFFER,
      // Reading must not touch the repository: no opportunistic index refresh.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new InputError("git is not installed or not on PATH");
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new InputError(`the staged diff in ${repo} is larger than 20 MB: unstage generated files and try again`);
    }
    const detail = (e.stderr || e.message).trim().split("\n")[0];
    throw new InputError(`git failed in ${repo}: ${detail}`);
  }
}

/** The staged change of a repository: the full diff and its --stat summary. Both empty when nothing is staged. */
export async function stagedDiff(repo: string): Promise<{ stat: string; diff: string }> {
  // Outside a repository `git diff` falls back to comparing files and reports a confusing option error.
  try {
    await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new InputError(`not a git repository: ${repo}`);
  }
  const base = ["diff", "--staged", "--no-color", "--no-ext-diff"];
  const diff = await git(repo, base);
  const stat = await git(repo, [...base, "--stat"]);
  return { stat, diff };
}

/** The branch checked out in a directory, or null outside a repository or on a detached HEAD. */
export async function currentBranch(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}
