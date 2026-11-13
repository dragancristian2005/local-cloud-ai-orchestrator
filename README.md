# Tiered Coding Orchestrator

`orch` answers with the cheapest backend that can do the job, and moves to a stronger one only when
it has to.

- **Local:** a model served by Ollama on a separate PC on your home network.
- **Claude:** the official `claude` CLI on your Mac, with your own login.

Zero money spent: no API keys, no billing. The design and its hard rules are in
[CLAUDE.md](CLAUDE.md).

```
$ cd ~/dev/my-project
$ orch
> what does the retry helper do?
  [search retry]
  [read_file src/http/retry.ts]
local> It retries a failed request up to three times ...
> make it give up immediately on a 401
(to claude: the request needs more than the local model)
claude> Here is the change as a diff: ...
```

## Requirements

- Node 22.18 or newer on the Mac. There is no build step: Node runs the TypeScript directly.
- The `claude` CLI installed and signed in on the Mac.
- Ollama on the PC, reachable only on your LAN or Tailscale.

**First time? Follow the step-by-step tutorial: [docs/SETUP.md](docs/SETUP.md).**

## The chat

Type `orch` in a project folder. It opens a conversation, like typing `claude`, and decides for
each message whether the local model or Claude answers. The label in front of each answer says
who it was.

**How it decides**

1. The PC is off, asleep or erroring: Claude.
2. The message is too long for the local model: Claude.
3. Otherwise one quick call asks the local model to label the request `LOCAL` or `CLAUDE`.
4. While the local model works, the turn goes to Claude if the model asks for help, gets stuck
   in its tools, or answers with a refusal.

What this cannot do: notice when a small model answers wrongly with confidence. When an answer
looks off, type `/claude` and Claude answers the same message again.

**What the local model can do**

| Tool | Asks you first? |
|---|---|
| read a file, list a folder, search for text | no; only inside the project, never `.env`, keys or `.git/` |
| run a command | yes, unless it is on the allow-list |

At the prompt `Run this command? ...  [y]es / [n]o / [a]lways:` answer `y` to run it, `n` to refuse,
`a` to stop being asked for that exact command in this session.

The allow-list starts as `git status`, `git diff`, `git log`, `ls`, `pwd`, in their plain form: no
shell operators, quotes or wildcards, and no path that leaves the project. Add your own in
`config/orchestrator.local.json`:

```json
{ "agent": { "allowCommands": ["git status", "git diff", "git log", "ls", "pwd", "npm test"] } }
```

Some commands are refused whatever you answer: `rm` with `-r` or `-f`, `git reset --hard`,
`git clean`, `git push`, discarding changes, commits while on `main`, `sudo`, and anything that
names a credentials or secrets file. This list backs up the rules above; it is not a sandbox. Read
a command before you approve it.

**What Claude can do in the chat**

Claude runs headless in the project folder with three read-only tools (`Read`, `Grep`, `Glob`).
It cannot change files or run commands; when a change is needed it shows a diff for you to apply.
Unlike the local tools, Claude's `Read` can open any file in the project, including `.env`.

**Commands:** `/claude` (redo the last answer with Claude), `/clear`, `/help`, `/exit`.

`orch report --mode chat` shows how many turns the local model kept and how many it handed over.

**The local model needs tool-calling support.** Ollama's own examples use `qwen3`. A model without
it gets a clear error, and every message then goes to Claude.

## Single tasks

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

What you stage, the file you name, and whatever the chat's tools read is sent to a model: to your
PC, and to Anthropic when Claude answers. Do not stage secrets.

## Rules this project keeps

- The Claude backend only starts the unmodified `claude` binary. It never reads or forwards
  credentials. Its flags are listed in [docs/claude-cli-flags.md](docs/claude-cli-flags.md).
- The Claude tier refuses to run while `ANTHROPIC_API_KEY` (or another variable that would bill
  an API key or reroute the call) is set, so an escalation can never cost money.
- Claude calls run one at a time, and `orch eval` refuses cloud backends.
- Ollama is never exposed to the internet.
- `orch` itself only reads your repositories. In the chat, a file can change only through a
  command you approved; Claude gets read-only tools and nothing else.

## Development

```sh
npm install
npm test            # needs neither the PC nor the real claude CLI
npm run typecheck
```
