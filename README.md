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

`git diff` and `git log -p` show whatever is tracked, so a secrets file that was committed can
still appear in their output.

At the prompt `Run this command? ...  [y]es / [n]o / [a]lways:` answer `y` to run it, `n` to refuse,
`a` to stop being asked for that exact command in this session.

The allow-list starts as `git status`, `git diff`, `git log`, `ls`, `pwd`, in their plain form: no
shell operators, quotes or wildcards, and no path that leaves the project. Add your own in
`config/orchestrator.local.json`:

```json
{ "agent": { "allowCommands": ["git status", "git diff", "git log", "ls", "pwd", "npm test"] } }
```

The common forms of some commands are refused whatever you answer: `rm` with `-r` or `-f`,
`git reset --hard`, `git clean`, `git push`, discarding changes, commits while on `main`, `sudo`,
and commands that name a credentials or secrets file. Other spellings of the same thing reach you
as a normal approval prompt, so read a command before you approve it.

A command is stopped after 60 seconds (`agent.commandTimeoutMs`). Ctrl-C leaves the chat and stops
a running command.

Pasted lines are sent as one message. When input is piped instead of typed, at most three messages
per session are handed to Claude.

Each session's transcript, including the file contents and command output the tools returned, is
kept in `runs/<session id>/transcript.jsonl`.

**What Claude can do in the chat**

Claude runs headless in the project folder with three read-only tools (`Read`, `Grep`, `Glob`).
It cannot change files or run commands; when a change is needed it shows a diff for you to apply.
Unlike the local tools, Claude's `Read` can open any file in the project, including `.env`.

In a project whose `.claude/settings.json` sets an API key or another provider, the hand-over to
Claude is refused, so it cannot bill anything.

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

# Change one function, checked by your own tests. Prints a patch; see "Editing code" below.
orch run --type small-edit --file src/math.js --symbol clamp \
  --instruction "throw when lo is greater than hi" --test "npm test"

# Run the 16 fixed tasks against the local model, then compare models.
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

## Editing code (small-edit)

```sh
orch run --type small-edit --file src/math.js --symbol clamp \
  --instruction "throw an Error when lo is greater than hi" \
  --test "npm test" --allow-failing-baseline > change.patch
git apply change.patch
```

`orch` shows the model one function and the instruction, puts the answer into a temporary copy
of your repository (a git worktree in the temp directory, at your last commit), and runs your
test command there. Only when the tests pass does it print a patch. A failing test run is fed
back to the model once, then the task goes to the next tier. Your working tree, your index and
your branch are never changed; applying the patch is one explicit `git apply`.

There are two ways to use it:

- **Keep the tests green.** The tests pass now and must still pass after the edit (a rename, a
  small refactor). This is the default.
- **Make a failing test pass.** Write the test first, commit it, and pass
  `--allow-failing-baseline`. This is the most meaningful check: the edit is accepted only when
  your new test passes.

| Flag | Meaning |
|---|---|
| `--symbol <name>` | The function, method or class to change. `orch` finds its lines (braces for JavaScript and TypeScript, indentation for Python). |
| `--lines <a>-<b>` | The lines to change, instead of `--symbol`, when that guess is wrong or the file is another language. |
| `--instruction "<text>"` | What to change. |
| `--test "<command>"` | Your project's test command. |
| `--link <path>` | An ignored path the tests need, symlinked into the copy. Usually `node_modules`. Repeatable. |
| `--allow-failing-baseline` | The tests fail before the edit, and the edit should make them pass. |
| `--commit` | Also commit the change on a new branch `orch/small-edit-<run id>`. Your current branch does not move. |

The test command and the links can be set once per repository in `config/orchestrator.local.json`,
keyed by the repository's absolute path:

```json
{
  "repos": {
    "/Users/you/code/app": { "testCommand": "npm test", "linkPaths": ["node_modules"], "testTimeoutMs": 300000 }
  }
}
```

Things to know:

- **The tests run the model's code on your machine, unsandboxed.** That is what "verified by the
  project's own tests" means. Use small-edit only in repositories you trust, with a test command
  you would run yourself.
- The file must be committed and unchanged. The copy is your last commit, so an edit made from it
  would ignore unsaved work; `orch` refuses instead.
- The patch is also saved as `runs/<run id>/change.patch`.
- Ctrl-C stops the tests and removes the temporary copy. If the tests left new files in it, git
  will not remove it and `orch` prints where it is; nothing is ever forced.
- A test run is cut off after 5 minutes (`testTimeoutMs`).

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
- `orch` never changes your working tree. In the chat, a file can change only through a
  command you approved; Claude gets read-only tools and nothing else. small-edit works in a
  temporary worktree, prints a patch, and commits only with `--commit`, on a new branch.
- The only thing small-edit runs through a shell is the test command you gave it. A model's
  answer is only ever written as file content.

## Development

```sh
npm install
npm test            # needs neither the PC nor the real claude CLI
npm run typecheck
```
