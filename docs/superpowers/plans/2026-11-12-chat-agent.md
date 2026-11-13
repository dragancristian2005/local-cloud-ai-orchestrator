# Chat Agent (`orch chat`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orch chat` is a terminal conversation with the local model, which can read files, search, and run commands in one repository, and which hands a turn to Claude when it cannot finish.

**Architecture:** The local model drives an agent loop through Ollama's tool calling: it asks for a tool, `orch` runs it under its own rules, the result goes back, until the model answers. `orch` still owns the files and the shell: every tool call is checked, commands need the user's approval, and reads stay inside the repository. A turn goes to Claude when the PC is down, when the model asks for help, when it gets stuck, or when the user types `/claude`. Claude gets the conversation as text and no tools, exactly as today.

**Tech Stack:** unchanged. Node >= 22.18 running TypeScript directly, `node:test`, `node:readline`, zero runtime dependencies.

**Spec:** `CLAUDE.md` (repo root). This plan changes it: Task 1 removes "Agent loops on the local model" from the non-goals and rewrites the "stateless worker" paragraph, at the owner's request. All Hard rules stay.

## Decisions (need your OK)

- **This reverses a rule you wrote.** The spec says the local model "never gets file access or runs an agent loop (small models are unreliable at that)". That warning still holds: expect a 7–9B model to pick wrong tools, loop, and give up more often than Claude. The plan limits the damage (step limit, loop detection, hand-over to Claude) but cannot make a small model reliable.
- **Reading is free, running needs your approval.** `read_file`, `list_dir` and `search` run without asking, inside the repository only. Every `run_command` is shown to you first: `y` runs it, `n` refuses, `a` runs it and stops asking for that exact command in this session.
- **A short allow-list runs without asking:** `git status`, `git diff`, `git log`, `ls`, `pwd`. You can add entries such as `npm test` in your local config. An allow-listed command is auto-approved only when it contains no shell operators (`;`, `|`, `&`, `>`, `$`, backticks and so on).
- **Some commands are refused outright, whatever you answer.** These are the spec's hard rules: `rm` with `-r` or `-f`, `git reset --hard`, `git clean`, `git push`, discarding changes with `git checkout --` or `git restore`, any commit-making git command while on `main` or `master`, `sudo`, and anything touching `~/.claude` or `~/.ssh`. This list is a backstop, not a guarantee: your approval is the real control.
- **No write or edit tool.** You asked for reading and running. The model can only change a file through a command you approve. A proper edit tool is the M4 plan's subject.
- **Secrets stay unread.** `read_file` and `search` skip `.env*`, `*.pem`, `*.key`, SSH keys, `.npmrc`, `.netrc` and everything under `.git/`. `orch chat` refuses to start in your home directory or `/`.
- **Whatever the tools read is sent to the model.** That means your PC, and Claude when a turn is handed over.
- **Claude gets no tools.** On hand-over, `claude -p` receives the conversation as text, including the files and command output the local model gathered, and answers the last message. Letting Claude read the repository itself is possible later; it needs flags I have not verified.
- **Four ways a turn reaches Claude:** the PC is off, slow or errors; the model calls `ask_claude`; the model hits the step limit (8 tool rounds) or repeats the same call three times; you type `/claude`.
- **It needs a model that supports tool calling.** Ollama's examples use `qwen3`. Whether `qwen2.5-coder:7b` or the others you plan to try support tools has to be checked on the PC; a model without it gets a clear error.
- **Chat turns are logged but kept out of the model comparison.** They go to `runs/log.jsonl` with `mode: "chat"`, and `orch report` shows them only with `--mode chat`. The full transcript of each session, with every tool call and your answers, is saved under `runs/<session id>/`.

## Global Constraints

- The Hard rules in `CLAUDE.md` apply verbatim. The Claude backend is unchanged: `claude -p`, no tools, one call at a time.
- The model never executes anything. It returns tool requests; `orch` validates and runs them.
- File tools resolve every path with `realpath` and refuse anything outside the repository root.
- `run_command` runs only after `classifyCommand` returns `allow`, or returns `ask` and the user answers `yes` or `always`. No answer (end of input) means no.
- There is no flag or config value that approves all commands.
- Tool results are capped: 4500 characters per result. The history sent to Ollama stays within `agent.historyTokenBudget` (default 5000 tokens, at 3 characters per token).
- Wire format, from Ollama's documentation: tools are `{ "type": "function", "function": { name, description, parameters } }`; a tool call arrives in `message.tool_calls[].function` with `arguments` as a JSON object; a result is sent as `{ "role": "tool", "tool_name": ..., "content": ... }` after the assistant message that asked for it. One response may hold several calls.
- stdout carries the conversation. Tool activity and approval prompts go to stderr.
- Zero runtime dependencies. Tests first. `npm test` needs neither the PC nor the real `claude`.

## Review Focus

1. **A model that loops or never answers:** the same tool call three times, or eight rounds without an answer, ends the local attempt and hands the turn to Claude. (Task 5)
2. **Path escapes:** `../x`, an absolute path, a symlink inside the repository that points outside it, and a secrets file are all refused, for `read_file`, `list_dir` and `search`. (Task 2)
3. **Command tricks:** `git status; rm -rf ~` is not auto-approved and is refused; a deny-listed command never runs even after `y`; end of input at the approval prompt runs nothing. (Tasks 1 and 7)
4. **Huge tool output:** a 5 MB file or a command that prints megabytes is cut to the cap, and a long conversation still fits the context window. (Tasks 2 and 4)
5. **A model without tool support, or malformed calls** (unknown tool, missing argument, arguments that are not an object): a clear error for the first, a tool error fed back to the model for the rest. No crash. (Tasks 3 and 5)

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
| `src/agent/chat-session.ts` | conversation state, routing to Claude, logging |
| `src/agent/repl.ts`, `src/cli.ts` | the terminal interface and `orch chat` |

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

- [ ] **Step 1: Edit `CLAUDE.md`.** In "Core idea", replace the "stateless worker" paragraph with: for `orch run` and `orch eval` the local model is a stateless worker; in `orch chat` it drives an agent loop through tool calls, and the orchestrator still owns the files and the shell (reads stay inside the repository, commands need approval, the deny rules enforce the Hard rules). In "Non-goals", remove "Agent loops on the local model". Add `orch chat` to the Milestones as M5.
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
  - *(Review Focus 5)* `tolerates malformed calls`: `arguments: "not json"` becomes `{}`; a call without a name is dropped.
  - `an empty reply with no tool call is a backend error`.
  - *(Review Focus 5)* `a model without tool support gets a clear error`: HTTP 400 `{"error":"... does not support tools"}` rejects with `backend_error` and a message containing `does not support tool calling`.
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
export type EscalationReason = "pc_unreachable" | "timeout" | "backend_error" | "agent_asked" | "step_limit" | "user_request";
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
  - *(Review Focus 5)* `unknown tool` and `missing argument` each give an `error:` tool message, not a throw.
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

### Task 6: Chat session, hand-over to Claude, logging

**Files:**
- Create: `src/agent/chat-session.ts`
- Modify: `src/core/types.ts` (`FallbackReason` gains `"agent_asked" | "step_limit" | "user_request"`; `AttemptRecord.mode` gains `"chat"`), `src/log/run-log.ts`, `src/log/report.ts`, `src/cli.ts` (report's `--mode` accepts `chat`)
- Test: `test/chat-session.test.ts`, additions to `test/report.test.ts` and `test/run-log.test.ts`

**Interfaces:**
- Consumes: `runAgentTurn`, `renderTranscript`, `Backend` (the Claude backend), `RunLog`.
- Produces:

```ts
export interface ChatReply { text: string; answeredBy: string | null; escalation: EscalationReason | null; error?: string }
export class ChatSession {
  constructor(opts: {
    local: ChatBackend; cloud: Backend | null; root: string; onMainBranch: boolean;
    agent: OrchestratorConfig["agent"]; log: RunLog;
    approve: (command: string) => Promise<Approval>; onEvent?: (event: AgentEvent) => void;
  });
  readonly sessionId: string;
  send(text: string): Promise<ChatReply>;      // a user message
  askClaude(): Promise<ChatReply>;             // "/claude": answer the last user message again, with Claude
  clear(): void;                               // forget the conversation, keep the session
}
// src/log/run-log.ts
appendArtifact(runId: string, name: string, line: string): string;   // appends line + "\n" to runs/<runId>/<name>
```

`send`: append the user message, run `runAgentTurn`. An answer is appended as an assistant message with `from` set to the local backend's id. An escalation calls Claude.

Calling Claude: `cloud.run({ prompt, timeoutMs: cloud.timeoutMs })` with this prompt (exact copy), where the transcript is `renderTranscript(messages, agent.claudeTranscriptTokens)`:

```
You are helping in a terminal chat about the repository at {root}. A local model handled the conversation so far and could not finish: {reason}.
You have no tools here. Answer the user's last message using the conversation below, which includes the files and command output the local model gathered. If you would need a file that is not shown, say which one.

{transcript}
```

`{reason}` is: `the PC running it is unreachable`, `it timed out`, `it returned an error`, `it asked for help: <detail>`, `it got stuck using its tools`, or `the user asked for you`. Claude's answer is appended as an assistant message with `from` set to the Claude backend's id. If there is no cloud backend, or it fails, `send` resolves with `answeredBy: null` and `error` set; the conversation keeps the user message.

Logging, per user turn: one `AttemptRecord` for the local tier and, on hand-over, one for Claude. `mode "chat"`, `taskType "chat"`, `runId` the session id, `taskId "turn-<n>"`, `verify "skipped"`, `tier` 0 or 1, `attempt 0`, `repo` the root, `fallbackReason` the escalation reason or `null`, `escalated` true on the local record when Claude was called, `outputFile` the transcript path. Every message, tool event and reply is also appended as one JSON line to `runs/<sessionId>/transcript.jsonl`.

`orch report`: without `--mode`, chat records are left out. `--mode chat` shows them; for chat and run records alike, the escalation rate counts runs in which the group escalated.

- [ ] **Step 1: Write the failing tests**
  - `a local answer`: `answeredBy` is the local id; one log record with `mode "chat"`, `fallbackReason null`, `taskId "turn-1"`.
  - `the conversation carries over`: the second `send` makes a request whose messages include the first question and answer.
  - `hands over when the model asks`: `fakeChatBackend` calls `ask_claude`; the fake cloud backend's prompt contains the user's question, the reason text `it asked for help` and the tool results gathered before; the reply is `answeredBy` the cloud id; two log records, the first with `fallbackReason "agent_asked"` and `escalated true`, the second `tier 1`.
  - `hands over when the PC is off`, with `fallbackReason "pc_unreachable"`.
  - `Claude's answer becomes part of the history` for the next local turn.
  - `askClaude answers the last question again`: logged with `fallbackReason "user_request"`; before any user message it resolves with an `error`.
  - `no cloud backend`: an escalation resolves with `answeredBy null` and an `error` naming the reason.
  - `a failing cloud backend`: the same, and its record has `fallbackReason "backend_error"`.
  - `clear forgets the conversation`: the next request holds only the system prompt and the new message.
  - `the transcript file records tool calls and approvals`.
  - Report: chat records are excluded by default and included with `{ mode: "chat" }`; a chat group's escalation rate is computed.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: chat session with hand-over to Claude`.

### Task 7: The terminal interface, `orch chat`, and the documentation

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
- Prompt `you> ` on `output`. A reply is printed as `<backend id>> <text>`. A failed turn prints `orch: <error>` on `errOutput`.
- Tool events go to `errOutput`: `  [read_file src/a.ts]`, `  [run] git status -> exit 0`, `  [refused] rm -rf . (rm with -r or -f is not allowed)`.
- An approval prompt on `errOutput`: `Run this command? <command>  [y]es / [n]o / [a]lways: `. The next input line answers it: `y` or `yes`, `a` or `always`; anything else, or the end of input, is `no`.
- Commands: `/claude`, `/clear`, `/help`, `/exit`. An empty line is ignored. End of input exits.

CLI: `orch chat [--repo <path>] [--model <name>] [--config <path>]`. The chain is `config.chains.chat`; its first backend must be an Ollama backend (`ConfigError` otherwise), its second, if present, the Claude backend. `--repo` defaults to `.`; a root equal to the home directory or `/` is an `InputError`. `onMainBranch` is true when `git rev-parse --abbrev-ref HEAD` in the root prints `main` or `master`; outside a repository it is false. A banner on `errOutput` names the model, the root and `/help`.

- [ ] **Step 1: Write the failing tests**

`test/repl.test.ts`, with in-memory streams and a `ChatSession` built on fakes:
  - a question and its answer appear on `output` as `you> ` and `<id>> <text>`; nothing but the conversation is on `output`.
  - `/claude` prints Claude's answer; `/clear` then a question sends a history without the earlier turn; `/help` lists the four commands; `/exit` ends the loop.
  - an approval line `y` runs the command; `n` does not; *(Review Focus 3)* input that ends at the approval prompt runs nothing and the loop exits cleanly.
  - a failed turn prints `orch:` on `errOutput` and the loop continues.

`test/cli-chat.test.ts`, spawning the CLI with piped stdin, `startFakeOllama(scriptedChat(...))` and a temp repository:
  - `answers a question using read_file`: stdout contains the answer; the fake server's second request contains the file's text in a tool message.
  - `runs an approved command`: stdin `question`, `y`, `/exit`; the second request's tool message contains the command's output.
  - *(Review Focus 3)* `never runs a refused command`: the model asks for `rm -rf .`; the repository still has its files; the tool message starts `refused:`.
  - `hands over to Claude`: the model calls `ask_claude`; with `fakeClaudeEnv`, stdout shows `claude> ` and the fake's reply; the log has two `chat` records.
  - `the PC is off`: with a closed port, Claude answers; the first record says `pc_unreachable`.
  - `refuses the home directory` and `a chain whose first backend is not Ollama`: exit `2`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Write the documentation.**
  - `README.md`: a section "Chatting with the local model" with the command, what the model can and cannot do, the approval prompt, the allow-list and how to extend it in `config/orchestrator.local.json`, the refused commands, the four hand-over cases, and the note that tool output is sent to the PC and, on hand-over, to Claude. Update "Rules this project keeps".
  - `docs/SETUP.md`: Part 3 gains a step "Chat with it", with a short session to try (`what does this repository do?`, a question that needs `git log`, then `/claude`); add it to the not-yet-verified list; add troubleshooting rows for `does not support tool calling`, for a model that keeps getting stuck (try another model, or `/claude`), and for `refused:`.
- [ ] **Step 5: Run the new SETUP step end to end** in a temp repository against a stand-in Ollama that scripts tool calls, and fix the text where the output differs.
- [ ] **Step 6: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 7: Commit** — `feat: orch chat`.

### On the Mac, with the PC on (manual)

- [ ] `ollama pull` a model with tool support on the PC, set it in `config/orchestrator.local.json`, then `orch chat --repo <some repository>`.
- [ ] Ask something that needs a file. Watch for `[read_file ...]` on screen.
- [ ] Ask it to run the tests. Answer the approval prompt.
- [ ] Type `/claude` once. This is the first real hand-over; if it fails, the error names the cause.

---

## Not in this plan

- A write or edit tool (see the M4 plan).
- Tools for Claude on hand-over.
- Streaming the answer as it is generated.
- Conversations that survive a restart.
- A sandbox for commands.
