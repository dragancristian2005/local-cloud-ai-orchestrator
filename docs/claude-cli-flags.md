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

Never used:

- `--bare`: its help text says OAuth and the keychain are never read, so it would require an API key.
- `--dangerously-skip-permissions`, `--permission-mode`: not needed with all tools disabled.

If a flag is missing on your version, remove it from `CLAUDE_ARGS` in `src/backends/claude-cli.ts`
and from the table. Do not substitute a guess.
