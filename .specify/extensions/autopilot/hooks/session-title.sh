#!/usr/bin/env bash
#
# Claude Code SessionStart hook — title a session after the speckit feature /
# GitHub issue it belongs to, so backlog runs are easy to tell apart.
#
# Wire it up in a project's .claude/settings.json (see the autopilot extension
# README). It reads the SessionStart JSON on stdin and, when the session is
# opened or resumed inside a feature worktree, prints a `sessionTitle`.
#
# Why only startup/resume: Claude Code ignores `sessionTitle` after /clear and
# during compaction, so there's no point emitting it then.
#
# Title precedence:
#   1. `.specify/feature.json` source_issue  -> "#N: <issue title>" (via gh)
#   2. `.specify/feature.json` branch_name    -> "<branch>"
#   3. current git branch                     -> "<branch>"
# Anything that fails degrades to the next source; the hook never errors out
# (a broken hook must not block a session from starting).

set -uo pipefail

input="$(cat)"

# jq is required to parse the hook payload; if it's missing, do nothing quietly.
command -v jq >/dev/null 2>&1 || exit 0

source="$(printf '%s' "$input" | jq -r '.source // ""')"
case "$source" in
  startup | resume) ;;
  *) exit 0 ;;  # clear / compact / unknown -> leave the title alone
esac

cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
[ -n "$cwd" ] && cd "$cwd" 2>/dev/null || true

# Resolve the repo root so we find .specify/ even from a subdir of the worktree.
root="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")"
feature_json="$root/.specify/feature.json"

title=""

if [ -f "$feature_json" ]; then
  issue="$(jq -r '.source_issue // empty' "$feature_json" 2>/dev/null)"
  branch="$(jq -r '.branch_name // empty' "$feature_json" 2>/dev/null)"

  if [ -n "$issue" ] && command -v gh >/dev/null 2>&1; then
    # Best-effort, time-boxed so a slow/unauthed gh never stalls session start.
    ititle="$(cd "$root" && timeout 5 gh issue view "$issue" --json title -q '.title' 2>/dev/null || true)"
    if [ -n "$ititle" ]; then
      title="#${issue}: ${ititle}"
    else
      title="#${issue}${branch:+: $branch}"
    fi
  elif [ -n "$branch" ]; then
    title="$branch"
  fi
fi

# Fall back to the live git branch when feature.json told us nothing.
if [ -z "$title" ]; then
  gb="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ -n "$gb" ] && [ "$gb" != "HEAD" ] && title="$gb"
fi

# Nothing worth setting (e.g. the main checkout, no feature) — stay silent so
# Claude keeps its own auto-generated title.
[ -z "$title" ] && exit 0

jq -n --arg t "$title" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    sessionTitle: $t
  }
}'
exit 0
