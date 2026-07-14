#!/usr/bin/env bash
#
# launchd entry point: run ONE unattended autopilot pass in PROJECT_DIR.
# Invoked by the agent installed via autopilot-schedule.sh — not meant to be
# called by hand (though it's safe to). Everything it prints goes to the per-repo
# log the plist points StandardOutPath/StandardErrorPath at.
#
# Design notes:
#   * Single-flight lock — a pass can outlast the interval; if the previous one is
#     still running we skip this tick rather than stack two autopilots on one repo.
#   * Headless + non-interactive — autopilot is built to run without a human, so it
#     needs tool permissions granted up front (`--dangerously-skip-permissions`).
#   * Fails soft on a missing CLI so launchd doesn't spin on a broken environment.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DECODER="$SCRIPT_DIR/stream-decode.py"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

PROJECT="${1:?usage: autopilot-run.sh <project-dir>}"
cd "$PROJECT" 2>/dev/null || { echo "$(ts) FATAL cannot cd into $PROJECT"; exit 1; }

lock="${TMPDIR:-/tmp}/speckit-autopilot-$(printf '%s' "$PROJECT" | shasum | cut -c1-8).lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "$(ts) previous pass still active ($lock) — skipping this tick"
  exit 0
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT

if ! command -v claude >/dev/null 2>&1; then
  echo "$(ts) FATAL 'claude' CLI not on PATH (${PATH}) — cannot run autopilot"
  exit 127
fi

# --- Backlog preflight: log what we're about to work on (or skip and exit) ---
# Fetch open issues once so the log is descriptive before a full claude session
# is launched. Exits early with code 0 if there's nothing actionable — no point
# spinning up an agent to hear "backlog is clear."
BLOCK_LABELS="blocked wontfix duplicate needs-discussion needs discussion on-hold on hold question epic"
ISSUES_TMP="${TMPDIR:-/tmp}/speckit-autopilot-issues-$$.json"
if command -v gh >/dev/null 2>&1 \
   && gh issue list --state open --limit 200 \
        --json number,title,labels,createdAt,body \
        --jq 'sort_by(.createdAt)' > "$ISSUES_TMP" 2>/dev/null \
   && [ -s "$ISSUES_TMP" ]; then

  PREFLIGHT=$(python3 "$SCRIPT_DIR/preflight-issues.py" "$ISSUES_TMP" 2>/dev/null) || PREFLIGHT=""
  rm -f "$ISSUES_TMP"

  if [ -z "$PREFLIGHT" ]; then
    echo "$(ts) preflight: could not evaluate issues — proceeding anyway"
  else
    # If preflight says nothing is eligible, skip the claude session entirely.
    case "$PREFLIGHT" in
      SKIP:*) echo "$(ts) preflight: $PREFLIGHT"; exit 0;;
    esac

    # Claim the picked issue immediately — before anything else — so a concurrent
    # autopilot tick sees the label and skips this issue.
    CLAIMED_ISSUE=$(echo "$PREFLIGHT" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
    if [ -n "$CLAIMED_ISSUE" ] && command -v gh >/dev/null 2>&1; then
      gh label create "autopilot:claimed" --color "0075ca" --description "Autopilot is actively working this issue" 2>/dev/null || true
      if gh issue edit "$CLAIMED_ISSUE" --add-label "autopilot:claimed" 2>/dev/null; then
        trap 'gh issue edit "$CLAIMED_ISSUE" --remove-label "autopilot:claimed" 2>/dev/null || true; rmdir "$lock" 2>/dev/null' EXIT
        echo "$(ts) preflight: $PREFLIGHT — claimed #$CLAIMED_ISSUE"
      else
        echo "$(ts) preflight: $PREFLIGHT — claim failed, proceeding anyway"
      fi
    else
      echo "$(ts) preflight: $PREFLIGHT"
    fi
  fi
else
  rm -f "$ISSUES_TMP" 2>/dev/null || true
  echo "$(ts) preflight: gh unavailable or no issues fetched — proceeding anyway"
fi

echo "$(ts) === autopilot pass start :: $PROJECT ==="
# The slash command drives the speckit-autopilot-run skill; the flag lets the
# unattended session use git/gh/file tools without an interactive prompt.
#
# Stream the session live into this log instead of only the final result:
# --output-format stream-json emits one JSON event per line, which stream-decode.py
# turns into pretty, timestamped lines. The decoder is piped as `claude … | python3
# FILE` (a real file, NOT `python3 - <<'HEREDOC'`) — piping data into a stdin-heredoc
# script silently loses the data, the same trap Step 1 warns about.
#
# `PIPESTATUS[0]` preserves claude's real exit code (a pipe would otherwise report
# the decoder's). If stream-json/verbose ever stops being supported, fall back to a
# plain `claude -p "/speckit-autopilot-run" --dangerously-skip-permissions`.
if [ -f "$DECODER" ]; then
  claude -p "/speckit-autopilot-run" --dangerously-skip-permissions \
         --verbose --output-format stream-json 2>&1 \
    | python3 "$DECODER"
  status=${PIPESTATUS[0]}
else
  claude -p "/speckit-autopilot-run" --dangerously-skip-permissions
  status=$?
fi
echo "$(ts) === autopilot pass end (exit $status) ==="
exit "$status"
