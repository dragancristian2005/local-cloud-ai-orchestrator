# Design: claude-config template repo (Mac -> GitHub -> phone)

## Context / intent
You want to start a new project from your phone and have Claude Code on the web (cloud session) already
set up with the skills, agents, plugins and hooks from your Mac. The cloud session can't see your Mac, and
the Mac may be off, so everything has to travel through GitHub, pushed ahead of time.

## Goals
- Phone-only flow: GitHub app -> "Use this template" -> new repo -> open in Claude Code on the web.
- One Mac-side script you re-run when your setup changes (rare). Mac does not need to be on afterwards.
- Plugins are declared, not copied. Custom pieces (agents, skills, hook scripts) are copied.

## Non-goals
- No app or web UI. No live sync. No updating existing projects when the config changes.
- No secrets in the repo. Credentials for MCP servers go in the cloud environment's env vars.

## Anti-goals (failure even if it "works")
- Leaking anything private (settings.local.json, history, tokens) into a GitHub repo.
- A template repo that is public by accident.

## Approaches considered
- A. Template repo with config copied in. **Chosen** (simplest, clearly works today).
- B. Config as a personal plugin/marketplace (no staleness, more packaging). Possible later upgrade.
- C. Cloud environment setup script (applies to old repos too, but its capabilities are unverified).

## Design (approach A)
Repo `claude-config` on GitHub, **private**, marked "Template repository". Contents:

```
.claude/settings.json      # enabledPlugins (14), extraKnownMarketplaces, hooks (paths rewritten)
.claude/agents/            # advocate.md, judge.md, skeptic.md
.claude/skills/            # copied from ~/.claude/skills/synced
.claude/scripts/           # prune-old-versions.sh, repo-skill-reminder.sh (only if they work in the cloud)
CLAUDE.md                  # from ~/.claude/CLAUDE.md if present
README.md                  # the phone workflow, and how to re-run the export
export.sh                  # run on the Mac
```

`export.sh` (Mac) does:
1. Read `~/.claude/settings.json`; keep `enabledPlugins`, `extraKnownMarketplaces`, `hooks`. Drop `model`,
   `theme`, `tui`, `agentPushNotifEnabled`, `effortLevel`/`modelSettings` unless you say to keep them.
2. Rewrite hook commands from `$HOME/.claude/scripts/...` to `$CLAUDE_PROJECT_DIR/.claude/scripts/...`.
3. Copy agents, skills, scripts. Never touch `settings.local.json`, `history.jsonl`, `projects/`, `plugins/cache`.
4. Commit and push to `claude-config`.

Official marketplace: assumed available by default in the cloud (to verify). `superpowers` needs the
`obra/superpowers-marketplace` entry, which the script writes under `extraKnownMarketplaces`.

## Known risks / unverified
- Whether the web environment auto-installs plugins declared in project `settings.json`. Verified by the test below.
- `terraform` plugin: its MCP server failed to connect on the Mac this session, and may not run in the sandbox.
- Hooks that depend on the Mac (paths, installed tools) may fail or be noisy in the cloud.
- `skills/synced` contents not yet inspected; may contain things that shouldn't be pushed.

## Left to the builder (my calls, flagged for your review)
- Repo is private. Repo name `claude-config`.
- Keeping model/theme/UI settings out of the template.
- Export is a plain bash + `jq` script, not a Node/Python tool.

## Verification
1. Run `export.sh` and inspect the diff before the first push (no secrets, no local-only paths).
2. Create a test repo from the template on GitHub.
3. Open it in Claude Code on the web (phone or browser); run `/plugin`, list skills, check agents appear
   and the hooks don't error.
4. Fix whatever is missing, then re-run the export.
