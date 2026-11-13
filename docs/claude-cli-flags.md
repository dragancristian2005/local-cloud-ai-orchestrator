# `claude` CLI flags used by the Claude backend

The Claude backend spawns the unmodified `claude` binary and nothing else. These flags were read
from `claude --help`, not guessed.

Checked against: **Claude Code 2.1.322** (in the cloud container where the backend was written).
**Not yet re-checked on the Mac.** Run `claude --version` and `claude --help` there, confirm every
row below, and update this line.

| Flag | Why | Help text (2.1.322) |
|---|---|---|
| `-p` | print the response and exit | "Print response and exit (useful for pipes)" |
| `--output-format json` | one JSON result object on stdout | "json" (single result); only works with `--print` |
| `--tools ""` | no tools: Claude is a stateless worker here | `Use "" to disable all tools` |
| `--no-session-persistence` | one-shot calls are not saved as sessions | only works with `--print` |
| `--safe-mode` | no CLAUDE.md, plugins, hooks or MCP servers in the prompt | "Start with all customizations ... disabled" |
| `--model <name>` | only when the backend config sets `model` | "Model for the current session" |

The prompt is written to stdin. The working directory is a fresh temp directory, so no project
files are in reach.

Environment: the backend passes your environment through unchanged, and refuses to start `claude`
while any of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` is set. With one of
those, `claude -p` would bill an API key or use another provider instead of your subscription login.
Only the names are checked; the values are never read.

## Chat (read-only tools)

When the chat hands a message to Claude, the backend runs `claude -p` inside the repository with
two flags changed:

| Flag | Why | Help text (2.1.322) |
|---|---|---|
| `--tools Read,Grep,Glob` | the only tools Claude gets: it can look, not touch | "specify tool names (e.g. \"Bash,Edit,Read\")" |
| `--permission-prompts none` | headless: nothing may wait for an answer | "anything that would prompt is denied automatically" |

The other flags are the same as above. `Bash`, `Edit` and `Write` are never passed.

**Not yet tried with a real call.** On the Mac, in any repository:

```sh
echo "Which file defines the CLI entry point? Answer in one line." | \
  claude -p --output-format json --tools Read,Grep,Glob --permission-prompts none --no-session-persistence --safe-mode
```

It should print one JSON object whose `result` names a file, and it should not wait for input.
If a flag is rejected or it hangs, note what happened here: the chat's hand-over depends on it.

**Open question for the Mac:** `claude --help` describes `--restricted` as ignoring project
settings files and confining file tools to the working directory. If the Mac's version has it and
the one real call still works with it, it is a better fit than the settings check in `runAgent`.
(`--setting-sources user` is a second candidate: it would load user settings only.) Until one of
them has been tried with a real call, `runAgent` reads `.claude/settings.json` and
`.claude/settings.local.json` itself, right before `claude` starts, and refuses when either would
change who is billed.

Never used:

- `--bare`: its help text says OAuth and the keychain are never read, so it would require an API key.
- `--dangerously-skip-permissions`, `--permission-mode`: never used. In chat, `--permission-prompts none` makes anything that would ask fail instead.

If a flag is missing on your version, remove it from `CLAUDE_ARGS` in `src/backends/claude-cli.ts`
and from the table. Do not substitute a guess.
