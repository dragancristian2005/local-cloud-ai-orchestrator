import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempRepo } from "./helpers/temp-repo.ts";

const SCRIPT = path.resolve(import.meta.dirname, "../.claude/scripts/security-review.ts");

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
}

async function repoWithCommit(): Promise<string> {
  const repo = await makeTempRepo({ "a.txt": "one\n" }, { stage: true });
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

function commitAnother(repo: string): void {
  writeFileSync(path.join(repo, "a.txt"), `changed ${Date.now()}\n`);
  git(repo, "commit", "-q", "-am", "another");
}

/** Run the hook the way Claude Code does: the tool call as JSON on stdin. */
function check(repo: string, toolName: string, toolInput: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [SCRIPT, "check"], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: repo }),
    encoding: "utf8",
  });
  return { code: result.status, stderr: result.stderr };
}

function record(repo: string, status: string, report?: string) {
  const args = [SCRIPT, "record", status];
  if (report !== undefined) {
    const file = path.join(repo, "..", `report-${Date.now()}.md`);
    writeFileSync(file, report);
    args.push("--report", file);
  }
  return spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8" });
}

const GH_PR = { command: "gh pr create --title x --body y" };

test("tool calls that do not open a pull request pass", async () => {
  const repo = await repoWithCommit();
  assert.equal(check(repo, "Bash", { command: "git status" }).code, 0);
  assert.equal(check(repo, "Read", { file_path: "a.txt" }).code, 0);
});

test("opening a pull request without a review of the commit is blocked", async () => {
  const repo = await repoWithCommit();
  const viaGh = check(repo, "Bash", GH_PR);
  assert.equal(viaGh.code, 2);
  assert.match(viaGh.stderr, /\/security-review/);
  assert.equal(check(repo, "mcp__github__create_pull_request", { owner: "o", repo: "r", head: "master", base: "main" }).code, 2);
});

test("a clean review of the exact commit lets the pull request through", async () => {
  const repo = await repoWithCommit();
  assert.equal(record(repo, "clean", "No findings.").status, 0);
  assert.equal(check(repo, "Bash", GH_PR).code, 0);
});

test("a new commit after the review needs its own review", async () => {
  const repo = await repoWithCommit();
  record(repo, "clean");
  commitAnother(repo);
  assert.equal(check(repo, "Bash", GH_PR).code, 2);
});

test("a review that found something keeps the pull request blocked and says to tell the user", async () => {
  const repo = await repoWithCommit();
  record(repo, "findings", "1. command injection in x.ts");
  const result = check(repo, "Bash", GH_PR);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /tell the user/i);
});

test("the branch named in the pull request is the one that must be reviewed", async () => {
  const repo = await repoWithCommit();
  const current = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  git(repo, "switch", "-q", "-c", "feature");
  commitAnother(repo);
  git(repo, "switch", "-q", current);
  record(repo, "clean"); // reviews the current branch, not "feature"
  assert.equal(check(repo, "mcp__github__create_pull_request", { head: "feature", base: current }).code, 2);
  assert.equal(check(repo, "Bash", { command: "gh pr create --head feature --fill" }).code, 2);
  assert.equal(check(repo, "mcp__github__create_pull_request", { head: `someone:${current}`, base: "main" }).code, 0);
});

test("a branch that cannot be found blocks instead of passing", async () => {
  const repo = await repoWithCommit();
  record(repo, "clean");
  const result = check(repo, "mcp__github__create_pull_request", { head: "no-such-branch", base: "main" });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no-such-branch/);
});

test("recording rejects anything but clean or findings", async () => {
  const repo = await repoWithCommit();
  assert.notEqual(record(repo, "maybe").status, 0);
  assert.equal(check(repo, "Bash", GH_PR).code, 2);
});
