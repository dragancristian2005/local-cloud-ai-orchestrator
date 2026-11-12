# claude-config

A GitHub template that gives a new repo my Claude Code setup (plugins, agents, hooks), so
I can start a project from my phone and code in Claude Code on the web with the Mac off.

## Start a new project (phone)

1. GitHub app → this repo → **Use this template** → **Create a new repository**. Keep it **private**.
2. Open Claude Code on the web (claude.ai/code), pick the new repo, and start a session.
3. Check that it worked: run `/plugin`, and ask Claude to list its agents and skills.

The new repo also gets `export.sh`, `tests/` and `docs/`. They're only needed here, so delete them
in the new project if you like.

## Update the template after changing my setup (Mac)

```sh
cd ~/dev/projects/claude-config
./export.sh            # regenerates .claude/ (and CLAUDE.md) from ~/.claude
git diff               # check: no secrets, nothing unexpected
git commit -am "chore: update exported config" && git push
```

Projects already made from the template don't update. Copy `.claude/` into them by hand if needed.

## What gets exported

| From `~/.claude` | To this repo | Notes |
|---|---|---|
| `settings.json` → `enabledPlugins` | `.claude/settings.json` | Plugins are declared, the cloud downloads them |
| `plugins/known_marketplaces.json` + `extraKnownMarketplaces` | `.claude/settings.json` | Only the `source` of each marketplace |
| `settings.json` → `hooks` | `.claude/settings.json` | Only hooks that run a script from `~/.claude/scripts/`, rewritten to `"$CLAUDE_PROJECT_DIR"/.claude/scripts/…` |
| `agents/` | `.claude/agents/` | |
| `skills/<name>/` | `.claude/skills/<name>/` | Except `skills/synced` (claude.ai account skills, which the account already provides) |
| `scripts/` | `.claude/scripts/` | Except Mac-only ones listed in `EXCLUDE_SCRIPTS` in `export.sh` |
| `CLAUDE.md` | `CLAUDE.md` | If it exists |

Never exported: `settings.local.json`, model/theme/UI settings, history, sessions, project memory, plugin caches.

## Tests

```sh
bash tests/export_test.sh
```
