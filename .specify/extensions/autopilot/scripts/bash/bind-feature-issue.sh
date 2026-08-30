#!/usr/bin/env bash
# Bind a worktree to an existing GitHub issue by writing `.specify/feature.json`.
#
# Usage: bind-feature-issue.sh <issue-number> [worktree-path]
#
# Autopilot creates a worktree with GIT_BRANCH_NAME set, which makes
# /speckit-git-feature skip issue creation — so nothing writes the linkage and
# the worktree can still be carrying an *inherited* feature.json from the base
# branch (issue #33). This script performs that binding through the git
# extension's shared writer, `spec_kit_write_feature_json()`, rather than a raw
# `printf > .specify/feature.json`.
#
# The distinction matters: the shared writer also runs
# `spec_kit_ignore_feature_json()`, which gitignores the file and
# `git rm --cached`s it in a project whose older layout committed it. A raw
# printf writes a *tracked* file, which then propagates to the next worktree cut
# from that branch — reintroducing the exact stale-inheritance failure #33
# removed, on the one path that runs unattended (issue #21).

set -euo pipefail

usage() {
    echo "Usage: $(basename "$0") <issue-number> [worktree-path]" >&2
}

ISSUE="${1:-}"
WORKTREE="${2:-$(pwd)}"

if [ -z "$ISSUE" ]; then
    usage
    exit 1
fi

if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then
    echo "[autopilot] Issue number must be numeric, got: $ISSUE" >&2
    exit 1
fi

if ! git -C "$WORKTREE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[autopilot] Not a git worktree: $WORKTREE" >&2
    exit 1
fi

# Normalise to the worktree root so the writer's `.specify/` and `.gitignore`
# paths land at the top level even when invoked from a subdirectory.
WORKTREE="$(git -C "$WORKTREE" rev-parse --show-toplevel)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_COMMON=""
for candidate in \
    "$SCRIPT_DIR/../../../git/scripts/bash/git-common.sh" \
    "$WORKTREE/.specify/extensions/git/scripts/bash/git-common.sh" \
    "${CLAUDE_PROJECT_DIR:-}/.specify/extensions/git/scripts/bash/git-common.sh"
do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
        GIT_COMMON="$candidate"
        break
    fi
done

if [ -z "$GIT_COMMON" ]; then
    echo "[autopilot] Could not locate the git extension's git-common.sh." >&2
    echo "[autopilot] The git extension is required — install it with:" >&2
    echo "[autopilot]   specify extension add git" >&2
    exit 1
fi

# shellcheck source=../../../git/scripts/bash/git-common.sh
source "$GIT_COMMON"

if ! declare -F spec_kit_write_feature_json >/dev/null; then
    echo "[autopilot] $GIT_COMMON does not define spec_kit_write_feature_json (git extension too old)." >&2
    exit 1
fi

spec_kit_write_feature_json "$WORKTREE" "$ISSUE"

echo "[autopilot] Bound $WORKTREE to issue #$ISSUE (.specify/feature.json, gitignored)."
