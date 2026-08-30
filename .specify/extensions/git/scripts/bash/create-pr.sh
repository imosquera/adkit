#!/usr/bin/env bash
# Git extension: create-pr.sh
# Open a GitHub PR for the current feature branch. If .specify/feature.json
# carries `source_issue`, the PR body includes `Closes #N` so merging the PR
# automatically closes the originating GitHub issue.
#
# Usage: create-pr.sh [base_branch] [--draft]
#   base_branch defaults to "main".
#   --draft opens the PR as a draft directly (gh pr create --draft) instead of
#   creating a mergeable PR that then has to be converted with `gh pr ready
#   --undo` after the fact. Callers that use --draft must also skip the
#   /speckit-archive-feature pre-step — see commands/speckit.git.pr.md — so the
#   tracking issue stays open and the spec stays unarchived until a human
#   merges (issue #28).

set -e

BASE_BRANCH=""
DRAFT=false
for _arg in "$@"; do
    case "$_arg" in
        --draft) DRAFT=true ;;
        -*)
            echo "[specify] Error: unknown option: $_arg" >&2
            echo "[specify] Usage: create-pr.sh [base_branch] [--draft]" >&2
            exit 1
            ;;
        *)
            if [ -n "$BASE_BRANCH" ]; then
                echo "[specify] Error: unexpected argument: $_arg" >&2
                exit 1
            fi
            BASE_BRANCH="$_arg"
            ;;
    esac
done
BASE_BRANCH="${BASE_BRANCH:-main}"

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

# spec_kit_resolve_feature lives here; it derives branch/num/worktree/spec-dir
# from git and reads only `source_issue` out of .specify/feature.json.
# shellcheck source=./git-common.sh
[ -f "$SCRIPT_DIR/git-common.sh" ] && source "$SCRIPT_DIR/git-common.sh"

if ! command -v git >/dev/null 2>&1; then
    echo "[specify] Error: git not found" >&2
    exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
    echo "[specify] Error: gh CLI not found; install https://cli.github.com/" >&2
    exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[specify] Error: not inside a git repository" >&2
    exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "$BASE_BRANCH" ]; then
    echo "[specify] Error: refuse to open a PR from $BASE_BRANCH into itself" >&2
    exit 1
fi

# Locate feature directory and source_issue. The directory is derived from the
# branch (never read from a file that could name the previous feature); only
# source_issue comes out of .specify/feature.json.
_feature_dir=""
_source_issue=""
if type spec_kit_resolve_feature >/dev/null 2>&1 && spec_kit_resolve_feature "$REPO_ROOT"; then
    _feature_dir="$FEATURE_DIRECTORY"
    _source_issue="$FEATURE_SOURCE_ISSUE"
else
    _feature_dir="specs/${CURRENT_BRANCH##*/}"
    [ -d "$REPO_ROOT/$_feature_dir" ] || _feature_dir=""
    _source_issue=$(sed -nE 's/.*"source_issue"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' \
        "$REPO_ROOT/.specify/feature.json" 2>/dev/null | head -1)
fi

# Build PR title from the spec.md H1 if available, otherwise from branch name
_pr_title=""
if [ -n "$_feature_dir" ] && [ -f "$REPO_ROOT/$_feature_dir/spec.md" ]; then
    _pr_title=$(grep -m1 -E '^#[[:space:]]*Feature Specification:' "$REPO_ROOT/$_feature_dir/spec.md" \
        | sed -E 's/^#[[:space:]]*Feature Specification:[[:space:]]*//')
fi
if [ -z "$_pr_title" ]; then
    _pr_title="$CURRENT_BRANCH"
fi

# Build PR body
_pr_body=""
if [ -n "$_feature_dir" ]; then
    _pr_body="Spec: \`${_feature_dir}/spec.md\`

See plan, tasks, and quickstart under \`${_feature_dir}/\`."
else
    _pr_body="See branch \`${CURRENT_BRANCH}\`."
fi

if echo "$_source_issue" | grep -Eq '^[0-9]+$'; then
    _pr_body="${_pr_body}

Closes #${_source_issue}"
fi

# Read squash_before_pr from git-config.yml
_config_file="$REPO_ROOT/.specify/extensions/git/git-config.yml"
_squash=false
if [ -f "$_config_file" ]; then
    _val=$(grep -E '^[[:space:]]*squash_before_pr:' "$_config_file" 2>/dev/null \
        | head -1 \
        | sed -E 's/^[[:space:]]*squash_before_pr:[[:space:]]*//' \
        | tr -d '[:space:]' \
        | tr '[:upper:]' '[:lower:]')
    [ "$_val" = "true" ] && _squash=true
fi

# Make the base branch available locally (needed to diff an excluded path
# against it, and by the squash path below to compute a merge-base).
_ensure_base_local() {
    git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1 && return 0
    git ls-remote --exit-code --heads origin "$BASE_BRANCH" >/dev/null 2>&1 || return 1
    git fetch origin "$BASE_BRANCH":"$BASE_BRANCH" >/dev/null 2>&1 || \
        git fetch origin "$BASE_BRANCH" >/dev/null 2>&1 || return 1
    return 0
}

# Reconcile `commit_exclude` paths before anything inspects the working tree.
#
# The auto-commit hook already keeps these generated artifacts out of every
# commit, but a lifecycle hook that regenerated one (graphify, typically) leaves
# the result sitting in the working tree. Left alone it would abort the squash
# path below on "working tree has uncommitted changes" — so restore tracked
# content to HEAD and drop the untracked leftovers, which is exactly the manual
# reconcile every autopilot run used to perform by hand before opening its PR
# (issue #22).
#
# This only ever touches paths the project explicitly listed in commit_exclude.
# `git clean` here is deliberate and scoped to those paths: they are rebuilt
# artifacts, not work. It is not passed -x, so genuinely ignored files survive.
if type spec_kit_commit_excludes >/dev/null 2>&1; then
    _base_ok=false
    _ensure_base_local && _base_ok=true
    _reset_any=false

    while IFS= read -r _ex; do
        [ -n "$_ex" ] || continue

        # (a) Working tree: drop the hook's regenerated output. Without this the
        # squash path below aborts on "working tree has uncommitted changes".
        if [ -e "$REPO_ROOT/$_ex" ]; then
            if ! git diff --quiet -- "$_ex" 2>/dev/null || \
               [ -n "$(git ls-files --others --exclude-standard -- "$_ex" 2>/dev/null)" ]; then
                echo "[specify] Reconciling excluded artifact to HEAD: $_ex" >&2
                git checkout -- "$_ex" 2>/dev/null || true
                git clean -qfd -- "$_ex" 2>/dev/null || true
            fi
        fi

        # (b) Committed history: the exclusion only governs commits this hook
        # makes. A path can still have landed on the branch from a run predating
        # the config, a manual `git add -A`, or a merge — and then it is in the
        # PR diff no matter how clean the working tree is. Reset it to the base
        # so the diff carries none of it, which is precisely the manual
        # `git checkout main -- graphify-out/` every autopilot run used to do.
        if [ "$_base_ok" = "true" ] && \
           ! git diff --quiet "$BASE_BRANCH"...HEAD -- "$_ex" 2>/dev/null; then
            echo "[specify] Excluded artifact diverges from $BASE_BRANCH; resetting: $_ex" >&2
            # Drop the whole path from the index FIRST, then restore the base's
            # version on top. `git checkout <base> -- <dir>` alone is not enough:
            # it rewrites files the base also has, but silently leaves behind any
            # file the branch ADDED under that directory — and a dated snapshot
            # directory (graphify-out/<date>/) is entirely branch-added, so it
            # would survive and stay in the PR diff. Removing then restoring
            # reproduces the base's tree exactly, whichever shape the divergence
            # took. If the path does not exist on the base at all, the restore is
            # a harmless no-op and the path simply stays out.
            git rm -rq --cached --ignore-unmatch -- "$_ex" 2>/dev/null || true
            git checkout "$BASE_BRANCH" -- "$_ex" 2>/dev/null || true
            _reset_any=true
        fi
    done < <(spec_kit_commit_excludes "$REPO_ROOT")

    if [ "$_reset_any" = "true" ] && ! git diff --cached --quiet 2>/dev/null; then
        git commit -q -m "chore: reset excluded generated artifacts to ${BASE_BRANCH}" \
            || echo "[specify] Warning: could not commit the artifact reset" >&2
    fi
fi

# Squash all feature-branch commits into one before pushing
if [ "$_squash" = "true" ]; then
    # Need the base branch locally to compute the merge-base
    _ensure_base_local || true

    _merge_base=$(git merge-base HEAD "$BASE_BRANCH" 2>/dev/null || \
        git merge-base HEAD "origin/$BASE_BRANCH" 2>/dev/null || true)
    if [ -z "$_merge_base" ]; then
        echo "[specify] Error: cannot compute merge-base with $BASE_BRANCH; aborting squash" >&2
        exit 1
    fi

    _commit_count=$(git rev-list --count "$_merge_base"..HEAD 2>/dev/null || echo 0)
    if [ "$_commit_count" -gt 1 ]; then
        if ! git diff-index --quiet HEAD 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
            echo "[specify] Error: working tree has uncommitted changes; commit or stash before squashing" >&2
            exit 1
        fi

        echo "[specify] Squashing $_commit_count commits into one..." >&2
        # Title: spec H1 if available, else current branch
        _squash_title="$_pr_title"
        # Body: bullet list of original subjects (oldest → newest)
        _squash_body=$(git log --reverse --format='- %s' "$_merge_base"..HEAD)
        if echo "$_source_issue" | grep -Eq '^[0-9]+$'; then
            _squash_body="${_squash_body}

Closes #${_source_issue}"
        fi

        git reset --soft "$_merge_base"
        git commit -q -m "$_squash_title" -m "$_squash_body"
    elif [ "$_commit_count" -eq 0 ]; then
        echo "[specify] Warning: no commits between $BASE_BRANCH and HEAD; nothing to squash" >&2
    fi
fi

# Ensure branch is pushed (force-with-lease if we squashed an already-pushed branch)
if ! git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" >/dev/null 2>&1; then
    echo "[specify] Pushing $CURRENT_BRANCH to origin..." >&2
    git push -u origin "$CURRENT_BRANCH" >/dev/null
elif [ "$_squash" = "true" ]; then
    echo "[specify] Force-pushing squashed $CURRENT_BRANCH to origin..." >&2
    git push --force-with-lease origin "$CURRENT_BRANCH" >/dev/null
fi

# Open the PR (skip if one already exists for this branch)
if gh pr view "$CURRENT_BRANCH" >/dev/null 2>&1; then
    _url=$(gh pr view "$CURRENT_BRANCH" --json url -q .url)
    if [ "$DRAFT" = "true" ] && \
        [ "$(gh pr view "$CURRENT_BRANCH" --json isDraft -q .isDraft 2>/dev/null)" = "false" ]; then
        echo "[specify] Warning: existing PR is not a draft; convert it with \`gh pr ready $_url --undo\`" >&2
    fi
    echo "[OK] PR already exists: $_url" >&2
    exit 0
fi

_gh_args=(--base "$BASE_BRANCH" --head "$CURRENT_BRANCH" --title "$_pr_title" --body "$_pr_body")
if [ "$DRAFT" = "true" ]; then
    _gh_args+=(--draft)
fi

_url=$(gh pr create "${_gh_args[@]}")
if [ "$DRAFT" = "true" ]; then
    echo "[OK] Draft PR created: $_url" >&2
else
    echo "[OK] PR created: $_url" >&2
fi
