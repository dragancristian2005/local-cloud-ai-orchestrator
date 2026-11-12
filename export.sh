#!/usr/bin/env bash
# Regenerate .claude/ in this repo from the Mac's ~/.claude, so the repo can be used
# as a GitHub template for Claude Code on the web. Only writes files: review
# `git diff`, then commit and push yourself.
#
#   ./export.sh                                  # normal use
#   CLAUDE_SRC=/path/.claude DEST=/path ./export.sh   # tests
set -euo pipefail

CLAUDE_SRC="${CLAUDE_SRC:-$HOME/.claude}"
DEST="${DEST:-$(cd "$(dirname "$0")" && pwd)}"

# Hook scripts that only make sense on the Mac. Their hooks are dropped too.
EXCLUDE_SCRIPTS=(prune-old-versions.sh)

settings="$CLAUDE_SRC/settings.json"
known="$CLAUDE_SRC/plugins/known_marketplaces.json"
out="$DEST/.claude"

[ -f "$settings" ] || { echo "export.sh: $settings not found" >&2; exit 1; }
# This script is copied into every repo made from the template; only ever write into claude-config.
if [ ! -f "$DEST/export.sh" ]; then
  echo "export.sh: $DEST is not the claude-config repo (no export.sh there)" >&2
  exit 1
fi
if [ -e "$out" ] && { [ "$out" -ef "$CLAUDE_SRC" ] || [ "$out" -ef "$HOME/.claude" ]; }; then
  echo "export.sh: refusing to overwrite the source $CLAUDE_SRC (DEST must be the claude-config repo)" >&2
  exit 1
fi

known_json='{}'
[ -f "$known" ] && known_json=$(cat "$known")
excl_json=$(printf '%s\n' "${EXCLUDE_SCRIPTS[@]}" | jq -R . | jq -sc .)

# Shared jq helpers. A command hook is kept only if it runs a script from
# ~/.claude/scripts/ (which we copy) that isn't excluded; its path is rewritten
# to the project copy. Anything else would point at files the cloud doesn't have.
# shellcheck disable=SC2016  # jq program: $vars are jq's, not the shell's
jq_defs='
  def esc: gsub("(?<c>[.^$*+?()\\[\\]{}|\\\\])"; "\\\(.c)");
  # [bash|sh ]["]<home>/.claude/scripts/<name>["][ args]  (top-level scripts only: those are what we copy)
  def re: "^(?<pre>((bash|sh) +)?)(?<q>\"?)(\\$HOME|\\$\\{HOME\\}|~|" + ($home | esc)
          + ")/\\.claude/scripts/(?<name>[^ /\"]+)\\k<q>(?<rest>( .*)?)$";
  def verdict:
    if .type != "command" then "keep"
    elif (.command | test(re)) then
      ((.command | capture(re).name) as $n | if ($excl | index($n)) then "excluded" else "keep" end)
    else "outside ~/.claude/scripts" end;
  def rewrite: .command |= (capture(re) as $m | $m.pre + "\"$CLAUDE_PROJECT_DIR\"/.claude/scripts/" + $m.name + $m.rest);
'
jq_args=(--arg home "$HOME" --argjson excl "$excl_json" --argjson known "$known_json")

# Say what gets dropped, so nothing disappears silently.
jq -r "${jq_args[@]}" "$jq_defs"'
  .hooks // {} | .[][]?.hooks[]? | verdict as $v | select($v != "keep")
  | "export.sh: skipping hook (\($v)): \(.command)"
' "$settings" >&2

# Keep only what a cloud session can use: plugins, the marketplaces they come from, hooks.
settings_json=$(jq "${jq_args[@]}" "$jq_defs"'
  def filter_hooks:
    with_entries(.value |= (map(.hooks |= map(select(verdict == "keep") | if .type == "command" then rewrite else . end))
                            | map(select(.hooks | length > 0))))
    | with_entries(select(.value | length > 0));
  {
    enabledPlugins: (.enabledPlugins // {}),
    extraKnownMarketplaces: (($known | with_entries(.value |= {source})) + (.extraKnownMarketplaces // {}))
  }
  + (if .hooks then {hooks: (.hooks | filter_hooks)} else {} end)
' "$settings")

rm -rf "$out"
mkdir -p "$out"
printf '%s\n' "$settings_json" > "$out/settings.json"

# Agents: copied as-is.
[ -d "$CLAUDE_SRC/agents" ] && cp -R "$CLAUDE_SRC/agents" "$out/agents"

# Skills: your own only. skills/synced holds claude.ai account skills, which the
# cloud gets from your account anyway.
if [ -d "$CLAUDE_SRC/skills" ]; then
  for d in "$CLAUDE_SRC/skills"/*/; do
    [ -d "$d" ] || continue   # empty skills/: the glob stays literal
    name=$(basename "$d")
    [ "$name" = synced ] && continue
    mkdir -p "$out/skills"
    cp -R "${d%/}" "$out/skills/$name"
  done
fi

# Hook scripts, minus the Mac-only ones.
if [ -d "$CLAUDE_SRC/scripts" ]; then
  for f in "$CLAUDE_SRC/scripts"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    [[ " ${EXCLUDE_SCRIPTS[*]} " == *" $name "* ]] && continue
    mkdir -p "$out/scripts"
    cp -p "$f" "$out/scripts/$name"
  done
fi

# Global instructions, if you have any.
rm -f "$DEST/CLAUDE.md"
[ -f "$CLAUDE_SRC/CLAUDE.md" ] && cp "$CLAUDE_SRC/CLAUDE.md" "$DEST/CLAUDE.md"

# Last line of defence before this goes to GitHub: no Mac paths anywhere in the output.
leaks=$(grep -rnF -e "/Users/" -e "$HOME/" "$out" "$DEST/CLAUDE.md" 2>/dev/null || true)
if [ -n "$leaks" ]; then
  printf 'export.sh: local path found in the export, do not commit it:\n%s\n' "$leaks" >&2
  exit 1
fi

echo "export.sh: wrote $out"
