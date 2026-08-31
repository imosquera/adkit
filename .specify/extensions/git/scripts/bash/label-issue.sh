#!/usr/bin/env bash
#
# Apply (and, when missing, create) the triage labels that describe an issue's
# priority and kind: `p0`..`p3` and `bug`/`feature`.
#
# These two axes are not decoration — they are the input to autopilot's picker.
# `preflight-issues.py` orders the eligible backlog by (priority, bug-before-
# feature, age), so an unlabelled backlog degrades to plain oldest-first and a
# genuine P0 waits behind whatever chore happens to be older. This script is the
# single writer of that vocabulary, shared by `/speckit-git-issue` and
# `/speckit-git-feature`, so the strings a writer emits can never drift from the
# ones the reader matches on. Keep it in sync with `PRIORITY_RE` / `BUG_LABELS`
# in `extensions/autopilot/scripts/bash/preflight-issues.py`.
#
# Priority is exclusive: setting one removes the other three, so an issue can
# never carry `p0, p2` and leave the picker to guess (it takes the lowest, but
# a contradictory pair is a triage bug, not a preference). Kind is exclusive the
# same way.
#
# Usage:
#   label-issue.sh <issue-number> [--priority p0|p1|p2|p3] [--kind bug|feature]
#   label-issue.sh <issue-number> --show      print current triage labels, one per line
#
# Both label flags are optional; passing neither with no --show is a no-op exit 0,
# so a caller that resolved nothing to set does not have to branch around it.
#
# Exit codes: 0 ok (or nothing to do), 1 usage/`gh` error.

set -uo pipefail

PRIORITIES="p0 p1 p2 p3"
KINDS="bug feature"

die() { echo "[speckit-git-issue] error: $*" >&2; exit 1; }

# Colors/descriptions used only when the label does not exist yet; an existing
# label is never restyled, because the repo's own choices outrank ours.
label_color() {
  case "$1" in
    p0) echo "b60205";;   # red
    p1) echo "d93f0b";;   # orange
    p2) echo "fbca04";;   # yellow
    p3) echo "0e8a16";;   # green
    bug) echo "d73a4a";;
    feature) echo "a2eeef";;
    *) echo "ededed";;
  esac
}

label_desc() {
  case "$1" in
    p0) echo "Critical — work this before anything else";;
    p1) echo "High priority";;
    p2) echo "Normal priority (autopilot's default when unlabelled)";;
    p3) echo "Low priority — work only when nothing else is pending";;
    bug) echo "Something is broken";;
    feature) echo "New capability or enhancement";;
    *) echo "";;
  esac
}

ensure_label() {
  local name="$1"
  # `gh label create` fails loudly when the label already exists, which is the
  # common case; --force would rewrite an existing label's color/description and
  # stomp the repo's own styling, so swallow the duplicate instead.
  gh label create "$name" --color "$(label_color "$name")" \
     --description "$(label_desc "$name")" >/dev/null 2>&1 || true
}

ISSUE=""; PRIORITY=""; KIND=""; SHOW=false
while [ $# -gt 0 ]; do
  case "$1" in
    --priority) PRIORITY="$(printf '%s' "${2:?--priority needs a value}" | tr 'A-Z' 'a-z')"; shift 2;;
    --kind)     KIND="$(printf '%s' "${2:?--kind needs a value}" | tr 'A-Z' 'a-z')"; shift 2;;
    --show)     SHOW=true; shift;;
    -h|--help)  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    -*)         die "unknown flag: $1";;
    *)          [ -z "$ISSUE" ] || die "unexpected argument: $1"; ISSUE="${1#\#}"; shift;;
  esac
done

[ -n "$ISSUE" ] || die "usage: label-issue.sh <issue-number> [--priority pN] [--kind bug|feature] [--show]"
[[ "$ISSUE" =~ ^[0-9]+$ ]] || die "issue number must be numeric (got '$ISSUE')"
command -v gh >/dev/null 2>&1 || die "gh not found — install it or run 'gh auth login'"

if $SHOW; then
  gh issue view "$ISSUE" --json labels --jq '.labels[].name' 2>/dev/null \
    | tr 'A-Z' 'a-z' \
    | grep -Ex "$(echo "$PRIORITIES $KINDS" | tr ' ' '|')" || true
  exit 0
fi

[ -n "$PRIORITY$KIND" ] || exit 0

ADD=(); REMOVE=()

if [ -n "$PRIORITY" ]; then
  echo " $PRIORITIES " | grep -q " $PRIORITY " || die "--priority must be one of: $PRIORITIES"
  ensure_label "$PRIORITY"
  ADD+=("$PRIORITY")
  for p in $PRIORITIES; do [ "$p" = "$PRIORITY" ] || REMOVE+=("$p"); done
fi

if [ -n "$KIND" ]; then
  echo " $KINDS " | grep -q " $KIND " || die "--kind must be one of: $KINDS"
  ensure_label "$KIND"
  ADD+=("$KIND")
  for k in $KINDS; do [ "$k" = "$KIND" ] || REMOVE+=("$k"); done
fi

# One `gh issue edit` for both directions. --remove-label on a label the issue
# does not carry is accepted by gh, so there is no need to read the current set
# first — but a label that does not exist in the *repo* is an error, hence the
# 2>&1 capture and the tolerant treatment of removals below.
ARGS=(issue edit "$ISSUE")
for l in "${ADD[@]}";    do ARGS+=(--add-label "$l"); done
for l in "${REMOVE[@]}"; do ARGS+=(--remove-label "$l"); done

if ! OUT=$(gh "${ARGS[@]}" 2>&1); then
  # Retry with additions only: the usual cause is a repo that has never had one
  # of the sibling labels, which makes its removal an error even though the
  # label we care about applied cleanly.
  ARGS=(issue edit "$ISSUE")
  for l in "${ADD[@]}"; do ARGS+=(--add-label "$l"); done
  gh "${ARGS[@]}" >/dev/null 2>&1 \
    || die "gh issue edit failed for #$ISSUE: $OUT"
fi

echo "[speckit-git-issue] #$ISSUE labelled: ${ADD[*]}"
