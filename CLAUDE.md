# Tiered Coding Orchestrator (working name — rename freely)

A small TypeScript CLI that runs coding-related tasks on the cheapest backend that can do them, verifies the result, and escalates to a stronger backend only when verification fails. Cheap tier = a local model served by Ollama on a separate PC. Strong tier = the official `claude` CLI on this Mac. It is a fun side project: **zero money spent, no API keys, no billing.**

## Setup this project assumes
- **Mac (this machine):** repos, the orchestrator, test runs, the `claude` CLI signed in with the user's own subscription.
- **PC (same home network, optionally Tailscale):** runs Ollama only. RTX 3060 Ti 8GB VRAM, 16GB RAM, so models are limited to ~7–9B at 4-bit (e.g. Qwen2.5-Coder 7B, Qwen 3.5 9B, Falcon H1R 7B). Model name must be swappable via config; the user will test several.
- The PC may be off or asleep. That is a normal condition, not an error.

## Core idea
1. A **task** has a type (e.g. `commit-message`, `docstring`, `test-stub`, later `small-edit`).
2. The orchestrator builds a small, focused prompt (target <= 8K tokens) from the repo.
3. Each task type has an ordered **chain of backends** (tier 0 = local, tier 1 = Claude).
4. Run tier 0 -> **verify** -> if it fails, optionally retry once with the failure output -> escalate to next tier.
5. Log every attempt to JSONL so models and tiers can be compared by pass rate, escalation rate and time.

For `orch run` and `orch eval` the local model is a **stateless worker**: it gets a prompt and returns text.

In the chat (`orch` with no arguments, or `orch chat`) the local model drives an **agent loop** through tool calls. Small models are unreliable at this, so the orchestrator still owns the files and the shell: the model only asks for a tool; reads stay inside the repository and skip secrets files; every command needs the user's approval unless it is on the allow-list; and a refuse-list in `src/agent/permissions.ts` stops the common forms of destructive commands whatever the user answers; it is a backstop, and the user's approval of every other command is the real control. A router decides per message whether the local model or Claude answers, and a turn the local model cannot finish is handed to Claude.

## Hard rules (do not violate)
- The Claude backend ONLY spawns the unmodified `claude` binary as a subprocess (`claude -p ...`), using whatever login the user already has. Never read, copy, extract or proxy OAuth tokens or credentials. Never route the subscription through a gateway/proxy. Check `claude --help` for the exact flags; do not guess. In the chat, `claude -p` may be given the read-only tools `Read`, `Grep` and `Glob` in the repository; it is never given a tool that writes files or runs commands.
- Run Claude calls sequentially (concurrency 1). No unattended bulk/benchmark runs against the subscription.
- Never expose Ollama to the internet. Assume it is reachable only on the LAN/Tailscale at `http://<pc>:11434`.
- Never write to the user's main branch. Code-changing tasks apply on a throwaway branch or git worktree, and never auto-commit unless a `--commit` flag is passed.
- No destructive commands (no `rm -rf`, no `git reset --hard` on the user's working tree).
- No paid APIs, no new paid dependencies.

## Proposed structure
```
tiered-orchestrator/
├── CLAUDE.md                  # this file
├── README.md
├── package.json / tsconfig.json
├── config/
│   └── orchestrator.config.json   # backends, models, chains per task type, timeouts
├── src/
│   ├── cli.ts                 # `orch run`, `orch eval`, `orch report`
│   ├── core/
│   │   ├── orchestrator.ts    # run loop: tier -> verify -> retry -> escalate
│   │   ├── policy.ts          # escalation rules (retry count, fallback reasons)
│   │   ├── context.ts         # picks files/diff, builds prompt, enforces token budget
│   │   ├── verifier.ts        # verifier kinds: schema/format check, shell command (tests/lint), none
│   │   └── types.ts
│   ├── backends/
│   │   ├── backend.ts         # Backend interface
│   │   ├── ollama.ts          # POST /api/chat, stream:false, health check, timeout
│   │   └── claude-cli.ts      # spawn `claude -p`, capture output, timeout
│   ├── tasks/
│   │   ├── commit-message.ts  # prompt template + verifier
│   │   ├── docstring.ts
│   │   └── test-stub.ts
│   ├── workspace/
│   │   └── git.ts             # diff, branch/worktree, apply patch, revert
│   └── log/
│       └── run-log.ts         # append JSONL records
├── eval/
│   ├── fixed-tasks/           # 10–15 easy tasks reused to compare models
│   └── compare.ts             # run fixed set against a model, print table
├── runs/                      # gitignored: JSONL logs + raw model outputs
└── test/
```

## Key interfaces (sketch)
```ts
interface Backend {
  name: string;                      // "ollama:qwen2.5-coder:7b" | "claude-cli"
  kind: "local" | "cloud";
  healthCheck(): Promise<boolean>;
  run(req: { prompt: string; timeoutMs: number; cwd?: string }): Promise<{
    text: string; durationMs: number; promptTokens?: number; outputTokens?: number;
  }>;
}
```

Config shape (example):
```json
{
  "backends": {
    "pc-ollama": { "type": "ollama", "baseUrl": "http://PC_ADDRESS:11434", "model": "qwen2.5-coder:7b", "timeoutMs": 120000 },
    "claude":    { "type": "claude-cli", "timeoutMs": 300000 }
  },
  "chains": {
    "commit-message": ["pc-ollama", "claude"],
    "docstring":      ["pc-ollama", "claude"]
  },
  "retryBeforeEscalate": 1
}
```

Log record (one JSON line per attempt):
```json
{ "runId": "", "ts": "", "repo": "", "taskType": "", "tier": 0, "backend": "pc-ollama",
  "model": "", "durationMs": 0, "promptTokens": null, "outputTokens": null,
  "verify": "pass|fail|skipped", "verifyDetail": "", "escalated": false,
  "fallbackReason": null, "outputFile": "runs/<runId>/tier0.txt" }
```
`fallbackReason` is one of `pc_unreachable | timeout | verify_failed | backend_error | null` — keep PC outages separate from model-quality failures so they do not pollute comparisons.

## Milestones
1. **M1 (weekend 1):** `orch run --type commit-message --repo .` -> builds prompt from `git diff --staged`, sends to Ollama, verifies format (non-empty, subject <= 72 chars, imperative-ish), prints result, writes a log line. No Claude yet.
2. **M2:** `claude-cli` backend, health check + timeout fallback, escalation on verify failure, `docstring` and `test-stub` task types.
3. **M3:** `orch eval --backend pc-ollama` runs the fixed task set; `orch report` prints pass rate / escalation rate / avg time per model from the logs.
4. **M4 (built):** code-changing tasks (`small-edit`) verified by the project's own test command in a throwaway git worktree. Plan: `docs/superpowers/plans/2026-11-12-small-edit.md`.

5. **M5:** the chat. `orch` opens a conversation in the current repository; a router sends each message to the local model (agent loop with read, search and approved commands) or to Claude (headless, read-only tools). Plan: `docs/superpowers/plans/2026-11-12-chat-agent.md`.

## Non-goals
Multi-backend adapters for other CLIs, a web UI, benchmarks like SWE-bench (too costly for a zero-budget project), selling it.

## Decisions (settled in the first session)
- **Config:** JSON, parsed by `JSON.parse`. A gitignored `config/orchestrator.local.json` is merged over the committed file.
- **CLI parsing:** `node:util` `parseArgs`. Zero runtime dependencies; dev dependencies are `typescript` and `@types/node` only.
- **No build step:** Node >= 22.18 runs the `.ts` files directly. Erasable TypeScript only (no `enum`, no parameter properties); relative imports carry `.ts`.
- **`orch run` reads flags only.** Task files exist only for the fixed eval set (`eval/fixed-tasks/<id>/task.json`).
- **Prompt budget:** 6000 tokens (estimated pessimistically as chars / 3), with `num_ctx` 8192 sent to Ollama. A prompt that fills `num_ctx` is treated as truncated and logged as `backend_error`.
- **Retries:** decided by `decideNext` in `src/core/policy.ts`. The run loop never retries more than `retryBeforeEscalate` times, whatever the policy says.
- **Log record:** the fields above plus `attempt`, `mode` (`run` | `eval`) and `taskId`. Raw outputs are `runs/<runId>/tier<N>-attempt<M>.txt`. For an attempt that produced no output (unreachable, timeout, backend error), `verifyDetail` holds the error message.
- **Verifier rules:** in each file under `src/tasks/`. A verifier may be async. The shell-command verifier is `runCommand` in `src/core/command.ts` (re-exported by `src/core/verifier.ts`); it is the only place a shell is used.
- **small-edit (M4):** the model returns the new version of one marked region (`--symbol` or `--lines`), never a diff; `src/tasks/region.ts` finds and splices it. The flow is `src/core/small-edit-run.ts`: a detached `git worktree` in the temp directory (`src/workspace/edit-workspace.ts`), the user's test command there before any model call and after every answer, then a patch on stdout. In the user's repository `orch` runs only read-only git queries, `git worktree add --detach` and `git worktree remove` (never `--force`). `--commit` commits the one file on a new branch `orch/small-edit-<runId>` from inside the worktree. Model output is only ever file content: never part of a command or a path. The test command comes from `--test` or `repos` in the config, runs the model's code unsandboxed, and is cut off after 5 minutes.
- **Eval set:** 16 fixed tasks; the 4 `se-*` tasks are small-edits, each with a tiny `project/` that `runEval` copies and commits in the temp directory.
- **Claude flags:** `docs/claude-cli-flags.md`. Never `--bare` (it ignores the subscription login). The Claude backend refuses to run while `ANTHROPIC_API_KEY` or a similar billing/gateway variable is set; it checks names only.
- **Commands never inherit `NODE_TEST_CONTEXT`:** with it, a `node --test` test command started under our own test run skips every file and exits 0.
- **Agent harness:** the loop in `src/agent/loop.ts` is generic. It receives a toolkit (`src/agent/toolkit.ts`): tools, a system prompt, and one policy that answers allow, ask or deny for every tool call; a tool the policy does not know is asked. The coding tools and rules are one toolkit (`src/agent/coding-toolkit.ts`). A second toolkit, or a separate package, waits until a second harness exists.

## Working on this repo
- `npm test` runs everything with a fake Ollama server and a fake `claude` binary; it needs neither the PC nor the real CLI. `npm run typecheck` runs `tsc --noEmit`.
- Tests come first: write the failing test, then the code.
- The plan for M1-M3 is `docs/superpowers/plans/2026-11-12-tiered-orchestrator.md`. The plan for M4 is `docs/superpowers/plans/2026-11-12-small-edit.md`.
- **Security review before every pull request, not per commit.** The `security-guidance` plugin's per-commit and end-of-turn reviews are off (`env` in `.claude/settings.json`); its free pattern warnings stay on. Before opening a pull request, run `/security-review` on the branch. If it reports anything, record it with `node .claude/scripts/security-review.ts record findings --report <file>`, then stop and tell the user: fixes are discussed with them first. If it reports nothing, record `clean` the same way. A hook blocks any pull request whose commit has no clean review recorded.
