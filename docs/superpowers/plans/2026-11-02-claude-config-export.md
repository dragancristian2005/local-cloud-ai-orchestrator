# claude-config Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private GitHub template repo `claude-config` whose `.claude/` folder gives a Claude Code on the web session the same plugins, agents and hooks as the Mac, kept up to date by one Mac script.

**Architecture:** `export.sh` reads `~/.claude` (overridable for tests) and regenerates `.claude/` in the repo: a filtered `settings.json`, copied agents and user skills, and the hook scripts that make sense in the cloud. It only writes files; you review `git diff` and push by hand.

**Tech Stack:** bash, jq (`/usr/bin/jq`), git, gh (logged in as `dragancristian2005`), shellcheck. Tests are a plain bash script (no bats installed).

**Spec:** `/Users/dragancristian/.claude/plans/go-ahead-and-write-proud-scroll.md` (copied to `docs/superpowers/specs/2026-11-02-claude-config-design.md` in Task 1)

## Changes from the design (found during recon, need your OK)

- **`~/.claude/skills/synced` is NOT copied.** It holds your claude.ai account skills (docs, pdf, xlsx, morning, computer-use, chrome-browser, ...), synced by Anthropic, with their own licences. You have no hand-made skills. The script copies any future `~/.claude/skills/<name>/` folder except `synced`.
- **The `prune-old-versions.sh` hook is dropped.** It deletes old Claude Code installs under `~/.local/share/claude` on the Mac and means nothing in the cloud. `repo-skill-reminder.sh` is kept (it only needs git + jq).
- `extraKnownMarketplaces` is built from `~/.claude/plugins/known_marketplaces.json` (both `claude-plugins-official` and `superpowers-marketplace`), so the cloud doesn't have to already know the official one.

## Global Constraints

- Output `settings.json` keys: only `enabledPlugins`, `extraKnownMarketplaces`, `hooks`.
- Never read or copy: `settings.local.json`, `history.jsonl`, `projects/`, `plugins/cache/`, `sessions/`, `skills/synced/`.
- No absolute Mac paths (`/Users/`, `$HOME`) in any exported file.
- Hook paths become `"$CLAUDE_PROJECT_DIR"/.claude/scripts/<name>`.
- GitHub repo is private and marked as a template.

## Review Focus

1. Re-running after deleting an agent on the Mac: it must disappear from the repo (export wipes and regenerates `.claude/`).
2. `~/.claude/settings.json` with no `hooks` key: export still succeeds, and the output has no `hooks` key.
3. A hook whose command points outside `~/.claude/scripts/` (for example `/opt/x.sh`): dropped, with a warning on stderr.
4. File names with spaces in agents or skills: copied intact.
5. Leak guard: the exported tree contains no `/Users/` string and no `settings.local.json`.

---

### Task 1: Repo skeleton, test harness, settings.json export

**Files:**
- Create: `export.sh`, `tests/export_test.sh`, `tests/fixtures/home/.claude/...` (fake settings.json, settings.local.json, known_marketplaces.json, agents/a.md, skills/synced/x/SKILL.md, skills/mine/SKILL.md, scripts/keep.sh, scripts/prune-old-versions.sh)
- Create: `docs/superpowers/specs/2026-11-02-claude-config-design.md` (copy of the spec)

**Interfaces:**
- Produces: `CLAUDE_SRC=<dir> DEST=<dir> ./export.sh` (defaults: `CLAUDE_SRC=$HOME/.claude`, `DEST=` the script's own directory). Exit 0 on success, non-zero with a message if `CLAUDE_SRC/settings.json` is missing. Writes `$DEST/.claude/settings.json`.
- Produces: `tests/export_test.sh` runs every `test_*` function against a fresh `mktemp -d` DEST and prints `PASS`/`FAIL <name>`, exiting non-zero on any failure.

- [ ] **Step 1: `git init` in `~/dev/projects/claude-config`, add the spec copy, write fixtures and these failing tests**
  - `test_settings_keeps_only_allowed_keys`: `jq -r 'keys|join(",")'` on output == `enabledPlugins,extraKnownMarketplaces,hooks`.
  - `test_enabled_plugins_copied`: output `enabledPlugins` equals fixture's.
  - `test_marketplaces_from_known_marketplaces`: output has `.extraKnownMarketplaces["claude-plugins-official"].source.repo == "anthropics/claude-plugins-official"` and no `installLocation`/`lastUpdated` fields.
  - `test_missing_hooks_key`: fixture variant without `hooks` → exit 0, `jq 'has("hooks")'` == `false`.
  - `test_missing_settings_fails`: empty CLAUDE_SRC → non-zero exit.
- [ ] **Step 2:** Run `bash tests/export_test.sh` — expected FAIL (no export.sh).
- [ ] **Step 3:** Implement `export.sh` settings part with `set -euo pipefail` and jq; marketplaces via `jq 'with_entries(.value |= {source})'`.
- [ ] **Step 4:** Run `bash tests/export_test.sh && shellcheck export.sh tests/export_test.sh` — expected all PASS, no warnings.
- [ ] **Step 5:** Commit `feat: export plugin settings`.

### Task 2: Agents, skills, hook scripts

**Files:**
- Modify: `export.sh`, `tests/export_test.sh`, fixtures

**Interfaces:**
- Consumes: Task 1's `export.sh` entry point and test harness.
- Produces: `$DEST/.claude/agents/`, `$DEST/.claude/skills/` (minus `synced`), `$DEST/.claude/scripts/` (minus names in `EXCLUDE_SCRIPTS="prune-old-versions.sh"` at the top of export.sh), and rewritten `hooks`.

- [ ] **Step 1: Write failing tests**
  - `test_agents_copied` (including a fixture file named `my agent.md`).
  - `test_skills_skip_synced`: `skills/mine/SKILL.md` exists, `skills/synced` does not.
  - `test_excluded_script_and_hook_dropped`: no `scripts/prune-old-versions.sh`, and no hook command contains `prune`.
  - `test_hook_path_rewritten`: kept hook command == `"$CLAUDE_PROJECT_DIR"/.claude/scripts/keep.sh`.
  - `test_outside_hook_dropped_with_warning`: fixture hook `/opt/x.sh` absent from output, stderr contains `skipping hook`.
  - `test_rerun_removes_stale`: export, delete fixture agent, export again → agent gone from DEST.
  - `test_claude_md_copied_if_present`: fixture `CLAUDE.md` → `$DEST/CLAUDE.md`; absent → no file, exit 0. (You have none today.)
  - `test_no_leaks`: `grep -r "/Users/" "$DEST/.claude"` finds nothing; no `settings.local.json` under DEST.
- [ ] **Step 2:** Run tests — expected the new ones FAIL.
- [ ] **Step 3:** Implement: `rm -rf "$DEST/.claude"` then regenerate; `cp -R` agents/skills/scripts; filter hooks in jq (drop hook entries whose command doesn't match `$HOME/.claude/scripts/<name>` or whose name is excluded; drop empty matcher groups and empty events).
- [ ] **Step 4:** Run tests + shellcheck — all PASS.
- [ ] **Step 5:** Commit `feat: export agents, skills and hook scripts`.

### Task 3: README, real export, review

**Files:**
- Create: `README.md` (phone flow: GitHub app → repo → "Use this template" → private → open in Claude Code on the web; Mac flow: `./export.sh`, `git diff`, commit, push; note that `export.sh`, `tests/`, `docs/` can be deleted from new projects)
- Generated: `.claude/` from the real `~/.claude`

- [ ] **Step 1:** Write README.
- [ ] **Step 2:** Run `./export.sh` for real.
- [ ] **Step 3:** Show the user `git status` and `.claude/settings.json`; confirm 14 plugins, 2 marketplaces, 3 agents, 1 hook, no `/Users/`.
- [ ] **Step 4:** Commit `chore: first export of Mac config`.

### Task 4: Publish to GitHub (ask before running)

- [ ] **Step 1:** After the user confirms: `gh repo create dragancristian2005/claude-config --private --source . --push`.
- [ ] **Step 2:** `gh api -X PATCH repos/dragancristian2005/claude-config -f is_template=true`.
- [ ] **Step 3:** Verify: `gh repo view dragancristian2005/claude-config --json isPrivate,isTemplate` == `{"isPrivate":true,"isTemplate":true}`.

### Task 5: Cloud check (done by the user from the phone)

- [ ] Create `test-from-template` from the template, open it in Claude Code on the web, run `/plugin`, ask for the list of agents and skills. Report anything missing; fix and re-export.
