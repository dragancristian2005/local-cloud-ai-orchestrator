import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanModelOutput, taskModules } from "../src/tasks/task.ts";
import { commitMessage, isImperativeish } from "../src/tasks/commit-message.ts";

const task = commitMessage.prepare({ text: "DIFF", stat: "STAT" }, 6000);

function verify(output: string) {
  assert.ok(task.verify);
  return task.verify(output);
}

test("cleanModelOutput removes a think block", () => {
  assert.equal(cleanModelOutput("<think>hmm</think>\nAdd x"), "Add x");
});

test("cleanModelOutput removes an unclosed leading think paragraph", () => {
  assert.equal(cleanModelOutput("<think>hmm, what changed\nstill thinking\n\nAdd x"), "Add x");
});

test("cleanModelOutput unwraps a single code fence", () => {
  assert.equal(cleanModelOutput("```\nAdd x\n```"), "Add x");
  assert.equal(cleanModelOutput("```text\nAdd x\n\nBody\n```"), "Add x\n\nBody");
});

test("cleanModelOutput removes quotes around a single line", () => {
  assert.equal(cleanModelOutput('"Add x"'), "Add x");
  assert.equal(cleanModelOutput("`Add x`"), "Add x");
});

test("cleanModelOutput leaves a clean message alone", () => {
  assert.equal(cleanModelOutput("Add x\n\nBody"), "Add x\n\nBody");
});

test("normalize drops a chatty first line", () => {
  assert.equal(task.normalize("Here is the commit message:\nAdd x"), "Add x");
  assert.equal(task.normalize("Sure! Here's the commit message:\n\n```\nAdd x\n```"), "Add x");
});

test("verify passes a plain imperative subject", () => {
  assert.deepEqual(verify("Add retry to fetch helper"), { status: "pass", detail: "" });
});

test("verify passes a conventional subject with a body", () => {
  assert.deepEqual(verify("fix: handle empty diff\n\nThe CLI crashed."), { status: "pass", detail: "" });
});

test("verify fails an empty answer", () => {
  assert.equal(verify("").status, "fail");
});

test("verify fails a 73-character subject and says how long it is", () => {
  const subject = "Add " + "x".repeat(69);
  assert.equal(subject.length, 73);
  assert.deepEqual(verify(subject), { status: "fail", detail: "subject is 73 chars (max 72)" });
});

test("verify accepts a 72-character subject", () => {
  assert.equal(verify("Add " + "x".repeat(68)).status, "pass");
});

test("verify fails a subject ending with a period", () => {
  assert.match(verify("Add x.").detail, /period/);
});

test("verify fails a body that is not separated by a blank line", () => {
  assert.match(verify("Add x\nbody without blank line").detail, /blank/);
});

test("verify fails an answer that still explains itself", () => {
  assert.equal(verify("This commit adds a retry").status, "fail");
});

test("isImperativeish accepts imperative subjects", () => {
  assert.equal(isImperativeish("Add retry to fetch"), true);
  assert.equal(isImperativeish("fix: handle empty diff"), true);
  assert.equal(isImperativeish("feat(cli): add --model flag"), true);
});

test("isImperativeish rejects past, third-person and -ing subjects", () => {
  assert.equal(isImperativeish("Added retry"), false);
  assert.equal(isImperativeish("Fixes bug"), false);
  assert.equal(isImperativeish("Adding tests"), false);
  assert.equal(isImperativeish("feat(cli): adds flag"), false);
});

test("isImperativeish accepts imperative verbs that only look inflected", () => {
  for (const subject of ["Embed fonts in the PDF", "Bring back the --force flag", "Pass options through", "Address review comments", "Focus the input on open", "Process the queue in order", "Alias the old command"]) {
    assert.equal(isImperativeish(subject), true, subject);
  }
});

test("isImperativeish rejects other common non-imperative openings", () => {
  for (const subject of ["Updates readme", "Refactored the parser", "Removing dead code", "docs: updated the guide", "Tests for the parser"]) {
    assert.equal(isImperativeish(subject), false, subject);
  }
});

test("isImperativeish rejects a subject with no word after the prefix", () => {
  assert.equal(isImperativeish("fix:"), false);
  assert.equal(isImperativeish(""), false);
});

test("verify fails a non-imperative subject with a hint", () => {
  assert.match(verify("Added retry to fetch helper").detail, /imperative/);
});

test("prepare puts the diff, the stat and the rules in the prompt", () => {
  assert.ok(task.prompt.includes("DIFF"));
  assert.ok(task.prompt.includes("STAT"));
  assert.ok(task.prompt.includes("at most 72 characters"));
  assert.equal(task.taskType, "commit-message");
});

test("the task registry knows commit-message", () => {
  assert.equal(taskModules["commit-message"], commitMessage);
});
