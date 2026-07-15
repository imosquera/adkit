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
#     This only serializes THIS machine's ticks; the `autopilot:claimed` GitHub
#     label (applied by the skill body, not here) is what serializes across
#     machines and manual invocations.
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
#
# NOTE: this wrapper does NOT claim the `autopilot:claimed` label itself
# anymore — it only decides whether to launch a session and, if so, which
# issue to hand it. Claiming lives solely in the skill body
# (speckit.autopilot.run.md) now, so a manual `/speckit-autopilot-run <N>`
# and this wrapper share exactly one claim path instead of two. That fixes a
# prior self-starve bug: this wrapper used to claim before launching `claude
# -p`, so the session's own preflight check could see its own claim and
# mistake it for a competing run. Passing the picked issue number straight
# into the prompt also means the skill's Step 1 binds to the SAME issue this
# preflight picked, instead of re-picking independently.
PICKED_ISSUE=""
ISSUES_TMP="${TMPDIR:-/tmp}/speckit-autopilot-issues-$$.json"
if command -v gh >/dev/null 2>&1 \
   && bash "$SCRIPT_DIR/fetch-open-issues.sh" "$ISSUES_TMP" >/dev/null 2>&1 \
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
    PICKED_ISSUE=$(echo "$PREFLIGHT" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
    echo "$(ts) preflight: $PREFLIGHT"
  fi
else
  rm -f "$ISSUES_TMP" 2>/dev/null || true
  echo "$(ts) preflight: gh unavailable or no issues fetched — proceeding anyway"
fi

# Belt-and-suspenders cleanup: the skill body is what CLAIMS $PICKED_ISSUE (see
# NOTE above), and is responsible for un-claiming it on every exit path it
# controls. But an LLM session can still die ungracefully (kill, OOM, crash)
# before running its own cleanup instructions — unlike a bash trap, "the model
# was told to clean up" is not a hard guarantee. This trap is a process-level
# safety net for exactly that case: it fires on ANY exit of this wrapper
# process, well after Step 1's claim would have happened, so it can never be
# mistaken by the running skill for a pre-existing competing claim the way the
# old early-claim-before-launch code was. Removing a label that was never
# applied (skill never reached Step 1, or already cleaned up itself) is a
# harmless no-op.
if [ -n "$PICKED_ISSUE" ]; then
  trap 'gh issue edit "$PICKED_ISSUE" --remove-label "autopilot:claimed" 2>/dev/null || true; rmdir "$lock" 2>/dev/null' EXIT
fi

echo "$(ts) === autopilot pass start :: $PROJECT ==="
# The slash command drives the speckit-autopilot-run skill; the flag lets the
# unattended session use git/gh/file tools without an interactive prompt.
# Pass the issue this preflight already picked (if any) so the skill binds to
# it directly instead of re-running its own auto-pick — that's what keeps
# this wrapper's preflight and the skill's Step 1 from ever disagreeing.
PROMPT="/speckit-autopilot-run"
[ -n "$PICKED_ISSUE" ] && PROMPT="/speckit-autopilot-run $PICKED_ISSUE"
#
# Stream the session live into this log instead of only the final result:
# --output-format stream-json emits one JSON event per line, which stream-decode.py
# turns into pretty, timestamped lines. The decoder is piped as `claude … | python3
# FILE` (a real file, NOT `python3 - <<'HEREDOC'`) — piping data into a stdin-heredoc
# script silently loses the data, the same trap Step 1 warns about.
#
# `PIPESTATUS[0]` preserves claude's real exit code (a pipe would otherwise report
# the decoder's). If stream-json/verbose ever stops being supported, fall back to a
# plain `claude -p "$PROMPT" --dangerously-skip-permissions`.
if [ -f "$DECODER" ]; then
  claude -p "$PROMPT" --dangerously-skip-permissions \
         --verbose --output-format stream-json 2>&1 \
    | python3 "$DECODER"
  status=${PIPESTATUS[0]}
else
  claude -p "$PROMPT" --dangerously-skip-permissions
  status=$?
fi
echo "$(ts) === autopilot pass end (exit $status) ==="
exit "$status"
