# Tiered Coding Orchestrator Implementation Plan (M1–M3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript CLI, `orch`, that runs a coding task on a local Ollama model first, verifies the output, retries once, escalates to the `claude` CLI only when needed, and logs every attempt so models can be compared.

**Architecture:** Backends are stateless text-in/text-out workers behind one `Backend` interface. A task module turns an input (a diff or a source file) into a `PreparedTask` (prompt + normalise + verify). `runTask` walks the chain of backends, asks `policy.decideNext` what to do after each failed attempt, and writes one JSONL record per attempt. `orch eval` and `orch report` reuse the same loop and log.

**Tech Stack:** Node >= 22.18 running TypeScript directly (native type stripping, no build step), ESM, `node:test`, `node:util` `parseArgs`, built-in `fetch`. Zero runtime dependencies. Dev dependencies: `typescript`, `@types/node` only.

**Spec:** `CLAUDE.md` (repo root). Read it first; its Hard rules apply to every task.

## Decisions on the spec's open questions (need your OK)

- **Config format: JSON.** Parsed by `JSON.parse`, no dependency. A gitignored `config/orchestrator.local.json` is merged over the committed config, so your PC address and the model you are testing never dirty the working tree.
- **CLI parsing: `node:util` `parseArgs`.** No library.
- **`orch run` reads flags only.** Task files exist only for the fixed eval set (`eval/fixed-tasks/<id>/task.json`).
- **Verifier rules:** exact rules are listed in Tasks 3 and 8.
- **No build step.** `node src/cli.ts` runs as is (checked on Node 22.23: direct run, `bin` symlink, and `node --test` on `.ts` files all work; `tsc --noEmit` with TypeScript 7.0.2 passes). `tsc` is used for type checking only.
- **Prompt budget is 6000 tokens, with `num_ctx` 8192 sent to Ollama.** Ollama's default context window is smaller than the spec's 8K target and it truncates silently. 6000 leaves room for the answer. Tokens are estimated as `chars / 4` (no tokenizer dependency).
- **Three fields added to the log record:** `attempt` (0 = first try, 1 = retry), `mode` (`"run"` or `"eval"`), `taskId` (eval only). Output files are named `tier<N>-attempt<M>.txt`, because a retry would overwrite `tier0.txt`.
- **Retries happen on local backends only, and only after a verify failure.** A retry on Claude would spend subscription calls; a retry after a timeout or an unreachable PC would fail the same way.
- **The shell-command verifier and all git writes are left to M4**, which gets its own plan (see the end). M1–M3 never modify a target repo.
- **Template leftovers are removed in Task 1:** `export.sh`, `tests/`, and the two `claude-config` documents under `docs/superpowers/`. `.claude/` stays.

## Global Constraints

- Hard rules in `CLAUDE.md` apply verbatim. In particular:
  - The Claude backend only spawns the unmodified `claude` binary. Never read, copy or proxy credentials.
  - Claude calls run one at a time. No bulk or benchmark runs against the subscription.
  - No destructive commands. No writes to a target repo in M1–M3.
  - No paid APIs, no paid dependencies.
- Node `>=22.18`. `"type": "module"`. Relative imports carry the `.ts` extension.
- Erasable TypeScript only (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties.
- Runtime dependencies: none. Dev dependencies: `typescript`, `@types/node`.
- Subprocesses use `execFile`/`spawn` with argument arrays. Never a shell string.
- Tests never contact a real Ollama and never run the real `claude`. They use a fake HTTP server on `127.0.0.1` and `test/fixtures/fake-claude.mjs`.
- `orch run` prints only the final text on stdout. Progress and errors go to stderr.
- Exit codes: `0` success, `1` every tier failed, `2` bad usage, config or input.
- Timeouts: Ollama health check `3000` ms, Ollama run `120000` ms, Claude run `300000` ms.

## Review Focus

1. **PC asleep, not off:** the connection hangs instead of being refused. The health check must give up after `healthTimeoutMs` and the attempt must be logged as `pc_unreachable`. (Task 2)
2. **Nothing staged:** `orch run --type commit-message` exits `2` with a clear message, calls no backend, writes no log line. (Task 6)
3. **Huge staged diff** (a lockfile, 1 MB): the prompt stays inside the budget and every changed file is still named. (Task 4)
4. **Chatty model output:** code fences, a `<think>` block or "Here is the commit message:" in front of the answer. Normalised before verification, not failed for it. (Task 3)
5. **Ollama is up but the model is not pulled (HTTP 404), or it returns empty content:** logged as `backend_error` naming the model, never as `pc_unreachable`. (Task 2)

## File map

| File | Responsibility |
|---|---|
| `src/core/types.ts` | Shared types and error classes |
| `src/core/config.ts` | Load, merge and validate config |
| `src/backends/backend.ts` | Re-exports `Backend`; `createBackend` factory |
| `src/backends/ollama.ts` | `/api/chat` call, health check, error classification |
| `src/backends/claude-cli.ts` | Spawn `claude -p`, serial queue, parse result |
| `src/core/verifier.ts` | `runChecks` and shared checks |
| `src/tasks/task.ts` | `cleanModelOutput`, task registry |
| `src/tasks/commit-message.ts`, `docstring.ts`, `test-stub.ts` | Prompt + verify per task type |
| `src/workspace/git.ts` | Read-only git queries |
| `src/core/context.ts` | Token estimate, fitting to budget, input collection |
| `src/log/run-log.ts` | Append and read JSONL, write raw outputs |
| `src/core/policy.ts` | `decideNext` |
| `src/core/orchestrator.ts` | `runTask` loop |
| `src/cli.ts` | `orch run`, `orch eval`, `orch report` |
| `eval/compare.ts`, `eval/fixed-tasks/` | Fixed task set and eval runner |
| `src/log/report.ts` | Aggregate log into per-model rows |

Two functions are marked **👤 yours to write**. They are small and they decide how the tool behaves, so an agent executing this plan stops there and hands them to you.

---

## Milestone 1: commit messages from the local model

### Task 1: Skeleton, shared types, config loader

**Files:**
- Delete: `export.sh`, `tests/export_test.sh`, `docs/superpowers/plans/2026-11-02-claude-config-export.md`, `docs/superpowers/specs/2026-11-02-claude-config-design.md`
- Create: `package.json`, `tsconfig.json`, `config/orchestrator.config.json`, `src/core/types.ts`, `src/core/config.ts`
- Modify: `.gitignore`, `README.md` (replace the template text with a one-paragraph description; the full README is Task 10)
- Test: `test/config.test.ts`

**Interfaces — Produces:**

```ts
// src/core/types.ts
export type FallbackReason = "pc_unreachable" | "timeout" | "verify_failed" | "backend_error";
export type VerifyStatus = "pass" | "fail" | "skipped";
export interface VerifyResult { status: "pass" | "fail"; detail: string }
export interface BackendRequest { prompt: string; timeoutMs: number; cwd?: string }
export interface BackendResult { text: string; durationMs: number; promptTokens?: number; outputTokens?: number; model?: string }
export interface Backend {
  id: string;                 // config key, e.g. "pc-ollama"
  name: string;               // "ollama:qwen2.5-coder:7b" | "claude-cli"
  kind: "local" | "cloud";
  model: string;
  timeoutMs: number;
  healthCheck(): Promise<boolean>;
  run(req: BackendRequest): Promise<BackendResult>;
}
export class BackendError extends Error { reason: Exclude<FallbackReason, "verify_failed">; /* constructor(reason, message) */ }
export class InputError extends Error {}    // exit code 2
export class ConfigError extends Error {}   // exit code 2
export interface TaskInput { text: string; stat?: string; filePath?: string; symbol?: string }
export interface PreparedTask {
  taskType: string;
  prompt: string;
  normalize(raw: string): string;
  verify?(output: string): VerifyResult;    // absent = verifier kind "none" -> logged as "skipped"
}
export interface AttemptRecord {
  runId: string; ts: string; repo: string | null; taskType: string;
  tier: number; attempt: number; backend: string; model: string;
  durationMs: number; promptTokens: number | null; outputTokens: number | null;
  verify: VerifyStatus; verifyDetail: string; escalated: boolean;
  fallbackReason: FallbackReason | null; outputFile: string | null;
  mode: "run" | "eval"; taskId: string | null;
}

// src/core/config.ts
export interface OllamaBackendConfig { type: "ollama"; baseUrl: string; model: string; timeoutMs: number; healthTimeoutMs: number; options: Record<string, unknown> }
export interface ClaudeCliBackendConfig { type: "claude-cli"; timeoutMs: number; model?: string }
export type BackendConfig = OllamaBackendConfig | ClaudeCliBackendConfig;
export interface OrchestratorConfig {
  backends: Record<string, BackendConfig>;
  chains: Record<string, string[]>;
  retryBeforeEscalate: number;   // 0..2
  promptTokenBudget: number;     // default 6000
  runsDir: string;               // absolute after loading; default "<project root>/runs"
}
export const PROJECT_ROOT: string;   // two levels above src/core
export function loadConfig(path?: string): OrchestratorConfig;
```

- [ ] **Step 1: Remove the template leftovers with `git rm`** (the four paths above). Add `node_modules/`, `runs/` and `config/orchestrator.local.json` to `.gitignore`.

- [ ] **Step 2: Create `package.json` and `tsconfig.json`, then run `npm install`**

`package.json`: `"name": "tiered-orchestrator"`, `"private": true`, `"type": "module"`, `"engines": {"node": ">=22.18"}`, `"bin": {"orch": "src/cli.ts"}`, scripts `"test": "node --test \"test/**/*.test.ts\""`, `"typecheck": "tsc --noEmit"`, `"orch": "node src/cli.ts"`.

`tsconfig.json` compiler options: `target ES2023`, `module NodeNext`, `moduleResolution NodeNext`, `strict`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `skipLibCheck`, `types ["node"]`; `include ["src", "test", "eval"]`.

- [ ] **Step 3: Write `config/orchestrator.config.json`**

```json
{
  "backends": {
    "pc-ollama": { "type": "ollama", "baseUrl": "http://PC_ADDRESS:11434", "model": "qwen2.5-coder:7b", "timeoutMs": 120000 }
  },
  "chains": { "commit-message": ["pc-ollama"] },
  "retryBeforeEscalate": 1
}
```

- [ ] **Step 4: Write the failing tests in `test/config.test.ts`**

Each test writes a config to a temp directory and calls `loadConfig(path)`:
- `applies defaults`: the JSON above loads with `healthTimeoutMs === 3000`, `options` deep-equal `{ num_ctx: 8192, temperature: 0.2 }`, `promptTokenBudget === 6000`, and `runsDir === path.join(PROJECT_ROOT, "runs")`.
- `merges the local file`: with `orchestrator.local.json` next to it containing `{"backends":{"pc-ollama":{"baseUrl":"http://10.0.0.5:11434"}}}`, `baseUrl` is replaced and `model` is still `qwen2.5-coder:7b`. The local file is looked up beside the config file, as `orchestrator.local.json`.
- `rejects a chain naming an unknown backend`: throws `ConfigError` whose message contains the backend name.
- `rejects an unknown backend type`, `rejects retryBeforeEscalate of 3`, `rejects a missing file`: each throws `ConfigError`.
- `rejects extra keys on a claude-cli backend`: `{"type":"claude-cli","timeoutMs":1,"bin":"/tmp/x"}` throws `ConfigError`. Only `type`, `timeoutMs` and `model` are allowed, so config can never point the Claude backend at another binary.

- [ ] **Step 5: Run `npm test`.** Expected: FAIL, `Cannot find module '../src/core/config.ts'`.
- [ ] **Step 6: Implement `src/core/types.ts` and `src/core/config.ts`** to the signatures above. `loadConfig()` with no argument reads `config/orchestrator.config.json` under `PROJECT_ROOT`.
- [ ] **Step 7: Run `npm test && npm run typecheck`.** Expected: all pass, no type errors.
- [ ] **Step 8: Commit** — `chore: project skeleton, shared types and config loader`.

### Task 2: Ollama backend

**Files:**
- Create: `src/backends/ollama.ts`, `src/backends/backend.ts`, `test/helpers/fake-ollama.ts`
- Test: `test/ollama.test.ts`

**Interfaces:**
- Consumes: `Backend`, `BackendError`, `OllamaBackendConfig` (Task 1).
- Produces:

```ts
// src/backends/ollama.ts
export class OllamaBackend implements Backend { constructor(id: string, cfg: OllamaBackendConfig) }
// src/backends/backend.ts
export function createBackend(id: string, cfg: BackendConfig, overrides?: { model?: string }): Backend;
// test/helpers/fake-ollama.ts
export function startFakeOllama(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void):
  Promise<{ url: string; requests: { method: string; path: string; body: string }[]; close(): Promise<void> }>;
```

Behaviour the tests pin:
- `run` sends `POST {baseUrl}/api/chat` with body `{ model, messages: [{ role: "user", content: prompt }], stream: false, options: cfg.options }` and `AbortSignal.timeout(req.timeoutMs)`.
- Result: `text = message.content`, `promptTokens = prompt_eval_count`, `outputTokens = eval_count`, `model = cfg.model`, `durationMs` measured locally.
- `healthCheck` is `GET {baseUrl}/api/tags` with `AbortSignal.timeout(cfg.healthTimeoutMs)`; `true` only on HTTP 200; never throws.
- `name` is `"ollama:" + model`; `kind` is `"local"`.

- [ ] **Step 1: Write `test/helpers/fake-ollama.ts`** (a `node:http` server on `127.0.0.1`, port 0).
- [ ] **Step 2: Write the failing tests in `test/ollama.test.ts`**

- `sends the chat request and maps the response`: the server replies `{"message":{"content":"Add helper"},"prompt_eval_count":12,"eval_count":3}`; assert the request body fields above and a result with `text "Add helper"`, `promptTokens 12`, `outputTokens 3`.
- `health check is true on 200` and `false when nothing listens` (use a closed port).
- `health check gives up on a hanging server`: the handler never responds, `healthTimeoutMs: 200`; resolves `false` in under 1000 ms. *(Review Focus 1)*
- `run times out`: handler never responds, `timeoutMs: 200`; rejects with `BackendError` whose `reason === "timeout"`.
- `run reports an unreachable host`: closed port; `reason === "pc_unreachable"`.
- `model not pulled is a backend error`: server replies 404 `{"error":"model 'x' not found"}`; `reason === "backend_error"` and the message contains the model name. *(Review Focus 5)*
- `empty content is a backend error`: `{"message":{"content":""}}`; `reason === "backend_error"`. *(Review Focus 5)*

- [ ] **Step 3: Run `npm test`.** Expected: FAIL, module not found.
- [ ] **Step 4: Implement `OllamaBackend` and `createBackend`.** Classification: an error named `TimeoutError` -> `timeout`; any other `fetch` rejection -> `pc_unreachable`; a non-2xx status, unparsable JSON or empty content -> `backend_error`. `createBackend` throws `ConfigError` for `claude-cli` until Task 7.
- [ ] **Step 5: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 6: Commit** — `feat: Ollama backend with health check and error classification`.

### Task 3: Output cleaning, verifier, commit-message task

**Files:**
- Create: `src/core/verifier.ts`, `src/tasks/task.ts`, `src/tasks/commit-message.ts`
- Test: `test/verifier.test.ts`, `test/commit-message.test.ts`

**Interfaces:**
- Consumes: `PreparedTask`, `TaskInput`, `VerifyResult` (Task 1). `fitDiff` arrives in Task 4; until then `prepare` uses the diff untrimmed.
- Produces:

```ts
// src/core/verifier.ts
export type Check = (output: string) => string | null;      // null = ok, string = why it failed
export function runChecks(output: string, checks: Check[]): VerifyResult;   // first failure wins; detail "" on pass
export const nonEmpty: Check;
export const noCodeFence: Check;
export function maxLines(n: number): Check;
// src/tasks/task.ts
export function cleanModelOutput(raw: string): string;
export interface TaskModule { type: string; prepare(input: TaskInput, budgetTokens: number): PreparedTask }
export const taskModules: Record<string, TaskModule>;       // commit-message now; two more in Task 8
// src/tasks/commit-message.ts
export const commitMessage: TaskModule;
export function isImperativeish(subject: string): boolean;  // 👤 yours to write
```

`cleanModelOutput` rules, in order: remove every `<think>...</think>` block, and a leading unclosed `<think>` up to the end of its paragraph; trim; if the whole text is one fenced block, keep only its inside; if the result is a single line wrapped in matching quotes or backticks, remove them; trim.

Commit-message `normalize` is `cleanModelOutput` plus: drop a first line that ends with `:` and matches `/^(here('s| is)|sure|certainly|commit message)/i`.

Commit-message checks, in order:
1. `nonEmpty`
2. subject (line 1) is at most 72 characters — detail `subject is N chars (max 72)`
3. subject does not end with `.`
4. `noCodeFence`
5. subject does not match `/^(here('s| is)|sure|certainly|this commit|the following)/i`
6. if there is a second line, it is blank
7. `maxLines(20)`
8. `isImperativeish(subject)` — detail `subject should start with an imperative verb ("Add", not "Added"/"Adds"/"Adding")`

Prompt (exact copy):

```
You write git commit messages.

Rules:
- Line 1: a subject of at most 72 characters, imperative mood ("Add", "Fix", "Remove"), no trailing period.
- Optionally a blank line, then a short body explaining why.
- Output only the commit message. No quotes, no code fences, no explanation.

Changed files:
{stat}

Diff:
{diff}
```

- [ ] **Step 1: Write the failing tests**

`test/verifier.test.ts`: `runChecks` returns `pass` with empty detail when all checks return null, and the first failing check's detail otherwise.

`test/commit-message.test.ts`:
- `cleanModelOutput` *(Review Focus 4)*: `"<think>hmm</think>\nAdd x"` -> `"Add x"`; ``"```\nAdd x\n```"`` -> `"Add x"`; `"\"Add x\""` -> `"Add x"`; `"Add x\n\nBody"` is unchanged.
- `normalize` drops `"Here is the commit message:\nAdd x"` down to `"Add x"`.
- `verify` passes `"Add retry to fetch helper"` and `"fix: handle empty diff\n\nThe CLI crashed."`.
- `verify` fails, each with its own detail: `""`; a 73-character subject; `"Add x."`; `"Add x\nbody without blank line"`.
- `isImperativeish` is `true` for `"Add retry to fetch"`, `"fix: handle empty diff"`, `"feat(cli): add --model flag"`; `false` for `"Added retry"`, `"Fixes bug"`, `"Adding tests"`, `"feat(cli): adds flag"`.
- `prepare({ text: "DIFF", stat: "STAT" }, 6000).prompt` contains `"DIFF"`, `"STAT"` and `"at most 72 characters"`.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL, modules not found.
- [ ] **Step 3: Implement `verifier.ts`, `task.ts` and `commit-message.ts`, leaving `isImperativeish` as a stub** that throws `new Error("TODO(you): isImperativeish")`, with this comment above it:

```ts
// 👤 Yours to write (5-10 lines). Decide what "imperative-ish" means.
// Skip an optional conventional-commit prefix ("fix:", "feat(cli):") and look at the first word.
// Trade-off: a suffix rule (-ed, -ing, third-person -s) is tiny but rejects "Embed", "Bring", "Pass", "Address";
// a deny-list of known offenders ("added", "fixes", "updating", ...) never rejects a good subject but misses rare verbs.
// A false reject costs one retry and maybe an escalation; a false accept costs a slightly worse message.
```

- [ ] **Step 4: 👤 Stop. You write the body of `isImperativeish`.** The tests in Step 1 cover only the clear cases; the edge cases in the comment are your call. Add a test for each one you decide.
- [ ] **Step 5: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 6: Commit** — `feat: commit-message task with format verifier`.

### Task 4: Read-only git and the context budget

**Files:**
- Create: `src/workspace/git.ts`, `src/core/context.ts`, `test/helpers/temp-repo.ts`
- Modify: `src/tasks/commit-message.ts` (call `fitDiff`)
- Test: `test/context.test.ts`, `test/git.test.ts`

**Interfaces:**
- Consumes: `InputError`, `TaskInput` (Task 1).
- Produces:

```ts
// src/workspace/git.ts — read-only until M4
export function stagedDiff(repo: string): Promise<{ stat: string; diff: string }>;
// src/core/context.ts
export function estimateTokens(text: string): number;                              // Math.ceil(length / 4)
export function fitDiff(diff: string, budgetTokens: number): string;
export function fitSource(source: string, symbol: string, budgetTokens: number): string;   // used from Task 8
export function collectInput(taskType: string, args: { repo: string; file?: string; symbol?: string }): Promise<TaskInput>;
// test/helpers/temp-repo.ts
export function makeTempRepo(files: Record<string, string>, opts?: { stage?: boolean }): Promise<string>;   // git init + write + optional git add
```

`stagedDiff` runs `git -C <repo> diff --staged --no-color --no-ext-diff` and the same with `--stat`, through `execFile` with `maxBuffer` 20 MB. A failing `git` (not a repository, git missing) becomes `InputError`.

`fitDiff`: when the diff is within budget, return it unchanged. Otherwise split it at lines starting with `diff --git`, give every file an equal share of `budgetTokens * 4` characters, cut each file's section at a line boundary, and append `[... N more lines truncated ...]` to each cut section. Every file's `diff --git` header line survives.

`collectInput("commit-message", { repo })` returns `{ text: diff, stat }`, and throws `InputError("nothing staged in <repo>: stage changes with git add first")` when the diff is empty. Other task types throw `InputError("unknown task type")` until Task 8.

- [ ] **Step 1: Write the failing tests**

- `estimateTokens("abcdefgh") === 2`.
- `fitDiff leaves a small diff alone`.
- `fitDiff keeps every file and stays in budget` *(Review Focus 3)*: three files, one with 20 000 added lines; with budget 1000, `estimateTokens(result) <= 1000`, all three `diff --git a/...` headers are present, and the result contains `more lines truncated`.
- `stagedDiff returns the staged change`: temp repo with `a.txt` staged; `diff` contains `+hello`, `stat` contains `a.txt`.
- `stagedDiff works with a space in the repo path`.
- `collectInput rejects an empty stage`: temp repo, nothing staged; rejects with `InputError` matching `/nothing staged/`.
- `collectInput rejects a directory that is not a repository`: `InputError`.
- `commit-message prepare trims a large diff`: with a 200 000-character diff and budget 6000, `estimateTokens(prompt) <= 6000`.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `commit-message.ts`, the diff's budget is `budgetTokens` minus the estimate of the template and the stat.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: staged-diff reader and prompt budget`.

### Task 5: Run log

**Files:**
- Create: `src/log/run-log.ts`
- Test: `test/run-log.test.ts`

**Interfaces:**
- Consumes: `AttemptRecord` (Task 1).
- Produces:

```ts
export class RunLog {
  constructor(runsDir: string);                 // creates the directory on first write
  newRunId(): string;                           // "YYYYMMDD-HHMMSS-" + 6 hex chars
  writeOutput(runId: string, tier: number, attempt: number, text: string): string;
      // writes <runsDir>/<runId>/tier<T>-attempt<A>.txt, returns "<basename of runsDir>/<runId>/tier<T>-attempt<A>.txt"
  append(rec: AttemptRecord): void;             // one JSON line appended to <runsDir>/log.jsonl
  readAll(): AttemptRecord[];                   // [] when the file is absent; skips lines that are not valid JSON
}
```

- [ ] **Step 1: Write the failing tests**: `append` then `readAll` round-trips two records in order; `readAll` on a fresh directory is `[]`; a log with a truncated last line (`{"runId":"x","ts`) still returns the complete records; `writeOutput(id, 0, 1, "hi")` returns a path ending in `/tier0-attempt1.txt` and the file contains `hi`; two `newRunId()` calls differ and match `/^\d{8}-\d{6}-[0-9a-f]{6}$/`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** with `appendFileSync`.
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: JSONL run log`.

### Task 6: Policy, the run loop, and `orch run`

**Files:**
- Create: `src/core/policy.ts`, `src/core/orchestrator.ts`, `src/cli.ts`, `test/helpers/fake-backend.ts`
- Test: `test/policy.test.ts`, `test/orchestrator.test.ts`, `test/cli-run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:

```ts
// src/core/policy.ts
export type Decision = "retry" | "escalate" | "stop";
export function decideNext(s: {
  reason: FallbackReason; backendKind: "local" | "cloud";
  retriesUsed: number; retryBeforeEscalate: number; isLastTier: boolean;
}): Decision;                                                       // 👤 yours to write
export function buildRetryPrompt(original: string, previousOutput: string, verifyDetail: string): string;

// src/core/orchestrator.ts
export interface RunOutcome { runId: string; ok: boolean; text: string | null; attempts: AttemptRecord[] }
export function runTask(opts: {
  task: PreparedTask; chain: Backend[]; retryBeforeEscalate: number; log: RunLog;
  repo: string | null; mode: "run" | "eval"; taskId?: string;
  onProgress?: (line: string) => void;
}): Promise<RunOutcome>;

// test/helpers/fake-backend.ts
export function fakeBackend(opts: { id: string; kind?: "local" | "cloud"; healthy?: boolean;
  replies: (string | BackendError)[] }): Backend & { prompts: string[] };
```

`runTask`, per tier in chain order:
1. `healthCheck()`. If `false`: write a record with `verify "skipped"`, `outputFile null`, `durationMs 0`, and `fallbackReason` `pc_unreachable` for a local backend or `backend_error` for a cloud one. Then decide.
2. `run({ prompt, timeoutMs: backend.timeoutMs })`. A `BackendError` becomes a record with `verify "skipped"` and that error's reason. Any other thrown error is recorded as `backend_error`.
3. On a result: save the raw text with `writeOutput`, `normalize` it, `verify` it. `pass`, or `skipped` when the task has no verifier, ends the run with `ok: true` and the normalised text. `fail` sets `fallbackReason "verify_failed"` and `verifyDetail`.
4. After any failure call `decideNext`. `retry` runs the same backend again with `buildRetryPrompt`; `escalate` sets `escalated: true` on that record and moves on; `stop` ends the run with `ok: false`.

`buildRetryPrompt` (exact copy; the previous output is cut to 2000 characters):

```
{original}

---
Your previous answer was rejected by an automatic check.
Reason: {verifyDetail}
Previous answer:
{previousOutput}

Reply with a corrected answer only.
```

CLI: `orch run --type <type> [--repo <path>] [--file <path>] [--symbol <name>] [--config <path>] [--model <name>]`. `--repo` defaults to `.`. `--model` overrides the model of every `ollama` backend in the chain. A task type with no chain in the config is a `ConfigError`. Each attempt prints one stderr line, for example `tier 0 pc-ollama (qwen2.5-coder:7b): verify fail: subject is 81 chars (max 72) -> retry`.

- [ ] **Step 1: Write the failing tests**

`test/policy.test.ts` (this is the recommended default; change the tests first if you want a different policy):
- `verify_failed` on a local backend with `retriesUsed 0`, `retryBeforeEscalate 1` -> `"retry"`.
- the same with `retriesUsed 1` -> `"escalate"`; with `isLastTier: true` -> `"stop"`.
- `verify_failed` on a cloud backend with retries left -> `"escalate"`, or `"stop"` on the last tier.
- `pc_unreachable`, `timeout` and `backend_error` never return `"retry"`.
- `buildRetryPrompt("P", "OUT", "why")` contains `P`, `OUT`, `Reason: why`, and cuts a 5000-character previous output to 2000.

`test/orchestrator.test.ts`, with `fakeBackend` and a `RunLog` in a temp directory:
- `passes on the first try`: one record, `tier 0`, `attempt 0`, `verify "pass"`, `escalated false`, `fallbackReason null`; `ok` is true and `text` is the normalised reply.
- `retries once with the failure in the prompt`: local replies `["Added x.", "Add x"]`; two records (`attempt 0` fail with `verify_failed`, `attempt 1` pass); the second prompt contains `Reason:`.
- `escalates after the retry fails`: local replies two bad answers, cloud replies a good one; three records, the second has `escalated true`, the third has `tier 1`.
- `skips an unreachable PC`: local `healthy: false`; first record has `fallbackReason "pc_unreachable"`, `verify "skipped"`, `outputFile null`, `escalated true`, and the local backend received no prompt.
- `a timeout escalates without a retry`: local replies `[new BackendError("timeout", "t")]`; exactly one local record.
- `all tiers fail`: `ok false`, `text null`, last record `escalated false`.
- `a task with no verifier is logged as skipped and succeeds`.
- `eval mode stamps the records`: `mode "eval"`, `taskId "cm-01"`.

`test/cli-run.test.ts`, spawning `node src/cli.ts` with a temp config (absolute `runsDir`), a temp repo and `startFakeOllama`:
- `prints the message and logs one line`: the server replies `Add greeting helper`; stdout is exactly `"Add greeting helper\n"`, exit code `0`, `log.jsonl` has one line with `verify "pass"` and `repo` equal to the repo's absolute path.
- `nothing staged` *(Review Focus 2)*: exit code `2`, stderr matches `/nothing staged/`, the fake server saw zero `/api/chat` requests, `log.jsonl` does not exist.
- `PC unreachable`: `baseUrl` on a closed port; exit code `1`, stdout empty, the log line has `fallbackReason "pc_unreachable"`.
- `unknown flag or missing --type`: exit code `2`, stderr contains a usage line.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement `buildRetryPrompt`, `orchestrator.ts`, `fake-backend.ts` and `cli.ts`, leaving `decideNext` as a stub** that throws `new Error("TODO(you): decideNext")`, with this comment:

```ts
// 👤 Yours to write (5-10 lines). This is the whole escalation policy.
// Inputs: why the attempt failed, whether the backend is local or cloud, retries already used at this tier,
// the configured retry count, and whether a stronger tier exists.
// Think about: a retry on "cloud" spends a subscription call; a retry after pc_unreachable or timeout
// will very likely fail the same way; on the last tier the only choices are "retry" and "stop".
```

- [ ] **Step 4: 👤 Stop. You write the body of `decideNext`.**
- [ ] **Step 5: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 6: Commit** — `feat: run loop, escalation policy and orch run`.

### M1 check on the Mac (manual, PC on)

- [ ] `curl http://<pc>:11434/api/tags` lists the model. Put the address in `config/orchestrator.local.json`.
- [ ] `npm link`, stage a change in any repo, run `orch run --type commit-message --repo .`. A message prints; `runs/log.jsonl` gains a line.
- [ ] Put the PC to sleep and run it again. It exits `1` in about 3 seconds and the new log line says `pc_unreachable`.

---

## Milestone 2: Claude tier, docstrings, test stubs

### Task 7: `claude-cli` backend

**Files:**
- Create: `src/backends/claude-cli.ts`, `test/fixtures/fake-claude.mjs` (executable), `docs/claude-cli-flags.md`
- Modify: `src/backends/backend.ts` (`createBackend` builds it), `config/orchestrator.config.json` (add the `claude` backend with `timeoutMs` 300000; chain becomes `["pc-ollama", "claude"]`)
- Test: `test/claude-cli.test.ts`

**Interfaces:**
- Consumes: `Backend`, `BackendError`, `ClaudeCliBackendConfig`.
- Produces: `export class ClaudeCliBackend implements Backend { constructor(id: string, cfg: ClaudeCliBackendConfig, testOnly?: { bin: string }) }`. `createBackend` never passes `testOnly`, so the only binary reachable from config is `claude` on `PATH`.

Flags, read from `claude --help` of version 2.1.322 (not guessed):

| Flag | Why |
|---|---|
| `-p` | print the response and exit |
| `--output-format json` | one JSON result object on stdout |
| `--tools ""` | no tools: Claude is a stateless worker here too |
| `--no-session-persistence` | do not save these one-shot calls as sessions |
| `--safe-mode` | no CLAUDE.md, plugins, hooks or MCP servers leaking into the prompt |
| `--model <name>` | only when `cfg.model` is set |

Never pass `--bare`: its help text says OAuth and keychain are never read, so it would demand an API key. Never pass `--dangerously-skip-permissions`.

The prompt is written to the child's stdin. The working directory is a fresh `mkdtemp` directory under `os.tmpdir()` unless `req.cwd` is given. The environment is `process.env`, untouched. `healthCheck` runs `claude --version` and is `true` on exit code 0.

Result parsing: `text = json.result`; `promptTokens = json.usage?.input_tokens`; `outputTokens = json.usage?.output_tokens`; `model` is the first key of `json.modelUsage`, else `cfg.model`, else `"default"`. Exit code not 0, unparsable JSON, `json.is_error === true` or a non-string `result` -> `BackendError("backend_error")`. On timeout the child gets `SIGTERM` and the error is `BackendError("timeout")`.

Calls are serialised by a module-level promise chain: a second `run` starts only after the first settles, across all instances.

- [ ] **Step 1: On the Mac, run `claude --version` and `claude --help`, and confirm each flag in the table exists.** Write the version and the table to `docs/claude-cli-flags.md`. If a flag is missing on the Mac's version, remove it from the table and from the implementation; do not substitute a guess.
- [ ] **Step 2: Write `test/fixtures/fake-claude.mjs`.** It reads stdin, appends `start <pid> <ms>` and `end <pid> <ms>` lines to the file named by `FAKE_CLAUDE_TRACE`, and behaves by `FAKE_CLAUDE_MODE`: `ok` prints `{"type":"result","is_error":false,"result":"<stdin text reversed>","usage":{"input_tokens":5,"output_tokens":2},"modelUsage":{"fake-model":{}}}` after 100 ms; `error` exits with code 1; `is_error` prints the JSON with `"is_error":true`; `badjson` prints `not json`; `hang` never exits. With `--version` as its only argument it prints `0.0.0 (fake)`. It also writes its argument list to the file named by `FAKE_CLAUDE_ARGS`.
- [ ] **Step 3: Write the failing tests** (all construct the backend with `testOnly.bin` set to the fixture):
  - `passes the documented flags and the prompt on stdin`: the recorded arguments are exactly `["-p","--output-format","json","--tools","","--no-session-persistence","--safe-mode"]`, and the result text is the reversed prompt.
  - `adds --model when configured`.
  - `maps tokens and model`: `promptTokens 5`, `outputTokens 2`, `model "fake-model"`.
  - `error`, `is_error` and `badjson` modes each reject with `reason "backend_error"`.
  - `hang` with `timeoutMs: 300` rejects with `reason "timeout"`, and the child process is gone afterwards.
  - `healthCheck` is `true` for the fixture and `false` for a path that does not exist.
  - `runs one call at a time`: two `run` calls started together; in the trace file the first `end` comes before the second `start`.
  - `does not run in the caller's directory`: the fixture records `process.cwd()`; it is under `os.tmpdir()`.
- [ ] **Step 4: Run `npm test`.** Expected: FAIL.
- [ ] **Step 5: Implement `ClaudeCliBackend`, wire `createBackend`, update the config file.**
- [ ] **Step 6: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 7: On the Mac, one real call:** stage a change and run `orch run --type commit-message` with the PC off. The message comes from Claude, and the log has a `pc_unreachable` line followed by a `tier 1` pass. If the call fails to sign in with `--safe-mode`, remove that flag and note it in `docs/claude-cli-flags.md`. If the parser rejects the real JSON, save that output as `test/fixtures/claude-result.json`, add a parsing test from it, and fix the field names.
- [ ] **Step 8: Commit** — `feat: claude-cli backend with serial queue`.

### Task 8: `docstring` and `test-stub` tasks

**Files:**
- Create: `src/tasks/docstring.ts`, `src/tasks/test-stub.ts`
- Modify: `src/tasks/task.ts` (register both), `src/core/context.ts` (`fitSource`, `collectInput` for both types), `config/orchestrator.config.json` (chains for both: `["pc-ollama", "claude"]`)
- Test: `test/docstring.test.ts`, `test/test-stub.test.ts`, additions to `test/context.test.ts` and `test/cli-run.test.ts`

**Interfaces:**
- Consumes: `TaskModule`, `runChecks`, `cleanModelOutput`, `fitSource`.
- Produces: `export const docstring: TaskModule`, `export const testStub: TaskModule`, and `export function languageOf(filePath: string): "js" | "py"` in `src/tasks/task.ts` (`.ts .tsx .js .jsx .mjs .cjs` -> `"js"`, `.py` -> `"py"`, anything else throws `InputError("unsupported file type")`).

Both tasks take `--file` and `--symbol`, both required. `--file` is resolved against `--repo`. Neither writes to the file: the result is printed.

`fitSource`: return the whole file when it fits. Otherwise find the declaration line (first line matching `\b(function|class|const|let|var|def|interface|type)\s+\*?\s*<symbol>\b`, else the first line matching `\b<symbol>\s*[(=:]`) and return a window of whole lines around it that fits the budget, one third before and two thirds after. If the symbol is not found, throw `InputError("symbol <name> not found in <file>")`; this check also runs when the file fits.

Docstring prompt must state: write a documentation comment for `<symbol>`; JSDoc `/** ... */` for `"js"`, a triple-quoted docstring for `"py"`; describe purpose, parameters and return value; output only the comment, with no code and no fences.

Docstring checks: `nonEmpty`; `noCodeFence`; `maxLines(40)`; then for `"js"`: starts with `/**`, ends with `*/`, and `*/` occurs exactly once; for `"py"`: starts and ends with `"""` and `"""` occurs exactly twice; then at least one line that still has text after removing leading `*`, whitespace and `@tag` words.

Test-stub prompt must state: write a test file for `<symbol>` from `<file name>`; for `"js"` use `node:test` and `node:assert/strict` and import the symbol from the file; for `"py"` use pytest; two to four test cases; output only the file content.

Test-stub checks: `nonEmpty`; `noCodeFence`; `maxLines(150)`; the symbol appears as a whole word; then for `"js"`: matches `/\b(test|it)\s*\(/`, matches `/\bimport\b|\brequire\s*\(/`, and the counts of `{`/`}` and of `(`/`)` are equal (detail `unbalanced braces: output looks cut off`); for `"py"`: matches `/^def test_\w+\(/m` and `/^(import|from)\s/m`.

- [ ] **Step 1: Write the failing tests**
  - `languageOf` for `a.ts`, `a.py`, and `a.rb` (throws).
  - `fitSource`: a small file is returned whole; with a 5000-line file and the symbol at line 2500, the result fits the budget and contains the declaration line; a missing symbol throws `InputError`.
  - Docstring `verify` passes `"/**\n * Clamp n to [lo, hi].\n * @param n value\n */"` for `a.ts` and `"\"\"\"Slugify a title.\"\"\""` for `a.py`. It fails: `"/** x */\nfunction f() {}"`; `"/**\n * @param n\n */"` (tags only); a JSDoc answer for a `.py` file.
  - Test-stub `verify` passes a four-line `node:test` file that imports and calls `clamp`. It fails: no `test(` call; the symbol never mentioned; the same file with its last `})` removed.
  - CLI: `orch run --type docstring --file src/a.ts --symbol clamp` against the fake server prints the comment; without `--symbol` it exits `2`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: docstring and test-stub tasks`.

---

## Milestone 3: compare models

### Task 9: Fixed task set and `orch eval`

**Files:**
- Create: `eval/compare.ts`, `eval/fixed-tasks/<id>/task.json` plus one input file each (12 tasks)
- Modify: `src/cli.ts` (`eval` subcommand)
- Test: `test/eval.test.ts`

**Interfaces:**
- Consumes: `runTask`, `taskModules`, `createBackend`, `RunLog`.
- Produces:

```ts
export interface FixedTask { id: string; taskType: string; input: TaskInput }
export function loadFixedTasks(dir: string): FixedTask[];        // sorted by id
export function runEval(opts: { backend: Backend; tasks: FixedTask[]; budgetTokens: number; log: RunLog;
  onProgress?: (line: string) => void }): Promise<{ id: string; ok: boolean; reason: FallbackReason | null; durationMs: number }[]>;
```

`task.json` is `{ "taskType": "...", "inputFile": "input.diff", "symbol": "clamp" }` (`symbol` only for docstring and test-stub). The directory name is the id. `input.text` is the content of `inputFile`; `input.filePath` is its name.

The 12 tasks (write small, realistic inputs, 10–60 lines each):

| id | input |
|---|---|
| `cm-01-rename-variable` | diff renaming one variable in one file |
| `cm-02-add-null-check` | diff adding a guard clause |
| `cm-03-new-cli-flag` | diff over two files adding a `--verbose` flag |
| `cm-04-delete-dead-code` | diff removing an unused function |
| `cm-05-readme-typo` | diff fixing a typo in a README |
| `ds-01-ts-pure-function` | `clamp(n, lo, hi)` in TypeScript |
| `ds-02-ts-async-fetch` | async `fetchJson(url, timeoutMs)` |
| `ds-03-ts-class-method` | a `Cache` class, symbol `get` |
| `ds-04-py-function` | `slugify(title)` in Python |
| `ts-01-ts-clamp` | the `clamp` file again, for a test stub |
| `ts-02-ts-parse-duration` | `parseDuration("1h30m")` |
| `ts-03-py-slugify` | the `slugify` file again |

`runEval`: check health once; if the backend is down, throw `BackendError("pc_unreachable")` before logging anything. Then, one task at a time, call `runTask` with `chain: [backend]`, `retryBeforeEscalate: 0`, `mode: "eval"`, `taskId`, `repo: null`. Stop early if a task's reason is `pc_unreachable`.

CLI: `orch eval --backend <id> [--model <name>] [--type <taskType>] [--config <path>]`. A backend of kind `"cloud"` is refused with exit code `2` and `eval refuses cloud backends: no bulk runs against the subscription`. Output is a table on stdout (`task`, `result`, `ms`) and a last line `N/M passed`. Exit code `0` when the eval ran, whatever the pass count; `1` when the backend was unreachable.

- [ ] **Step 1: Write the failing tests**
  - `loadFixedTasks` on the real directory returns 12 tasks with unique ids, every `taskType` is a key of `taskModules`, and `prepare(input, 6000)` does not throw for any of them.
  - `runEval logs one eval record per task`: fake backend with good replies for two tasks; two records with `mode "eval"` and the right `taskId`.
  - `runEval does not retry`: a bad reply yields exactly one record for that task.
  - `runEval aborts on an unreachable backend`: `healthy: false`; rejects, and `readAll()` is empty.
  - CLI `refuses a cloud backend`: `orch eval --backend claude` exits `2`, stderr matches `/refuses cloud backends/`, and the `fake-claude` trace file stays empty.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Write the 12 fixed tasks, then implement `eval/compare.ts` and the subcommand.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit** — `feat: fixed task set and orch eval`.

### Task 10: `orch report` and the README

**Files:**
- Create: `src/log/report.ts`
- Modify: `src/cli.ts` (`report` subcommand), `README.md`, `CLAUDE.md` (replace "Open decisions for the first session" with the decisions from the top of this plan)
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `AttemptRecord`, `RunLog.readAll`.
- Produces:

```ts
export interface ModelRow { backend: string; model: string; attempts: number; passRate: number;
  escalationRate: number | null; avgMs: number; unreachable: number }
export function summarize(records: AttemptRecord[], filter?: { mode?: "run" | "eval"; taskType?: string }): ModelRow[];
export function formatTable(rows: ModelRow[]): string;
```

Definitions, per `backend` + `model` group:
- `unreachable`: records with `fallbackReason "pc_unreachable"`. They are left out of every other number.
- `attempts`: the remaining records.
- `passRate`: records with `fallbackReason null` divided by `attempts`. A timeout counts against the model; a sleeping PC does not.
- `escalationRate`: among `mode "run"` records only, runs (by `runId`) where this group has a record with `escalated true`, divided by runs where this group has any counted record. `null` when the group has no `run` records.
- `avgMs`: mean `durationMs` over `attempts`.
- Rows are sorted by `passRate`, highest first.

CLI: `orch report [--mode run|eval] [--type <taskType>] [--config <path>]`. Columns: `backend`, `model`, `attempts`, `pass %`, `escalated %`, `avg s`, `pc down`. An empty log prints `no runs logged yet` and exits `0`.

README sections: what it is; requirements (Node >= 22.18, `claude` signed in, Ollama on the PC); PC setup (set `OLLAMA_HOST` so Ollama listens on the LAN or Tailscale address, allow port 11434 in the firewall for the private network only, never forward the port on the router); Mac setup (`npm install`, `npm link`, `config/orchestrator.local.json`); the three commands with examples; how to swap models (`--model`, or the local config); the hard rules, linked to `CLAUDE.md`.

- [ ] **Step 1: Write the failing tests** with hand-built records:
  - `pass rate ignores unreachable attempts`: 3 pass, 1 `verify_failed`, 2 `pc_unreachable` -> `attempts 4`, `passRate 0.75`, `unreachable 2`.
  - `groups by model`: the same backend id with two models gives two rows.
  - `escalation rate counts runs, not attempts`: run A = fail, retry fail with `escalated true`; run B = pass -> `escalationRate 0.5`.
  - `eval-only groups have a null escalation rate`, shown as `-` by `formatTable`.
  - `filter by mode and by task type`.
  - `a timeout lowers the pass rate`.
  - CLI: an empty runs directory prints `no runs logged yet`, exit `0`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement `report.ts` and the subcommand; write the README; update `CLAUDE.md`.**
- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: pass.
- [ ] **Step 5: On the Mac, with the PC on:** `orch eval --backend pc-ollama`, then again with `--model` set to a second model, then `orch report --mode eval`. Two rows appear.
- [ ] **Step 6: Commit** — `feat: orch report and README`.

---

## Milestone 4 (not planned here)

`small-edit` gets its own plan, written only if M1–M3 turned out to be fun. It will add the git write side (`git worktree add` on a throwaway branch, apply, revert), the shell-command verifier that runs the target project's own test command, and the `--commit` flag. Constraints it inherits from the spec: never touch the user's main branch or working tree, no auto-commit without `--commit`, no destructive commands, and the local model still only returns text (the orchestrator applies it).
