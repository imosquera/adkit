#!/usr/bin/env bash
# Autopilot extension: park-issue.sh
# Durably park a GitHub issue so autopilot stops re-picking it.
#
# Usage: park-issue.sh <issue-number> <one-line reason> [--title <comment title>]
#
# This is the SINGLE writer of the durable park. Both the skill body
# (speckit.autopilot.run.md, on a hard blocker or a confirmed cross-repo
# delivery) and the unattended wrapper (autopilot-run.sh, which exits before the
# skill ever starts) call it, so the label name and the AUTOPILOT-BLOCKED
# sentinel can never drift between the two writers the way an inline
# reimplementation would. `preflight-issues.py` is the matching reader.
#
# Parking is deliberately NOT closing: a park says "autopilot should stop
# spending runs on this", which is a weaker claim than "this issue is resolved".
# Closing stays a human's call.

set -e

LABEL="autopilot:blocked"
SENTINEL="AUTOPILOT-BLOCKED:"

N=""
REASON=""
TITLE="🚫 **Autopilot hard blocker**"

while [ $# -gt 0 ]; do
    case "$1" in
        --title)
            [ $# -ge 2 ] || { echo "[autopilot] Error: --title needs a value" >&2; exit 1; }
            TITLE="$2"; shift 2 ;;
        -*)
            echo "[autopilot] Error: unknown option: $1" >&2
            echo "[autopilot] Usage: park-issue.sh <issue-number> <reason> [--title <t>]" >&2
            exit 1 ;;
        *)
            if [ -z "$N" ]; then N="${1#\#}"; else REASON="${REASON:+$REASON }$1"; fi
            shift ;;
    esac
done

if [ -z "$N" ] || [ -z "$REASON" ]; then
    echo "[autopilot] Usage: park-issue.sh <issue-number> <reason> [--title <t>]" >&2
    exit 1
fi
case "$N" in
    ''|*[!0-9]*) echo "[autopilot] Error: bad issue number: $N" >&2; exit 1 ;;
esac

if ! command -v gh >/dev/null 2>&1; then
    echo "[autopilot] Error: gh CLI not found; cannot park #$N" >&2
    exit 1
fi

# The reason has to survive as ONE line: preflight-issues.py's blocked_reason()
# reads back everything after the sentinel on the matching line and replays it
# out of context to whoever re-runs the issue explicitly.
REASON=$(printf '%s' "$REASON" | tr '\n' ' ')

# Already parked → don't post a duplicate comment. This is the common case on a
# scheduled timer: the label is what stops the next tick, so once it is on, a
# re-park would only add noise.
if gh issue view "$N" --json labels -q '.labels[].name' 2>/dev/null | grep -qx "$LABEL"; then
    echo "[autopilot] #$N already parked ($LABEL); leaving the existing reason in place" >&2
    exit 0
fi

gh label create "$LABEL" --color "b60205" \
    --description "Autopilot hit a hard blocker; do not re-pick until resolved" 2>/dev/null || true

# shellcheck disable=SC2016  # the backticks are literal markdown for the comment body
gh issue comment "$N" --body "$(printf '%s — parking this issue; autopilot will not re-pick it until a human clears the `%s` label.\n\n%s %s\n' \
    "$TITLE" "$LABEL" "$SENTINEL" "$REASON")" >/dev/null

gh issue edit "$N" --add-label "$LABEL" >/dev/null

echo "[OK] parked #$N — $REASON" >&2
