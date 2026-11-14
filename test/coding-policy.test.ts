import { test } from "node:test";
import assert from "node:assert/strict";
import { codingPolicy } from "../src/agent/coding-toolkit.ts";

const ALLOW = ["git status", "git diff", "git log", "ls", "pwd"];
const policy = (over: Partial<Parameters<typeof codingPolicy>[0]> = {}) => codingPolicy({ allowCommands: ALLOW, onMainBranch: false, ...over });
const command = (text: unknown) => ({ command: text });

test("the reading tools are allowed without asking", async () => {
  for (const tool of ["read_file", "list_dir", "search"]) assert.deepEqual(await policy().check(tool, { path: "src" }), { decision: "allow" });
});

test("a command goes through the command rules", async () => {
  assert.deepEqual(await policy().check("run_command", command("git status")), { decision: "allow" });
  assert.deepEqual(await policy().check("run_command", command("npm test")), { decision: "ask" });
  const refused = await policy().check("run_command", command("rm -rf ."));
  assert.equal(refused.decision, "deny");
  assert.match(refused.decision === "deny" ? refused.reason : "", /rm with -r or -f/);
});

test("a tool the policy does not know is asked, never allowed", async () => {
  for (const tool of ["unlock_door", "write_file", "constructor", ""]) assert.deepEqual(await policy().check(tool, {}), { decision: "ask" });
});

test("the branch and the repository are looked up for every check", async () => {
  let onMain = false;
  let inRepo = true;
  const p = policy({ onMainBranch: () => onMain, gitRepository: async () => inRepo });
  assert.equal((await p.check("run_command", command("git commit -m x"))).decision, "ask");
  onMain = true;
  assert.equal((await p.check("run_command", command("git commit -m x"))).decision, "deny");
  assert.equal((await p.check("run_command", command("git status"))).decision, "allow");
  inRepo = false;
  assert.equal((await p.check("run_command", command("git status"))).decision, "ask");
});

test("a command that is not text has nothing to gate", async () => {
  for (const bad of [42, "", "   ", undefined]) assert.deepEqual(await policy().check("run_command", command(bad)), { decision: "allow" });
});
