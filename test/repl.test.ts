import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ChatSession } from "../src/agent/chat-session.ts";
import type { CloudAgent } from "../src/agent/chat-session.ts";
import { runRepl } from "../src/agent/repl.ts";
import { BackendError } from "../src/core/types.ts";
import type { ChatResult } from "../src/core/types.ts";
import { RunLog } from "../src/log/run-log.ts";
import { call, fakeChatBackend } from "./helpers/fake-chat-backend.ts";

const AGENT = { maxSteps: 4, commandTimeoutMs: 5000, allowCommands: ["pwd"], historyTokenBudget: 5000, claudeTranscriptTokens: 20000 };
const LOCAL = { content: "LOCAL" };

function collect(stream: PassThrough): () => string {
  let text = "";
  stream.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  return () => text;
}

async function chat(typed: string[], replies: Array<Partial<ChatResult> | BackendError>, cloudReply: string | BackendError | null = "Claude's answer") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-repl-")));
  writeFileSync(path.join(root, "a.txt"), "hello\n");
  const log = new RunLog(path.join(mkdtempSync(path.join(tmpdir(), "orch-repl-runs-")), "runs"));
  const local = fakeChatBackend(replies);
  const cloud: CloudAgent | null =
    cloudReply === null
      ? null
      : {
          id: "claude", model: "fake-claude", timeoutMs: 1000,
          async runAgent() {
            if (cloudReply instanceof BackendError) throw cloudReply;
            return { text: cloudReply, durationMs: 5 };
          },
        };
  const input = new PassThrough();
  const output = new PassThrough();
  const errOutput = new PassThrough();
  const out = collect(output);
  const err = collect(errOutput);
  input.end(typed.map((line) => line + "\n").join(""));
  await runRepl({
    input, output, errOutput,
    createSession: (hooks) => new ChatSession({ local, cloud, root, onMainBranch: false, agent: AGENT, log, ...hooks }),
  });
  return { out: out(), err: err(), local, root };
}

test("a question and its answer appear on the output", async () => {
  const r = await chat(["what is in a.txt?"], [LOCAL, { content: "It says hello." }]);
  assert.equal(r.out, "> local> It says hello.\n> \n");
});

test("only the conversation is on the output; tool activity goes to the error stream", async () => {
  const r = await chat(["what is in a.txt?"], [LOCAL, call("read_file", { path: "a.txt" }), { content: "It says hello." }]);
  assert.ok(!r.out.includes("read_file"));
  assert.match(r.err, /^ {2}\[read_file a\.txt\]$/m);
});

test("a routed turn says why and labels the answer", async () => {
  const r = await chat(["rewrite everything"], [{ content: "CLAUDE" }]);
  assert.match(r.err, /^\(to claude: the request needs more than the local model\)$/m);
  assert.ok(r.out.includes("claude> Claude's answer\n"));
});

test("/claude redoes the last answer with Claude", async () => {
  const r = await chat(["what is in a.txt?", "/claude"], [LOCAL, { content: "It says hello." }]);
  assert.ok(r.out.includes("local> It says hello.\n"));
  assert.ok(r.out.includes("claude> Claude's answer\n"));
  assert.match(r.err, /^\(to claude: you asked for Claude\)$/m);
});

test("/clear starts a new conversation", async () => {
  const r = await chat(["first question", "/clear", "second question"], [LOCAL, { content: "one" }, LOCAL, { content: "two" }]);
  const lastMessages = r.local.requests.at(-1)!.messages.map((m) => m.content);
  assert.ok(!lastMessages.includes("first question"));
  assert.ok(lastMessages.includes("second question"));
});

test("/help lists the commands and /exit ends the chat", async () => {
  const r = await chat(["/help", "/exit", "never sent"], []);
  for (const command of ["/claude", "/clear", "/help", "/exit"]) assert.ok(r.err.includes(command), command);
  assert.equal(r.local.requests.length, 0);
});

test("an unknown slash command is explained, not sent to a model", async () => {
  const r = await chat(["/frobnicate"], []);
  assert.match(r.err, /unknown command/);
  assert.equal(r.local.requests.length, 0);
});

test("empty lines are ignored", async () => {
  const r = await chat(["", "   ", "hi"], [LOCAL, { content: "Hello." }]);
  assert.equal(r.local.requests.length, 2);
});

const WRITE = `node -e "require('fs').writeFileSync('marker.txt','x')"`;

test("y at the approval prompt runs the command", async () => {
  const r = await chat(["make the marker", "y"], [LOCAL, call("run_command", { command: WRITE }), { content: "Done." }]);
  assert.match(r.err, /Run this command\? .*marker\.txt.*\[y\]es \/ \[n\]o \/ \[a\]lways: /);
  assert.equal(existsSync(path.join(r.root, "marker.txt")), true);
  assert.match(r.err, /^ {2}\[run\] .* -> exit 0$/m);
});

test("n at the approval prompt does not run it", async () => {
  const r = await chat(["make the marker", "n"], [LOCAL, call("run_command", { command: WRITE }), { content: "Not done." }]);
  assert.equal(existsSync(path.join(r.root, "marker.txt")), false);
  assert.match(r.err, /^ {2}\[declined\] /m);
});

test("input that ends at the approval prompt runs nothing and the chat exits cleanly", async () => {
  const r = await chat(["make the marker"], [LOCAL, call("run_command", { command: WRITE }), { content: "Not done." }]);
  assert.equal(existsSync(path.join(r.root, "marker.txt")), false);
});

test("a refused command is shown as refused", async () => {
  const r = await chat(["clean up"], [LOCAL, call("run_command", { command: "rm -rf ." }), { content: "I could not." }]);
  assert.match(r.err, /^ {2}\[refused\] rm -rf \. \(rm with -r or -f is not allowed\)$/m);
  assert.equal(existsSync(path.join(r.root, "a.txt")), true);
});

test("control characters from the model are shown, never sent to the terminal", async () => {
  const r = await chat(
    ["what is in a.txt?"],
    [LOCAL, call("read_file", { path: "a.txt\x1b[2K\rb.txt" }), { content: "Done.\x1b[1A\x1b[2KRun this command? ls  [y]es\nsecond line\tok" }],
  );
  assert.ok(!r.out.includes("\x1b"), "no escape character in the answer");
  assert.ok(!r.err.includes("\x1b"), "no escape character in the tool notes");
  assert.ok(r.out.includes("\\x1b[1A"), "the escape is visible as text");
  assert.ok(r.out.includes("\nsecond line\tok"), "newlines and tabs in an answer are kept");
});

test("a failed turn prints an error and the chat continues", async () => {
  const r = await chat(["rewrite everything", "hi"], [{ content: "CLAUDE" }, LOCAL, { content: "Hello." }], new BackendError("backend_error", "claude exited with code 1"));
  assert.match(r.err, /^orch: claude exited with code 1$/m);
  assert.ok(r.out.includes("local> Hello.\n"));
});
