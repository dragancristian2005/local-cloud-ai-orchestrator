# Toolkit and Policy (harness split, minimal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is written to be executed in a fresh session with no memory of the one that wrote it. Everything you need is in this file and in the repository.

**Goal:** The agent loop stops knowing about coding. It receives a **toolkit** (tools, a system prompt, and one **policy** that decides for every tool call whether it runs, is shown to the user first, or is refused), and the coding tools become the first toolkit.

**Architecture:** `src/agent/toolkit.ts` holds the generic types. `src/agent/coding-toolkit.ts` builds the coding toolkit from today's file tools, command runner and `classifyCommand`. `src/agent/loop.ts` keeps everything generic (steps, history, repeated-call rule, hand-over, result budget) and imports nothing coding-specific. `ChatSession` builds the coding toolkit itself, so the chat, the REPL and the CLI behave as before.

**Tech Stack:** Node >= 22.18 running TypeScript directly (no build step), `node:test`, zero runtime dependencies. Erasable TypeScript only: no `enum`, no constructor parameter properties. Relative imports carry `.ts`.

**Spec:** `CLAUDE.md` (repo root), especially "Core idea" (the chat paragraph) and the Hard rules. The owner's two decisions, made on 2026-11-14, are binding:

1. **One policy decides for all tools** (not each tool for itself). A tool the policy does not know is **asked**, never allowed.
2. **Minimal version.** Everything stays in `src/agent/`. No separate package, no second toolkit, no change to `ChatSession`'s options, the REPL or the CLI.

## Where things stand

- Branch: `claude/awesome-turing-qwwqh5`. It equals `main` (merge `44b8be4`, PR #2) plus the commit that adds this plan. Develop and push only there. Do not open a pull request unless asked.
- `npm test`: 370 tests, 0 failing. `npm run typecheck`: clean.
- Today's coupling, all in `src/agent/loop.ts`: it imports `TOOL_DEFINITIONS` and the three file tools from `tools.ts`, `classifyCommand` from `permissions.ts`, `runCommand` from `../core/command.ts`, and holds the coding system prompt. `AgentTurnOptions` carries `root`, `commandTimeoutMs`, `allowCommands`, `onMainBranch`, `gitRepository`.

## Global Constraints

- The Hard rules in `CLAUDE.md` apply verbatim.
- Tests first: write the failing test, watch it fail, then the code.
- **Behaviour stays the same.** In existing test files, change only how things are constructed or imported (the `setup` helper, an import path). Never change, weaken or delete an existing assertion. If one cannot pass, stop and say so in the final message.
- Two intended behaviour changes, each pinned by a new test in Task 3: a tool named like an `Object.prototype` member (`constructor`, `toString`) is an unknown tool; a permission check that throws blocks the call instead of ending the turn with an exception.
- Model-controlled text (tool names, arguments) is hostile input. No tool runs before the policy has answered for that exact call.
- No new dependencies. No changes to `src/agent/permissions.ts` rules, `src/agent/repl.ts`, `src/cli.ts` or `src/backends/`.
- A hook blocks any shell command whose text contains the GitHub CLI's pull-request create command, even inside an `echo` or a heredoc. Do not write that phrase in shell commands.
- Commit after each task with the message given. End every commit message with:

```
Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Session: <this session's URL, if you have one; otherwise omit the line>
```

## Review Focus

Each line has a test in the task named.

1. **A tool the policy does not know must be asked**, never run silently. (Task 1)
2. **A refusal beats an earlier "always".** After the user answered "always", the same call must still be refused when the policy now denies it. (Task 3)
3. **"Always" is remembered per tool.** Approving one tool's call must not approve another tool's call that is described by the same text. (Task 3)
4. **A permission check that throws must block the call**, not run it and not crash the turn. (Task 3)
5. **Tool names that exist on every object** (`constructor`, `__proto__`, `toString`) must be unknown tools. (Task 3)

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/agent/toolkit.ts` (new) | Generic types: `Tool`, `Policy`, `Verdict`, `Toolkit`, `ToolOutput`, `ToolDefinition`; `ToolError`; `MAX_TOOL_RESULT_CHARS`; the `ask_claude` definition. Imports nothing from the project. |
| `src/agent/coding-toolkit.ts` (new) | `codingPolicy`, `codingToolkit`, `CODING_SYSTEM_PROMPT`. The only file that joins the file tools, the command runner and the command rules. |
| `src/agent/tools.ts` | The three file tools and their definitions. Re-exports what moved to `toolkit.ts`, so existing imports keep working. |
| `src/agent/loop.ts` | The generic loop. No import from `tools.ts`, `permissions.ts`, `secrets.ts` or `../core/command.ts`. |
| `src/agent/chat-session.ts` | Builds the coding toolkit once in its constructor and passes it to the loop. Options unchanged. |

---

### Task 1: Generic types and the coding policy

**Files:**
- Create: `src/agent/toolkit.ts`, `src/agent/coding-toolkit.ts`
- Modify: `src/agent/tools.ts`, `src/agent/permissions.ts` (one type alias), `src/core/types.ts` (one import)
- Test: `test/coding-policy.test.ts` (new)

**Interfaces — Produces:**

```ts
// src/agent/toolkit.ts
export interface ToolDefinition { /* moved unchanged from tools.ts */ }
export type Verdict = { decision: "allow" } | { decision: "ask" } | { decision: "deny"; reason: string };
/** What a tool returns: text, or text plus the exit code of something it ran. */
export type ToolOutput = string | { text: string; exitCode: number | null };
export interface Tool {
  definition: ToolDefinition;
  /** One line that names this call: shown in the activity log and in the approval prompt. */
  describe(args: Record<string, unknown>): string;
  /** Throws ToolError for a problem the model can act on. */
  run(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): ToolOutput | Promise<ToolOutput>;
}
export interface Policy {
  check(tool: string, args: Record<string, unknown>): Verdict | Promise<Verdict>;
}
export interface Toolkit { systemPrompt: string; tools: Tool[]; policy: Policy }
export class ToolError extends Error { /* moved unchanged from tools.ts */ }
export const MAX_TOOL_RESULT_CHARS = 4500;       // moved from tools.ts
export const ASK_CLAUDE_TOOL: ToolDefinition;    // the "ask_claude" entry, moved unchanged from TOOL_DEFINITIONS

// src/agent/coding-toolkit.ts
export interface CodingOptions {
  root: string;
  commandTimeoutMs: number;
  allowCommands: string[];
  onMainBranch: boolean | (() => boolean | Promise<boolean>);
  gitRepository?: boolean | (() => boolean | Promise<boolean>);   // default true
}
export function codingPolicy(opts: Pick<CodingOptions, "allowCommands" | "onMainBranch" | "gitRepository">): Policy;
```

Rules of `codingPolicy.check(tool, args)`:
- `read_file`, `list_dir`, `search`: `allow`. (They confine themselves to the repository and refuse secrets files.)
- `run_command` with a non-empty string `command`: resolve `onMainBranch` and `gitRepository` **now** (call them when they are functions), then return `classifyCommand(command, { allowCommands, onMainBranch, gitRepository })`.
- `run_command` with any other `command`: `allow`. There is nothing to run; the tool rejects it (Task 2).
- Any other tool name: `ask`.

Moves, with no change in content: `ToolDefinition`, `ToolError`, `MAX_TOOL_RESULT_CHARS` from `tools.ts` to `toolkit.ts`. `tools.ts` re-exports all three, and its `TOOL_DEFINITIONS` keeps the same five entries in the same order (`[...the four, ASK_CLAUDE_TOOL]`). `src/core/types.ts` imports `ToolDefinition` from `../agent/toolkit.ts`. In `permissions.ts`, `CommandVerdict` becomes `export type CommandVerdict = Verdict`.

- [ ] **Step 1: Write the failing test** `test/coding-policy.test.ts`:

```ts
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
```

- [ ] **Step 2: Run** `node --test test/coding-policy.test.ts`. Expected: fails, `Cannot find module ... coding-toolkit.ts`.
- [ ] **Step 3: Create `toolkit.ts`, do the moves, and implement `codingPolicy`** in `coding-toolkit.ts`.
- [ ] **Step 4: Run** `node --test test/coding-policy.test.ts test/tools.test.ts test/ollama-chat.test.ts test/permissions.test.ts` and `npm run typecheck`. Expected: `# fail 0` and no type errors.
- [ ] **Step 5: Commit** — `refactor: generic toolkit types and a policy for the coding tools`.

### Task 2: The coding tools as a toolkit

**Files:**
- Modify: `src/agent/coding-toolkit.ts`
- Test: `test/coding-toolkit.test.ts` (new)

**Interfaces:**
- Consumes: `Tool`, `Toolkit`, `ToolError`, `codingPolicy`, `CodingOptions` (Task 1); `readFileTool`, `listDirTool`, `searchTool`, `TOOL_DEFINITIONS` from `tools.ts`; `runCommand` from `../core/command.ts`.
- Produces:

```ts
export const CODING_SYSTEM_PROMPT: (root: string) => string;   // the text of SYSTEM_PROMPT in loop.ts, unchanged
export function codingToolkit(opts: CodingOptions): Toolkit;
```

`codingToolkit` returns `{ systemPrompt: CODING_SYSTEM_PROMPT(opts.root), tools, policy: codingPolicy(opts) }` with four tools in this order: `read_file`, `list_dir`, `search`, `run_command`. Each takes its `definition` from `TOOL_DEFINITIONS` by name.

- The three file tools: `run` calls the existing function with `opts.root`. `describe` is today's `describe` from `loop.ts`: `read_file <path>`; `list_dir <path>`, or `list_dir` with no path; `search "<query>"`, plus ` in <path>` when a path was given.
- `run_command`: `describe` returns the command text (`""` when it is not a string). `run` throws `ToolError('"command" must be a non-empty string')` for anything else than a non-empty string; otherwise it runs `runCommand(command, { cwd: opts.root, timeoutMs: opts.commandTimeoutMs, signal: ctx.signal })` and returns `{ text, exitCode }`, where `text` is built exactly as `runCommandTool` in `loop.ts` builds it today (last 4000 characters of output, `timed out after <n> s` or `exit code <n>` as the first line).

- [ ] **Step 1: Write the failing test** `test/coding-toolkit.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODING_SYSTEM_PROMPT, codingToolkit } from "../src/agent/coding-toolkit.ts";
import { readFileTool } from "../src/agent/tools.ts";
import { ToolError } from "../src/agent/toolkit.ts";

function kit(commandTimeoutMs = 5000) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "orch-kit-")));
  writeFileSync(path.join(root, "a.txt"), "hello\n");
  const toolkit = codingToolkit({ root, commandTimeoutMs, allowCommands: ["ls"], onMainBranch: false });
  const tool = (name: string) => toolkit.tools.find((t) => t.definition.function.name === name)!;
  return { root, toolkit, tool };
}

test("the coding toolkit has the four tools, in order, and the coding prompt", () => {
  const { root, toolkit } = kit();
  assert.deepEqual(toolkit.tools.map((t) => t.definition.function.name), ["read_file", "list_dir", "search", "run_command"]);
  assert.equal(toolkit.systemPrompt, CODING_SYSTEM_PROMPT(root));
  assert.ok(toolkit.systemPrompt.includes(root) && toolkit.systemPrompt.includes("ask_claude"));
});

test("each call is described by what it touches", () => {
  const { tool } = kit();
  assert.equal(tool("read_file").describe({ path: "src/a.ts" }), "read_file src/a.ts");
  assert.equal(tool("list_dir").describe({}), "list_dir");
  assert.equal(tool("list_dir").describe({ path: "src" }), "list_dir src");
  assert.equal(tool("search").describe({ query: "clamp" }), 'search "clamp"');
  assert.equal(tool("search").describe({ query: "clamp", path: "src" }), 'search "clamp" in src');
  assert.equal(tool("run_command").describe({ command: "npm test" }), "npm test");
  assert.equal(tool("run_command").describe({ command: 42 }), "");
});

test("the file tools are the existing ones, bound to the repository", async () => {
  const { root, tool } = kit();
  assert.equal(await tool("read_file").run({ path: "a.txt" }, {}), readFileTool(root, { path: "a.txt" }));
  await assert.rejects(async () => tool("read_file").run({ path: "../x" }, {}), ToolError);
});

test("run_command returns the output and the exit code", async () => {
  const { tool } = kit();
  assert.deepEqual(await tool("run_command").run({ command: `node -e "console.log(40 + 2)"` }, {}), { text: "exit code 0\n42", exitCode: 0 });
  assert.deepEqual(await tool("run_command").run({ command: `node -e "process.exit(3)"` }, {}), { text: "exit code 3", exitCode: 3 });
});

test("run_command says when a command was cut off", async () => {
  const { tool } = kit(300);
  const result = await tool("run_command").run({ command: `node -e "setInterval(() => {}, 1000)"` }, {});
  assert.match(typeof result === "string" ? result : result.text, /^timed out after 0 s/);
});

test("run_command rejects a command that is not text", async () => {
  const { tool } = kit();
  for (const bad of [42, "", "  ", undefined]) {
    await assert.rejects(async () => tool("run_command").run({ command: bad }, {}), (err: unknown) => err instanceof ToolError && err.message === '"command" must be a non-empty string');
  }
});
```

- [ ] **Step 2: Run** `node --test --test-timeout=15000 test/coding-toolkit.test.ts`. Expected: fails, `codingToolkit` / `CODING_SYSTEM_PROMPT` is not exported.
- [ ] **Step 3: Implement** `CODING_SYSTEM_PROMPT` and `codingToolkit`. Copy the prompt text and the result-building lines from `loop.ts`; do not delete them from `loop.ts` yet (Task 3 does).
- [ ] **Step 4: Run** the same command and `npm run typecheck`. Expected: `# fail 0` (6 tests), no type errors.
- [ ] **Step 5: Commit** — `refactor: the coding tools as a toolkit`.

### Task 3: The loop takes a toolkit

**Files:**
- Modify: `src/agent/loop.ts`, `src/agent/chat-session.ts`, `test/loop.test.ts` (construction only)
- Test: `test/loop-toolkit.test.ts` (new)

**Interfaces:**
- Consumes: `Toolkit`, `Tool`, `Policy`, `ToolError`, `MAX_TOOL_RESULT_CHARS`, `ASK_CLAUDE_TOOL` (Task 1); `codingToolkit` (Task 2).
- Produces:

```ts
export interface AgentTurnOptions {
  backend: ChatBackend;
  messages: ChatMessage[];
  toolkit: Toolkit;
  maxSteps: number;
  historyTokenBudget: number;
  /** Calls the user answered "always" to in this session. */
  sessionAllowed: Set<string>;
  /** Shown the tool's own description of the call. */
  approve: (description: string) => Promise<Approval>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}
```

`root`, `commandTimeoutMs`, `allowCommands`, `onMainBranch` and `gitRepository` leave `AgentTurnOptions`; `SYSTEM_PROMPT`, `runCommandTool`, `runTool`, `describe` and `MAX_COMMAND_OUTPUT_CHARS` leave `loop.ts`. `EscalationReason`, `Approval`, `AgentEvent` and `TurnResult` are unchanged.

What the loop does with the toolkit:

- The system message is `toolkit.systemPrompt`. The tools sent to the model are `[...toolkit.tools.map((t) => t.definition), ASK_CLAUDE_TOOL]`.
- Tools are looked up in a `Map` keyed by name. `ask_claude`, the 8-calls-per-reply limit, the repeated-call rule, the result budget and "every call gets a tool message" stay as they are.
- For each call that is to be run, in this order:
  1. No such tool: result `error: unknown tool <name> (available: <names, comma-separated, ending with ask_claude>)`.
  2. `description = tool.describe(args)`.
  3. `verdict = await toolkit.policy.check(name, args)`. If it throws: the tool is **not** run; result `error: the permission check failed: <message>`.
  4. `deny`: event `{ type: "command", command: description, verdict: "refused", detail: reason }`; result `refused: <reason>`.
  5. `ask`: the session key is `` `${name}:${description}` ``. Unless `sessionAllowed` has the key, call `approve(description)`. `"no"`: event `{ type: "command", command: description, verdict: "declined" }`; result `the user declined to run this command`. `"always"`: add the key.
  6. `output = await tool.run(args, { signal })`. A thrown `ToolError`, or any other error, becomes `error: <message>` with no event.
  7. Event: when `output` is an object, `{ type: "command", command: description, verdict: "approved" (it was asked) or "allowed", exitCode: output.exitCode }`; when it is a string, `{ type: "tool", name, summary: description }`.

`ChatSession`: in the constructor, build `codingToolkit({ root, commandTimeoutMs: agent.commandTimeoutMs, allowCommands: agent.allowCommands, onMainBranch, gitRepository })` once and pass it as `toolkit` in `send`. Its options and everything else stay as they are.

- [ ] **Step 1: Write the failing test** `test/loop-toolkit.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn } from "../src/agent/loop.ts";
import type { AgentEvent, Approval } from "../src/agent/loop.ts";
import type { ChatMessage } from "../src/agent/messages.ts";
import { ToolError } from "../src/agent/toolkit.ts";
import type { Tool, Toolkit, ToolOutput, Verdict } from "../src/agent/toolkit.ts";
import type { ChatResult } from "../src/core/types.ts";
import { call, fakeChatBackend } from "./helpers/fake-chat-backend.ts";

// A toolkit that has nothing to do with code: the loop must not care.
function house(check: (tool: string, args: Record<string, unknown>) => Verdict | Promise<Verdict>, replies: Partial<ChatResult>[], answers: Approval[] = []) {
  const ran: string[] = [];
  const tool = (name: string, output: ToolOutput = "done"): Tool => ({
    definition: { type: "function", function: { name, description: name, parameters: { type: "object", required: [], properties: {} } } },
    describe: (args) => String(args.room ?? name),
    run: async (args) => {
      ran.push(name);
      if (args.fail === true) throw new ToolError("no such room");
      return output;
    },
  });
  const toolkit: Toolkit = {
    systemPrompt: "You run a house.",
    tools: [tool("read_sensor"), tool("set_light"), tool("unlock_door", { text: "exit code 0", exitCode: 0 })],
    policy: { check },
  };
  const backend = fakeChatBackend(replies);
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const asked: string[] = [];
  const events: AgentEvent[] = [];
  const run = () =>
    runAgentTurn({
      backend, messages, toolkit, maxSteps: 8, historyTokenBudget: 5000, sessionAllowed: new Set<string>(),
      approve: async (description) => {
        asked.push(description);
        return answers.shift() ?? "no";
      },
      onEvent: (event) => events.push(event),
    });
  const results = () => messages.filter((m) => m.role === "tool").map((m) => m.content);
  return { run, ran, asked, events, results, backend };
}

const allow = (): Verdict => ({ decision: "allow" });
const ask = (): Verdict => ({ decision: "ask" });
const DONE = { content: "ok" };

test("the system prompt and the tool list come from the toolkit, plus ask_claude", async () => {
  const h = house(allow, [DONE]);
  await h.run();
  const request = h.backend.requests[0]!;
  assert.deepEqual(request.messages[0], { role: "system", content: "You run a house." });
  assert.deepEqual((request.tools as { function: { name: string } }[]).map((t) => t.function.name), ["read_sensor", "set_light", "unlock_door", "ask_claude"]);
});

test("an allowed call runs without asking and is reported as a tool event", async () => {
  const h = house(allow, [call("read_sensor", { room: "kitchen" }), DONE]);
  await h.run();
  assert.deepEqual([h.ran, h.asked, h.results()], [["read_sensor"], [], ["done"]]);
  assert.deepEqual(h.events, [{ type: "tool", name: "read_sensor", summary: "kitchen" }]);
});

test("an asked call shows the tool's description and runs only on yes", async () => {
  const yes = house(ask, [call("set_light", { room: "hall" }), DONE], ["yes"]);
  await yes.run();
  assert.deepEqual([yes.asked, yes.ran], [["hall"], ["set_light"]]);

  const no = house(ask, [call("set_light", { room: "hall" }), DONE], ["no"]);
  await no.run();
  assert.deepEqual([no.ran, no.results()], [[], ["the user declined to run this command"]]);
  assert.deepEqual(no.events, [{ type: "command", command: "hall", verdict: "declined" }]);
});

test("a result with an exit code is reported as a command event", async () => {
  const allowed = house(allow, [call("unlock_door", { room: "front" }), DONE]);
  await allowed.run();
  assert.deepEqual(allowed.events, [{ type: "command", command: "front", verdict: "allowed", exitCode: 0 }]);
  assert.deepEqual(allowed.results(), ["exit code 0"]);

  const approved = house(ask, [call("unlock_door", { room: "front" }), DONE], ["yes"]);
  await approved.run();
  assert.deepEqual(approved.events, [{ type: "command", command: "front", verdict: "approved", exitCode: 0 }]);
});

test("always is remembered per tool, not per description", async () => {
  const h = house(ask, [call("set_light", { room: "hall" }), call("set_light", { room: "hall", again: true }), call("unlock_door", { room: "hall" }), DONE], ["always", "no"]);
  await h.run();
  assert.deepEqual(h.asked, ["hall", "hall"], "set_light was asked once, unlock_door was asked for itself");
  assert.deepEqual(h.ran, ["set_light", "set_light"]);
});

test("a refusal beats an earlier always", async () => {
  let checks = 0;
  // Asked the first time; refused from the second check on (as when the branch became main).
  const check = (): Verdict => (++checks === 1 ? { decision: "ask" } : { decision: "deny", reason: "night mode" });
  const h = house(check, [call("set_light", { room: "hall" }), call("set_light", { room: "hall", again: true }), DONE], ["always"]);
  await h.run();
  assert.deepEqual(h.ran, ["set_light"], "only the first call ran");
  assert.deepEqual(h.results(), ["done", "refused: night mode"]);
  assert.deepEqual(h.events.at(-1), { type: "command", command: "hall", verdict: "refused", detail: "night mode" });
});

test("a permission check that fails blocks the call", async () => {
  const h = house(() => { throw new Error("git is not installed"); }, [call("unlock_door", { room: "front" }), DONE], ["yes"]);
  await h.run();
  assert.deepEqual([h.ran, h.asked], [[], []]);
  assert.deepEqual(h.results(), ["error: the permission check failed: git is not installed"]);
});

test("tool names that exist on every object are unknown tools", async () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    const h = house(allow, [call(name, {}), DONE]);
    await h.run();
    assert.match(h.results()[0]!, new RegExp(`^error: unknown tool ${name} \\(available: read_sensor, set_light, unlock_door, ask_claude\\)`));
    assert.deepEqual(h.events, []);
  }
});

test("a tool's own error is fed back to the model", async () => {
  const h = house(allow, [call("read_sensor", { room: "attic", fail: true }), DONE]);
  const turn = await h.run();
  assert.deepEqual(h.results(), ["error: no such room"]);
  assert.deepEqual(turn.outcome, { kind: "answer", text: "ok" });
});

test("ask_claude hands over with any toolkit", async () => {
  const h = house(allow, [call("ask_claude", { reason: "too hard" })]);
  assert.deepEqual((await h.run()).outcome, { kind: "escalate", reason: "agent_asked", detail: "too hard" });
});
```

- [ ] **Step 2: Run** `node --test --test-timeout=15000 test/loop-toolkit.test.ts`. Expected: every test fails (type and runtime: `runAgentTurn` has no `toolkit` option).
- [ ] **Step 3: Rewrite `loop.ts`** to the rules above, and switch `ChatSession` to `codingToolkit`.
- [ ] **Step 4: Adapt `test/loop.test.ts`, construction only.** Three places call `runAgentTurn` (the `setup` helper and two tests near lines 231 and 270). In each, replace `root`, `commandTimeoutMs`, `allowCommands`, `onMainBranch`, `gitRepository` with `toolkit: codingToolkit({ root, commandTimeoutMs: 5000, allowCommands, onMainBranch, gitRepository })`, keeping the same values. Import `CODING_SYSTEM_PROMPT as SYSTEM_PROMPT` from `../src/agent/coding-toolkit.ts` instead of `SYSTEM_PROMPT` from `loop.ts`. No assertion changes.
- [ ] **Step 5: Run** `node --test --test-timeout=15000 test/loop-toolkit.test.ts test/loop.test.ts test/chat-session.test.ts test/repl.test.ts test/cli-chat.test.ts`. Expected: `# fail 0` (10 new tests; the other files keep their counts: 25, 18, 17, 13).
- [ ] **Step 6: Prove the loop is generic.** Run `grep -nE '"\./(tools|permissions|secrets|coding-toolkit)\.ts"|core/command\.ts' src/agent/loop.ts`. Expected: no output.
- [ ] **Step 7: Run** `npm run typecheck`. Expected: no errors.
- [ ] **Step 8: Commit** — `refactor: the agent loop takes a toolkit and a policy`.

### Task 4: Documentation, full suite, push

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: `CLAUDE.md`, "Decisions".** Add one bullet at the end of the list:

  "**Agent harness:** the loop in `src/agent/loop.ts` is generic. It receives a toolkit (`src/agent/toolkit.ts`): tools, a system prompt, and one policy that answers allow, ask or deny for every tool call; a tool the policy does not know is asked. The coding tools and rules are one toolkit (`src/agent/coding-toolkit.ts`). A second toolkit, or a separate package, waits until a second harness exists."

- [ ] **Step 2: Run the whole suite:** `npm test 2>&1 | grep -E "^# (tests|pass|fail)|^not ok"` and `npm run typecheck`. Expected: `# fail 0` (391 tests: 370 + 5 + 6 + 10) and no type errors.
- [ ] **Step 3: Commit** — `docs: record the toolkit and policy split` — and `git push -u origin claude/awesome-turing-qwwqh5`.

---

## The final message to the owner

Plain language. It must contain:

1. **State:** suite and type-check results from Task 4, and that everything is pushed. No pull request was opened.
2. **What changed:** the loop no longer knows about coding; tools and one policy are handed to it; the chat behaves as before.
3. **The two intended behaviour changes:** tool names like `constructor` are now unknown tools; a failing permission check blocks the call instead of ending the turn.
4. **Any existing assertion that could not be kept**, by test name. (Expected: none.)
5. **What this makes possible next:** "edits in chat" is a new tool in the coding toolkit plus a rule in its policy; a home-assistant harness is a second toolkit. `ChatSession`, the Claude prompt and the REPL are still coding-specific and would be the next things to lift.
6. **Before any pull request:** `/security-review` on the branch, recorded with `.claude/scripts/security-review.ts` (see `CLAUDE.md`). The review must be done by a separate reviewer agent; the author's own review cannot be recorded.

## Still open from earlier sessions (not part of this plan)

- Try the project on the Mac and the PC: steps in `docs/SETUP.md` and `docs/claude-cli-flags.md`.
- From the security review, below its reporting bar: `prod.env`, `.envrc` and `.git-credentials` are not treated as secrets; the secrets check looks at the last path component only; `printable()` does not escape U+2028/U+2029; the billing check covers a fixed list.
- The pull-request hook blocks any command that merely mentions the create command.
- Plans waiting: `2026-11-12-small-edit.md` (M4), and "edits in chat" (not written).
