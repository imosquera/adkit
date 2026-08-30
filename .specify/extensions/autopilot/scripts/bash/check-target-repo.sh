#!/usr/bin/env bash
# Autopilot extension: check-target-repo.sh
# Answer one question deterministically: do the files this issue asks us to
# change live in the repository this autopilot run is bound to?
#
# Usage: check-target-repo.sh <path> [<path>...]
#        check-target-repo.sh --repo-root <dir> <path> [<path>...]
#
# Output — one line per target, plus a verdict line last:
#   INSIDE:  <path> → <repo>
#   FOREIGN: <path> → <other-repo>
#   OUTSIDE: <path> → no git repo
#   OK: N target(s) inside <repo>          (exit 0)
#   BLOCKED: N of N target(s) not in <repo> (exit 1)
#
# Why this exists: an autopilot timer is bound to ONE repo and checkout
# (autopilot-schedule.sh writes the repo root into the launchd plist, one plist
# per checkout) and it only ever reads issues from that repo. But nothing
# checked where the *fix* had to land. lead-drop#182 asked for a change to a
# file that resolved into a different repository; autopilot did the work and
# opened the PR over there. A run bound to one repo delivered to another, and
# the issue it "finished" stayed open — which is what then caused three more
# runs to pick it up again (repo issue #34).
#
# The existing "fix target outside any git repo" stop condition did not catch
# it: that target was inside a perfectly good repo, just not ours.
#
# Identity is the git COMMON dir, never the worktree toplevel. Autopilot always
# runs inside a worktree (${REPO}.worktrees/…), where `--show-toplevel` is the
# worktree path but `--git-common-dir` is the main repo's .git — comparing
# toplevels would report every in-repo file as foreign.

set -e

REPO_ROOT=""
while [ $# -gt 0 ] && [ "$1" = "--repo-root" ]; do
    REPO_ROOT="${2:?--repo-root needs a path}"; shift 2
done

if [ $# -eq 0 ]; then
    echo "[autopilot] Usage: check-target-repo.sh [--repo-root <dir>] <path>..." >&2
    exit 2
fi

if ! command -v git >/dev/null 2>&1; then
    echo "[autopilot] Error: git not found" >&2
    exit 2
fi

# Identity of a repo = its common git dir (shared by every worktree).
repo_id() {
    git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true
}

# Resolve symlinks and ~, and for a path that does not exist yet (an issue may
# ask for a NEW file) fall back to its deepest existing ancestor — that is the
# directory the file would be created in, so it decides the repo.
resolve() {
    python3 - "$1" <<'PY'
import os, sys
p = os.path.expanduser(sys.argv[1])
p = os.path.abspath(p)
while not os.path.exists(p) and p != os.path.dirname(p):
    p = os.path.dirname(p)
print(os.path.realpath(p))
PY
}

OURS_DIR="${REPO_ROOT:-$PWD}"
OURS=$(repo_id "$OURS_DIR")
if [ -z "$OURS" ]; then
    echo "[autopilot] Error: $OURS_DIR is not inside a git repository" >&2
    exit 2
fi
OURS_NAME=$(git -C "$OURS_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$OURS_DIR")

total=0
bad=0
for target in "$@"; do
    total=$((total + 1))
    real=$(resolve "$target")
    probe="$real"
    [ -d "$probe" ] || probe="$(dirname "$probe")"

    theirs=$(repo_id "$probe")
    if [ -z "$theirs" ]; then
        echo "OUTSIDE: $target → no git repo"
        bad=$((bad + 1))
    elif [ "$theirs" = "$OURS" ]; then
        echo "INSIDE: $target → $OURS_NAME"
    else
        theirs_name=$(git -C "$probe" rev-parse --show-toplevel 2>/dev/null || echo "$theirs")
        echo "FOREIGN: $target → $theirs_name"
        bad=$((bad + 1))
    fi
done

if [ "$bad" -eq 0 ]; then
    echo "OK: $total target(s) inside $OURS_NAME"
    exit 0
fi
echo "BLOCKED: $bad of $total target(s) not in $OURS_NAME"
exit 1
