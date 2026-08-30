#!/usr/bin/env bash
# Git extension: auto-commit.sh
# Automatically commit changes after a Spec Kit command completes.
# Checks per-command config keys in git-config.yml before committing.
#
# Usage: auto-commit.sh <event_name>
#   e.g.: auto-commit.sh after_specify

set -e

EVENT_NAME="${1:-}"
if [ -z "$EVENT_NAME" ]; then
    echo "Usage: $0 <event_name>" >&2
    exit 1
fi

SCRIPT_DIR="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_find_project_root() {
    local dir="$1"
    while [ "$dir" != "/" ]; do
        if [ -d "$dir/.specify" ] || [ -d "$dir/.git" ]; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

REPO_ROOT=$(_find_project_root "$SCRIPT_DIR") || REPO_ROOT="$(pwd)"
cd "$REPO_ROOT"

# spec_kit_commit_excludes() lives here — the shared reader for `commit_exclude`,
# so this hook and create-pr.sh can never disagree about which generated paths
# stay out of a feature branch.
# shellcheck source=./git-common.sh
[ -f "$SCRIPT_DIR/git-common.sh" ] && source "$SCRIPT_DIR/git-common.sh"

# Check if git is available
if ! command -v git >/dev/null 2>&1; then
    echo "[specify] Warning: Git not found; skipped auto-commit" >&2
    exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[specify] Warning: Not a Git repository; skipped auto-commit" >&2
    exit 0
fi

# Read per-command config from git-config.yml
_config_file="$REPO_ROOT/.specify/extensions/git/git-config.yml"
_enabled=false
_commit_msg=""

if [ -f "$_config_file" ]; then
    # Parse the auto_commit section for this event.
    # Look for auto_commit.<event_name>.enabled and .message
    # Also check auto_commit.default as fallback.
    _in_auto_commit=false
    _in_event=false
    _default_enabled=false

    while IFS= read -r _line; do
        # Detect auto_commit: section
        if echo "$_line" | grep -q '^auto_commit:'; then
            _in_auto_commit=true
            _in_event=false
            continue
        fi

        # Exit auto_commit section on next top-level key
        if $_in_auto_commit && echo "$_line" | grep -Eq '^[a-z]'; then
            break
        fi

        if $_in_auto_commit; then
            # Check default key
            if echo "$_line" | grep -Eq "^[[:space:]]+default:[[:space:]]"; then
                _val=$(echo "$_line" | sed 's/^[^:]*:[[:space:]]*//' | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
                [ "$_val" = "true" ] && _default_enabled=true
            fi

            # Detect our event subsection
            if echo "$_line" | grep -Eq "^[[:space:]]+${EVENT_NAME}:"; then
                _in_event=true
                continue
            fi

            # Inside our event subsection
            if $_in_event; then
                # Exit on next sibling key (same indent level as event name)
                if echo "$_line" | grep -Eq '^[[:space:]]{2}[a-z]' && ! echo "$_line" | grep -Eq '^[[:space:]]{4}'; then
                    _in_event=false
                    continue
                fi
                if echo "$_line" | grep -Eq '[[:space:]]+enabled:'; then
                    _val=$(echo "$_line" | sed 's/^[^:]*:[[:space:]]*//' | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
                    [ "$_val" = "true" ] && _enabled=true
                    [ "$_val" = "false" ] && _enabled=false
                fi
                if echo "$_line" | grep -Eq '[[:space:]]+message:'; then
                    _commit_msg=$(echo "$_line" | sed 's/^[^:]*:[[:space:]]*//' | sed 's/^["'\'']//' | sed 's/["'\'']*$//')
                fi
            fi
        fi
    done < "$_config_file"

    # If event-specific key not found, use default
    if [ "$_enabled" = "false" ] && [ "$_default_enabled" = "true" ]; then
        # Only use default if the event wasn't explicitly set to false
        # Check if event section existed at all
        if ! grep -q "^[[:space:]]*${EVENT_NAME}:" "$_config_file" 2>/dev/null; then
            _enabled=true
        fi
    fi
else
    # No config file — auto-commit disabled by default
    exit 0
fi

if [ "$_enabled" != "true" ]; then
    exit 0
fi

# Check if there are changes to commit
if git diff --quiet HEAD 2>/dev/null && git diff --cached --quiet 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
    echo "[specify] No changes to commit after $EVENT_NAME" >&2
    exit 0
fi

# Derive a human-readable command name from the event
# e.g., after_specify -> specify, before_plan -> plan
_command_name=$(echo "$EVENT_NAME" | sed 's/^after_//' | sed 's/^before_//')
_phase=$(echo "$EVENT_NAME" | grep -q '^before_' && echo 'before' || echo 'after')

# Use custom message if configured, otherwise default
if [ -z "$_commit_msg" ]; then
    _commit_msg="[Spec Kit] Auto-commit ${_phase} ${_command_name}"
fi

# Append `Closes #N` if .specify/feature.json carries a source_issue.
# Only do this when the message doesn't already reference the issue, and
# only on `after_*` events (a `before_*` commit is a checkpoint, not a fix).
#
# source_issue is the file's only field — everything else about the feature is
# derived from git by spec_kit_resolve_feature (git-common.sh), so there is no
# stale identity to inherit here (issue #33).
_feature_json="$REPO_ROOT/.specify/feature.json"
if [ "$_phase" = "after" ] && [ -f "$_feature_json" ]; then
    _source_issue=$(sed -nE 's/.*"source_issue"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' \
        "$_feature_json" 2>/dev/null | head -1)
    if echo "$_source_issue" | grep -Eq '^[0-9]+$'; then
        if ! echo "$_commit_msg" | grep -Eqi "(closes|fixes|resolves)[[:space:]]+#${_source_issue}\b"; then
            _commit_msg="${_commit_msg}

Closes #${_source_issue}"
        fi
    fi
fi

# Stage and commit.
#
# `commit_exclude` paths are held out of the staging pathspec entirely. They are
# repo-tracked artifacts whose canonical copy is rebuilt on the default branch by
# CI (see spec_kit_commit_excludes in git-common.sh); a lifecycle hook that
# regenerates one mid-run must not have `git add .` sweep the result onto the
# feature branch, or the PR diff becomes unreviewable and every later rebase
# conflicts on it (issue #22).
_add_args=(.)
_excluded=""
if type spec_kit_commit_excludes >/dev/null 2>&1; then
    while IFS= read -r _ex; do
        [ -n "$_ex" ] || continue
        _add_args+=(":(exclude)$_ex")
        _excluded="${_excluded:+$_excluded, }$_ex"
    done < <(spec_kit_commit_excludes "$REPO_ROOT")
fi

_git_out=$(git add -- "${_add_args[@]}" 2>&1) || { echo "[specify] Error: git add failed: $_git_out" >&2; exit 1; }

# The pre-stage check above sees the whole tree, so a run whose ONLY changes are
# excluded paths reaches here with an empty index. That is a success, not the
# "nothing to commit" error `git commit` would raise.
if git diff --cached --quiet 2>/dev/null; then
    echo "[specify] Nothing to commit after $EVENT_NAME — all changes are in excluded paths (${_excluded:-none})" >&2
    exit 0
fi

_git_out=$(git commit -q -m "$_commit_msg" 2>&1) || { echo "[specify] Error: git commit failed: $_git_out" >&2; exit 1; }

if [ -n "$_excluded" ]; then
    echo "[specify] Held out of the commit: $_excluded" >&2
fi
echo "[OK] Changes committed ${_phase} ${_command_name}" >&2
