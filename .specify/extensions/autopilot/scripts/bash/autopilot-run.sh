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
#   * Keeps the RAW stream-json next to the decoded log (`<slug>.raw.jsonl`), so a
#     pass can be re-decoded or re-attributed after the fact without re-running it.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DECODER="$SCRIPT_DIR/stream-decode.py"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Where the raw stream lands. This MIRRORS autopilot-schedule.sh's slug_for/log_for
# (deliberately duplicated: that script dispatches subcommands at load, so it can't
# be sourced) — keep the two in step, or the raw file stops being a sibling of the
# decoded log launchd writes. AUTOPILOT_RAW_LOG overrides it; empty disables.
RAW_MAX_BYTES=$(( 64 * 1024 * 1024 ))
raw_log_for() {
  local root base hash
  root="$( cd "$1" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null )" || root="$1"
  [ -n "$root" ] || root="$1"
  base="$(printf '%s' "$(basename "$root")" | tr -c 'A-Za-z0-9._-' '-')"
  hash="$(printf '%s' "$root" | shasum | cut -c1-6)"
  printf '%s/Library/Logs/speckit-autopilot/%s-%s.raw.jsonl' "$HOME" "$base" "$hash"
}

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

  # --cross-repo: an issue whose fix already shipped as a PR in ANOTHER repo is
  # invisible to every other check here, and launching a full claude session to
  # rediscover that by hand cost three runs in one day (issue #34).
  PREFLIGHT=$(python3 "$SCRIPT_DIR/preflight-issues.py" "$ISSUES_TMP" --cross-repo 2>/dev/null) || PREFLIGHT=""
  rm -f "$ISSUES_TMP"

  if [ -z "$PREFLIGHT" ]; then
    echo "$(ts) preflight: could not evaluate issues — proceeding anyway"
  else
    # The verdict is the FIRST line; `DELIVERED:` park requests follow it.
    VERDICT=$(printf '%s\n' "$PREFLIGHT" | head -1)

    # Park every cross-repo delivery BEFORE acting on the verdict. This wrapper
    # exits on SKIP without ever launching the skill, so if the parking were left
    # to the skill (as it is for a human-driven run) a delivered issue would be
    # rediscovered — same GitHub lookups, same result — on every scheduled tick,
    # forever. It also matters on the PICK path: a delivered issue does not stop
    # preflight's scan, so a later issue can be picked while an earlier delivered
    # one still needs parking. park-issue.sh is shared with the skill precisely so
    # this second caller is not a second, drift-prone implementation.
    printf '%s\n' "$PREFLIGHT" | grep '^DELIVERED: ' | while read -r _tag _num _pr; do
      echo "$(ts) preflight: #$_num already delivered by $_pr — parking"
      bash "$SCRIPT_DIR/park-issue.sh" "$_num" "delivered by $_pr — close this issue, or clear the autopilot:blocked label if that PR does not resolve it" \
        --title "✅ **Already delivered**" >/dev/null 2>&1 \
        || echo "$(ts) preflight: WARNING could not park #$_num; it will be re-checked next tick"
    done

    # If preflight says nothing is eligible, skip the claude session entirely.
    case "$VERDICT" in
      SKIP:*) echo "$(ts) preflight: $VERDICT"; exit 0;;
    esac
    PICKED_ISSUE=$(echo "$VERDICT" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
    echo "$(ts) preflight: $VERDICT"
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
#
# It clears ONLY `autopilot:claimed`. `autopilot:blocked` — the durable park a
# skill writes on a hard blocker (repo issue #32) — must survive this trap and
# every future tick; clearing it here would restore the exact re-pick loop it
# exists to stop. Only a human clears it, once the blocker is actually fixed.
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
#
# The raw stream is tee'd to <slug>.raw.jsonl beside the decoded log so a finished
# pass can be re-decoded (or re-attributed, after a decoder fix) without re-running
# it. It APPENDS: passes are single-flight via the lock above, and each one opens
# with its own `system/init` + fresh session_id, which is delimiter enough — no
# separator line is injected, so the file stays parseable as plain JSONL. The one
# impurity is stderr, folded in by `2>&1` exactly as the decoder already sees it;
# the decoder passes non-JSON lines through, so a re-decode behaves identically.
if [ -f "$DECODER" ]; then
  RAW="${AUTOPILOT_RAW_LOG-$(raw_log_for "$PROJECT")}"
  if [ -n "$RAW" ] && mkdir -p "$(dirname "$RAW")" 2>/dev/null; then
    # Cheap rotation so an unattended repo can't fill the disk with old streams.
    if [ -f "$RAW" ] && [ "$(wc -c <"$RAW" 2>/dev/null || echo 0)" -gt "$RAW_MAX_BYTES" ]; then
      mv -f "$RAW" "$RAW.1" 2>/dev/null || true
    fi
    echo "$(ts) raw stream -> $RAW"
  else
    [ -n "$RAW" ] && echo "$(ts) WARNING cannot write raw stream to $RAW — decoding only"
    RAW=""
  fi
  if [ -n "$RAW" ]; then
    claude -p "$PROMPT" --dangerously-skip-permissions \
           --verbose --output-format stream-json 2>&1 \
      | tee -a "$RAW" \
      | python3 "$DECODER"
  else
    claude -p "$PROMPT" --dangerously-skip-permissions \
           --verbose --output-format stream-json 2>&1 \
      | python3 "$DECODER"
  fi
  status=${PIPESTATUS[0]}
else
  claude -p "$PROMPT" --dangerously-skip-permissions
  status=$?
fi
echo "$(ts) === autopilot pass end (exit $status) ==="
exit "$status"
