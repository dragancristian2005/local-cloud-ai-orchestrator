#!/bin/bash
# SessionStart hook: remind about per-repo setup skills that haven't been run yet.
# Opt out for a repo by creating .claude/no-skill-reminders in it.

input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$cwd" ] || cwd=$PWD

root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -e "$root/.claude/no-skill-reminders" ] && exit 0

reminders=()

# mattpocock-skills: setup writes docs/agents/issue-tracker.md
if [ ! -f "$root/docs/agents/issue-tracker.md" ]; then
  reminders+=("/setup-matt-pocock-skills (configures issue tracker, triage labels, docs layout; needed before to-tickets, to-spec, triage)")
fi

[ ${#reminders[@]} -eq 0 ] && exit 0

list=$(printf -- '- %s\n' "${reminders[@]}")
msg="Setup skills not yet run in this repo ($(basename "$root")):
$list
(Silence for this repo: touch .claude/no-skill-reminders)"

jq -n --arg msg "$msg" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("At the start of your first reply, tell the user these per-repo setup skills have not been run yet and offer to run them:\n" + $msg)
  }
}'
