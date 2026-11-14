import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runCommand } from "../core/command.ts";
import type { CommandResult } from "../core/command.ts";
import { ConfigError, InputError } from "../core/types.ts";

// The only place orch writes with git. Every write happens inside a worktree created here, in the
// temp directory; the user's working tree, index and branch are never touched. Nothing is forced:
// no --force, no recursive delete.

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const text = [e.stderr, e.stdout, e.message].find((part) => typeof part === "string" && part.trim() !== "") ?? "unknown error";
  return text.trim().split("\n")[0]!;
}

/** A copy of the repository at HEAD where an edit can be written and tested. */
export interface EditWorkspace {
  dir: string;
  /** `file` is relative to the repository root. */
  read(file: string): string;
  write(file: string, content: string): void;
  /** Run the user's test command in the worktree. */
  test(): Promise<CommandResult>;
  diff(file: string): Promise<string>;
  /** Commit the one file on a new branch. The user's own branch does not move. */
  commit(file: string, branch: string, message: string): Promise<void>;
  /** Undo and remove the worktree. Never forces: a worktree git will not remove is left where it is. */
  dispose(): Promise<{ removed: boolean; leftAt?: string }>;
}

export async function createEditWorkspace(opts: {
  repoRoot: string;
  id: string;
  testCommand: string;
  testTimeoutMs: number;
  linkPaths: string[];
  /** Passed to every test run. */
  signal?: AbortSignal;
}): Promise<EditWorkspace> {
  if (!/^[\w.-]+$/.test(opts.id)) throw new InputError(`not a usable workspace id: ${opts.id}`);
  for (const link of opts.linkPaths) {
    if (link.trim() === "" || path.isAbsolute(link) || link.split(/[\\/]/).includes("..")) {
      throw new ConfigError(`linkPaths entries must be relative paths inside the repository (got "${link}")`);
    }
  }

  const dir = path.join(tmpdir(), `orch-edit-${opts.id}`);
  try {
    await git(opts.repoRoot, ["worktree", "add", "--detach", dir, "HEAD"]);
  } catch (err) {
    throw new InputError(`could not create a worktree for the edit: ${firstLine(err)}`);
  }
  const realDir = realpathSync(dir);

  // Dependencies are ignored files, so a fresh worktree does not have them.
  const links: string[] = [];
  for (const link of opts.linkPaths) {
    const source = path.join(opts.repoRoot, link);
    const target = path.join(dir, link);
    if (!existsSync(source) || existsSync(target)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(source, target);
    links.push(target);
  }

  /** The absolute path of a repository file inside the worktree. Refuses anything that leaves it. */
  const inside = (file: string): string => {
    const full = path.resolve(dir, file);
    const relative = path.relative(dir, full);
    const leaves = path.isAbsolute(file) || relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
    if (leaves) throw new InputError(`${file} is not a file inside the repository`);
    // A linked directory points into the user's checkout: nothing is read or written through it by accident.
    let parent: string;
    try {
      parent = realpathSync(path.dirname(full));
    } catch {
      throw new InputError(`${file} is not a file inside the repository`);
    }
    return parent === realDir || parent.startsWith(realDir + path.sep) ? full : "";
  };

  const originals = new Map<string, string | null>();
  let committed = false;
  let disposed: Promise<{ removed: boolean; leftAt?: string }> | undefined;

  async function remove(): Promise<{ removed: boolean; leftAt?: string }> {
    if (!committed) {
      for (const [full, content] of originals) {
        if (content !== null) writeFileSync(full, content);
        else if (existsSync(full)) unlinkSync(full);
      }
    }
    // A symlink named node_modules is not matched by the ignore rule "node_modules/", so it would
    // count as untracked and block the removal.
    for (const link of links) {
      try {
        unlinkSync(link);
      } catch {
        // already gone
      }
    }
    try {
      await git(opts.repoRoot, ["worktree", "remove", dir]);
      return { removed: true };
    } catch {
      return { removed: false, leftAt: dir };
    }
  }

  return {
    dir,
    read(file) {
      const full = inside(file);
      // Reading through a link is harmless and lets a caller look at a dependency.
      try {
        return readFileSync(full === "" ? path.resolve(dir, file) : full, "utf8");
      } catch {
        throw new InputError(`cannot read ${file}`);
      }
    },
    write(file, content) {
      const full = inside(file);
      if (full === "") throw new InputError(`${file} is inside a linked directory and cannot be edited`);
      // A symlink would be followed, and may point outside the worktree.
      if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) throw new InputError(`${file} is a symbolic link and cannot be edited`);
      if (!originals.has(full)) originals.set(full, existsSync(full) ? readFileSync(full, "utf8") : null);
      writeFileSync(full, content);
    },
    test: () => runCommand(opts.testCommand, { cwd: dir, timeoutMs: opts.testTimeoutMs, signal: opts.signal }),
    // Fixed prefixes: the patch must apply with a plain `git apply` whatever diff.noprefix says.
    diff: (file) => git(dir, ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--", file]),
    async commit(file, branch, message) {
      try {
        await git(dir, ["switch", "-c", branch]);
        await git(dir, ["add", "--", file]);
        await git(dir, ["commit", "-m", message]);
      } catch (err) {
        throw new InputError(`git commit failed: ${firstLine(err)}`);
      }
      committed = true;
    },
    dispose() {
      disposed ??= remove();
      return disposed;
    },
  };
}
