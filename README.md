# Tiered Coding Orchestrator

`orch` runs a small coding task on the cheapest backend that can do it, checks the answer, and
moves to a stronger backend only when the check fails.

- **Tier 0:** a local model served by Ollama on a separate PC on your home network.
- **Tier 1:** the official `claude` CLI on your Mac, with your own login.

Zero money spent: no API keys, no billing. The design and its hard rules are in
[CLAUDE.md](CLAUDE.md).

## Requirements

- Node 22.18 or newer on the Mac. There is no build step: Node runs the TypeScript directly.
- The `claude` CLI installed and signed in on the Mac.
- Ollama on the PC, reachable only on your LAN or Tailscale.

**First time? Follow the step-by-step tutorial: [docs/SETUP.md](docs/SETUP.md).**

## Commands

```sh
# A commit message for whatever is staged. The message is the only thing on stdout.
orch run --type commit-message --repo .

# A documentation comment, or a test file, for one function. Printed, never written to the file.
orch run --type docstring --file src/math.ts --symbol clamp
orch run --type test-stub --file src/math.ts --symbol clamp

# Run the 12 fixed tasks against the local model, then compare models.
orch eval --backend pc-ollama
orch eval --backend pc-ollama --model <another-model>
orch report --mode eval
```

Progress goes to stderr, one line per attempt:

```
tier 0 pc-ollama (qwen2.5-coder:7b): verify fail: subject is 81 chars (max 72) -> retry
tier 0 pc-ollama (qwen2.5-coder:7b): pass (1.4s)
```

Exit codes: `0` success, `1` every tier failed, `2` bad usage, config or input.

## How a run works

1. The task builds a prompt from the repository (the staged diff, or a window of the source file),
   trimmed to a budget of 6000 tokens (estimated pessimistically, at 3 characters per token).
2. Each backend in the task's chain is tried in order. A local backend that is off or asleep is
   skipped after 3 seconds.
3. The answer is cleaned (reasoning blocks, code fences) and checked against the task's rules.
4. A rejected answer from the local model is retried once, with the reason in the prompt. After
   that the run moves to the next backend.
5. Every attempt becomes one line in `runs/log.jsonl`; the raw answers are in `runs/<run id>/`.

## Configuration

`config/orchestrator.config.json` is committed. Put your own values in
`config/orchestrator.local.json`, which is ignored by git and merged over it:

```json
{
  "backends": {
    "pc-ollama": { "baseUrl": "http://192.168.1.50:11434", "model": "qwen2.5-coder:7b" }
  }
}
```

To try another model, pass `--model <name>` for one run, or change `model` in the local file.

## Comparing models

`orch report` prints one row per model:

| Column | Meaning |
|---|---|
| attempts | attempts that reached the backend |
| pass % | share of those attempts whose answer was accepted |
| escalated % | share of `orch run` runs in which this model handed over to a stronger backend |
| avg s | average time per attempt |
| pc down | attempts skipped because the PC was off or asleep; not counted anywhere else |

What you stage, or the file you name, is sent to the model: to your PC, and to Claude when a run
escalates. Do not stage secrets.

## Rules this project keeps

- The Claude backend only starts the unmodified `claude` binary. It never reads or forwards
  credentials. Its flags are listed in [docs/claude-cli-flags.md](docs/claude-cli-flags.md).
- The Claude tier refuses to run while `ANTHROPIC_API_KEY` (or another variable that would bill
  an API key or reroute the call) is set, so an escalation can never cost money.
- Claude calls run one at a time, and `orch eval` refuses cloud backends.
- Ollama is never exposed to the internet.
- `orch` only reads your repositories. It never writes, commits or changes branches.

## Development

```sh
npm install
npm test            # needs neither the PC nor the real claude CLI
npm run typecheck
```
