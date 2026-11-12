#!/usr/bin/env node
// A stand-in for the `claude` binary, for tests only. Behaviour is chosen by FAKE_CLAUDE_MODE:
//   ok (default) | error | is_error | badjson | hang
// FAKE_CLAUDE_TRACE: file that gets "start <pid> <ms>" / "end <pid> <ms>" lines.
// FAKE_CLAUDE_ARGS:  file that gets {"args": [...], "cwd": "..."} for the last call.
// FAKE_CLAUDE_REPLY: fixed result text for mode ok (default: the prompt reversed).
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("0.0.0 (fake)");
  process.exit(0);
}

const trace = (what) => {
  if (process.env.FAKE_CLAUDE_TRACE) appendFileSync(process.env.FAKE_CLAUDE_TRACE, `${what} ${process.pid} ${Date.now()}\n`);
};
trace("start");
if (process.env.FAKE_CLAUDE_ARGS) writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ args, cwd: process.cwd() }));

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const result = (extra) =>
  JSON.stringify({
    type: "result",
    is_error: false,
    result: process.env.FAKE_CLAUDE_REPLY ?? [...prompt].reverse().join(""),
    usage: { input_tokens: 5, output_tokens: 2 },
    modelUsage: { "fake-model": {} },
    ...extra,
  });

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  console.error("boom");
  trace("end");
  process.exit(1);
} else if (mode === "badjson") {
  console.log("not json");
  trace("end");
} else if (mode === "is_error") {
  console.log(result({ is_error: true, result: "not signed in" }));
  trace("end");
} else {
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(result({}));
  trace("end");
}
