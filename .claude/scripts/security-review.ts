// A gate in front of pull requests: one security review per proposed commit.
//
//   node .claude/scripts/security-review.ts check
//     PreToolUse hook. Reads the tool call from stdin. When the call opens a pull request, it is
//     blocked (exit 2) unless a review with no findings is recorded for the commit the pull
//     request would contain.
//
//   node .claude/scripts/security-review.ts record <clean|findings> [--report <file>]
//     Records the result of /security-review for the current commit (HEAD).
//
// Results live in the repository's git directory, never in the working tree, so they are not
// committed. A new commit has no result, so every change is reviewed before its pull request.
// The gate checks that a review was recorded; what the review found is up to the reviewer.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Status = "clean" | "findings";
interface ReviewRecord {
  status: Status;
  commit: string;
  reviewedAt: string;
  report: string | null;
}

const RECORD_COMMAND = "node .claude/scripts/security-review.ts record";

class Blocked extends Error {}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryCommit(cwd: string, ref: string): string | null {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

function resultsDir(cwd: string): string {
  // --git-path works in linked worktrees too.
  return path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", "orch-security-review"]));
}

/**
 * The branch a pull request would be opened from, or null for the current branch. Only the
 * pull-request tools count: the GitHub MCP tool, and `gh pr create` run through Bash.
 */
function pullRequestHead(toolName: string, toolInput: Record<string, unknown>): { head: string | null } | null {
  if (/(^|__)create_pull_request$/.test(toolName)) {
    const head = typeof toolInput.head === "string" ? toolInput.head : "";
    // "owner:branch" names a branch in a fork; the branch name is what is looked up here.
    return { head: head === "" ? null : head.slice(head.indexOf(":") + 1) };
  }
  if (toolName === "Bash" && typeof toolInput.command === "string" && /\bgh\s+pr\s+create\b/.test(toolInput.command)) {
    const flag = /(?:--head|-H)(?:=|\s+)(\S+)/.exec(toolInput.command);
    return { head: flag?.[1]?.replace(/^["']|["']$/g, "") ?? null };
  }
  return null;
}

/** The commit the pull request would contain. The pushed branch wins: it is what GitHub sees. */
function proposedCommit(cwd: string, head: string | null): { commit: string; label: string } {
  if (head === null) {
    const commit = tryCommit(cwd, "HEAD");
    if (commit === null) throw new Blocked("the repository has no commit to open a pull request from");
    return { commit, label: "the current branch" };
  }
  const commit = tryCommit(cwd, `refs/remotes/origin/${head}`) ?? tryCommit(cwd, `refs/heads/${head}`);
  if (commit === null) throw new Blocked(`branch "${head}" was not found locally or on origin, so its commit cannot be checked`);
  return { commit, label: `branch "${head}"` };
}

function check(input: string): void {
  let call: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  try {
    call = JSON.parse(input) as typeof call;
  } catch {
    throw new Blocked("the hook could not read the tool call, so it cannot tell whether it opens a pull request");
  }
  const toolInput = typeof call.tool_input === "object" && call.tool_input !== null ? (call.tool_input as Record<string, unknown>) : {};
  const pr = pullRequestHead(typeof call.tool_name === "string" ? call.tool_name : "", toolInput);
  if (pr === null) return;

  const cwd = typeof call.cwd === "string" ? call.cwd : process.cwd();
  const { commit, label } = proposedCommit(cwd, pr.head);
  const short = commit.slice(0, 7);
  const file = path.join(resultsDir(cwd), `${commit}.json`);
  if (!existsSync(file)) {
    throw new Blocked(
      `no security review is recorded for commit ${short} (${label}).\n` +
        `Run /security-review on this branch first.\n` +
        `- If it reports anything: run \`${RECORD_COMMAND} findings --report <file with the report>\`, then STOP. ` +
        `Tell the user what it found and do not open the pull request or fix anything until they say so.\n` +
        `- If it reports nothing: run \`${RECORD_COMMAND} clean --report <file with the report>\` and open the pull request again.`,
    );
  }
  const result = JSON.parse(readFileSync(file, "utf8")) as ReviewRecord;
  if (result.status !== "clean") {
    throw new Blocked(
      `the security review of commit ${short} (${label}) found issues` +
        (result.report ? ` (report: ${result.report})` : "") +
        `.\nSTOP and tell the user what it found. Once the fixes are committed, the new commit needs its own review.`,
    );
  }
}

function record(args: string[]): void {
  const [status, flag, report] = args;
  if (status !== "clean" && status !== "findings") throw new Error(`usage: ${RECORD_COMMAND} <clean|findings> [--report <file>]`);
  if (flag !== undefined && (flag !== "--report" || report === undefined)) throw new Error(`usage: ${RECORD_COMMAND} <clean|findings> [--report <file>]`);

  const cwd = process.cwd();
  const commit = tryCommit(cwd, "HEAD");
  if (commit === null) throw new Error("there is no commit to record a review for");
  const dir = resultsDir(cwd);
  mkdirSync(dir, { recursive: true });
  let kept: string | null = null;
  if (report !== undefined) {
    kept = path.join(dir, `${commit}.report.md`);
    copyFileSync(report, kept);
  }
  const entry: ReviewRecord = { status, commit, reviewedAt: new Date().toISOString(), report: kept };
  writeFileSync(path.join(dir, `${commit}.json`), JSON.stringify(entry, null, 2) + "\n");
  process.stdout.write(`recorded: security review of ${commit.slice(0, 7)} is ${status}\n`);
}

const [mode, ...rest] = process.argv.slice(2);
try {
  if (mode === "check") check(readFileSync(0, "utf8"));
  else if (mode === "record") record(rest);
  else throw new Error("usage: security-review.ts check | record <clean|findings> [--report <file>]");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (mode === "check") {
    // Exit code 2 blocks the tool call and shows the message to Claude. Anything unexpected
    // blocks too: a gate that fails open is not a gate.
    process.stderr.write(`Pull request blocked: ${err instanceof Blocked ? message : `the security gate failed: ${message}`}\n`);
    process.exit(2);
  }
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
