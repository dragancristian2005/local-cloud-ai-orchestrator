#!/usr/bin/env bash
# Tests for export.sh. Run: bash tests/export_test.sh
# Each test gets a fresh fake home (H, with H/.claude) and a fresh destination repo (D).
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
EXPORT="$ROOT/export.sh"

make_home() {
  local c="$1/.claude"
  mkdir -p "$c/plugins" "$c/agents" "$c/skills/mine" "$c/skills/synced/x" "$c/scripts"
  cat > "$c/settings.json" <<'JSON'
{
  "model": "sonnet",
  "theme": "dark",
  "hooks": {
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "$HOME/.claude/scripts/prune-old-versions.sh" },
        { "type": "command", "command": "$HOME/.claude/scripts/keep.sh" },
        { "type": "command", "command": "/opt/x.sh" }
      ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "/opt/only-outside.sh" } ] }
    ]
  },
  "enabledPlugins": { "a@claude-plugins-official": true, "b@m2": true },
  "extraKnownMarketplaces": { "m2": { "source": { "source": "github", "repo": "o/m2" } } }
}
JSON
  cat > "$c/plugins/known_marketplaces.json" <<'JSON'
{
  "claude-plugins-official": {
    "source": { "source": "github", "repo": "anthropics/claude-plugins-official" },
    "installLocation": "/Users/someone/.claude/plugins/marketplaces/claude-plugins-official",
    "lastUpdated": "2026-11-02T19:29:26.384Z"
  }
}
JSON
  echo '{"secret": "do-not-copy"}' > "$c/settings.local.json"
  echo "agent a" > "$c/agents/a.md"
  echo "agent with space" > "$c/agents/my agent.md"
  echo "my skill" > "$c/skills/mine/SKILL.md"
  echo "synced skill" > "$c/skills/synced/x/SKILL.md"
  printf '#!/bin/sh\necho keep\n' > "$c/scripts/keep.sh"
  printf '#!/bin/sh\necho prune\n' > "$c/scripts/prune-old-versions.sh"
  chmod +x "$c/scripts/"*.sh
}

run_export() { HOME="$H" CLAUDE_SRC="$H/.claude" DEST="$D" "$EXPORT" >/dev/null 2>"$ERR"; }

fail() { echo "    $*"; return 1; }
assert_eq() { [ "$1" == "$2" ] || fail "expected [$2], got [$1] ($3)"; }

S() { jq -c "$1" "$D/.claude/settings.json"; }

# --- Task 1: settings.json -------------------------------------------------

test_settings_keeps_only_allowed_keys() {
  run_export || fail "export failed: $(cat "$ERR")"
  assert_eq "$(jq -r 'keys|join(",")' "$D/.claude/settings.json")" "enabledPlugins,extraKnownMarketplaces,hooks" keys
}

test_enabled_plugins_copied() {
  run_export || fail "export failed"
  assert_eq "$(S .enabledPlugins)" '{"a@claude-plugins-official":true,"b@m2":true}' plugins
}

test_marketplaces_from_known_marketplaces() {
  run_export || fail "export failed"
  assert_eq "$(jq -r '.extraKnownMarketplaces["claude-plugins-official"].source.repo' "$D/.claude/settings.json")" \
    "anthropics/claude-plugins-official" official
  assert_eq "$(S '.extraKnownMarketplaces["claude-plugins-official"] | keys')" '["source"]' "no local fields"
  assert_eq "$(S '.extraKnownMarketplaces.m2.source.repo')" '"o/m2"' "settings marketplace kept"
}

test_missing_hooks_key() {
  jq 'del(.hooks)' "$H/.claude/settings.json" > "$H/s" && mv "$H/s" "$H/.claude/settings.json"
  run_export || fail "export failed: $(cat "$ERR")"
  assert_eq "$(S 'has("hooks")')" false "no hooks key"
}

test_missing_settings_fails() {
  rm "$H/.claude/settings.json"
  if run_export; then fail "expected non-zero exit"; fi
}

test_refuses_to_overwrite_source() {
  # DEST=$HOME would make DEST/.claude the source itself: must refuse, and leave it intact.
  if HOME="$H" CLAUDE_SRC="$H/.claude" DEST="$H" "$EXPORT" 2>"$ERR"; then fail "expected refusal"; fi
  [ -f "$H/.claude/settings.json" ] || fail "source was deleted"
}

# --- Task 2: agents, skills, hook scripts ------------------------------------

test_agents_copied() {
  run_export || fail "export failed"
  assert_eq "$(cat "$D/.claude/agents/a.md")" "agent a" a.md
  assert_eq "$(cat "$D/.claude/agents/my agent.md")" "agent with space" "name with space"
}

test_skills_skip_synced() {
  run_export || fail "export failed"
  [ -f "$D/.claude/skills/mine/SKILL.md" ] || fail "own skill missing"
  [ ! -e "$D/.claude/skills/synced" ] || fail "synced skills were copied"
}

test_excluded_script_and_hook_dropped() {
  run_export || fail "export failed"
  [ ! -e "$D/.claude/scripts/prune-old-versions.sh" ] || fail "excluded script copied"
  assert_eq "$(S '[.. | .command? // empty | select(test("prune"))] | length')" 0 "prune hook present"
}

test_hook_path_rewritten() {
  run_export || fail "export failed"
  # shellcheck disable=SC2016  # $CLAUDE_PROJECT_DIR must stay literal
  assert_eq "$(S '.hooks.SessionStart[0].hooks')" \
    '[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/.claude/scripts/keep.sh"}]' "SessionStart hooks"
  [ -x "$D/.claude/scripts/keep.sh" ] || fail "keep.sh missing or not executable"
}

test_outside_hook_dropped_with_warning() {
  run_export || fail "export failed"
  assert_eq "$(S '[.. | .command? // empty | select(test("/opt/"))] | length')" 0 "outside hook present"
  assert_eq "$(S '.hooks | has("Stop")')" false "event left with no hooks"
  grep -q "skipping hook.*/opt/x.sh" "$ERR" || fail "no warning on stderr: $(cat "$ERR")"
}

test_rerun_removes_stale() {
  run_export || fail "first export failed"
  rm "$H/.claude/agents/a.md"
  run_export || fail "second export failed"
  [ ! -e "$D/.claude/agents/a.md" ] || fail "stale agent kept"
}

test_claude_md_copied_if_present() {
  run_export || fail "export failed"
  [ ! -e "$D/CLAUDE.md" ] || fail "CLAUDE.md created from nothing"
  echo "be nice" > "$H/.claude/CLAUDE.md"
  run_export || fail "export failed"
  assert_eq "$(cat "$D/CLAUDE.md")" "be nice" CLAUDE.md
}

test_no_leaks() {
  run_export || fail "export failed"
  if grep -rq "/Users/" "$D/.claude"; then fail "absolute Mac path leaked: $(grep -r "/Users/" "$D/.claude")"; fi
  if grep -rq "$H" "$D/.claude"; then fail "home path leaked"; fi
  [ -z "$(find "$D" -name settings.local.json)" ] || fail "settings.local.json copied"
}

# --- Final review fixes ------------------------------------------------------

add_hook() {
  jq --arg c "$1" '.hooks.SessionStart[0].hooks += [{type: "command", command: $c}]' \
    "$H/.claude/settings.json" > "$H/s" && mv "$H/s" "$H/.claude/settings.json"
}

test_empty_skills_dir() {
  rm -rf "$H/.claude/skills" && mkdir "$H/.claude/skills"
  run_export || fail "export failed: $(cat "$ERR")"
  [ -x "$D/.claude/scripts/keep.sh" ] || fail "export stopped before copying scripts"
}

test_subfolder_script_hook_dropped() {
  mkdir -p "$H/.claude/scripts/sub" && printf '#!/bin/sh\n' > "$H/.claude/scripts/sub/x.sh"
  # shellcheck disable=SC2016  # literal $HOME, as written in settings.json
  add_hook '$HOME/.claude/scripts/sub/x.sh'
  run_export || fail "export failed: $(cat "$ERR")"
  assert_eq "$(S '[.. | .command? // empty | select(test("sub/"))] | length')" 0 "subfolder hook kept"
  grep -q "skipping hook.*sub/x.sh" "$ERR" || fail "no warning"
}

test_quoted_and_interpreter_hooks_rewritten() {
  # shellcheck disable=SC2016  # literal $HOME, as written in settings.json
  add_hook '"$HOME/.claude/scripts/keep.sh"'
  add_hook 'bash ~/.claude/scripts/keep.sh --flag'
  run_export || fail "export failed: $(cat "$ERR")"
  # shellcheck disable=SC2016  # $CLAUDE_PROJECT_DIR must stay literal
  assert_eq "$(S '[.hooks.SessionStart[0].hooks[].command]')" \
    '["\"$CLAUDE_PROJECT_DIR\"/.claude/scripts/keep.sh","\"$CLAUDE_PROJECT_DIR\"/.claude/scripts/keep.sh","bash \"$CLAUDE_PROJECT_DIR\"/.claude/scripts/keep.sh --flag"]' commands
}

test_leak_guard_fails_export() {
  echo "see /Users/bob/notes" > "$H/.claude/agents/leaky.md"
  if run_export; then fail "export should fail on a /Users/ path"; fi
  grep -q "local path" "$ERR" || fail "no leak message: $(cat "$ERR")"
}

test_refuses_dest_without_export_sh() {
  rm "$D/export.sh"
  if run_export; then fail "expected refusal"; fi
  grep -q "not the claude-config repo" "$ERR" || fail "wrong message: $(cat "$ERR")"
}

# --- runner -----------------------------------------------------------------

fails=0
for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  H=$(mktemp -d); D=$(mktemp -d); ERR="$D.err"
  make_home "$H"
  touch "$D/export.sh"   # export.sh only writes into a directory that holds an export.sh
  # Not inside `if`: bash disables set -e in a condition, which would hide mid-test failures.
  ( set -e; $t ); rc=$?
  if [ "$rc" -eq 0 ]; then echo "PASS $t"; else echo "FAIL $t"; fails=$((fails + 1)); fi
  rm -rf "$H" "$D" "$ERR"
done
if [ "$fails" -ne 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "ALL PASS"
