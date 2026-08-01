#!/usr/bin/env bash
set -euo pipefail

FORCE=0
TARGET_WORKTREE=""
TARGET_SPEC=""
TARGET_ISSUE=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f)
      FORCE=1
      shift
      ;;
    --worktree)
      [[ $# -ge 2 ]] || { echo "[clean] --worktree requires a path" >&2; exit 1; }
      TARGET_WORKTREE="$2"
      shift 2
      ;;
    --spec)
      [[ $# -ge 2 ]] || { echo "[clean] --spec requires a path" >&2; exit 1; }
      TARGET_SPEC="$2"
      shift 2
      ;;
    --issue)
      [[ $# -ge 2 ]] || { echo "[clean] --issue requires a number" >&2; exit 1; }
      TARGET_ISSUE="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage: clean.sh [--force|-f] [--worktree <path>] [--spec <path>] [--issue <number>] [target]

Targets may be a worktree path, a spec directory, or an issue number.
EOF
      exit 0
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -gt 1 ]]; then
  echo "[clean] only one positional target may be given" >&2
  exit 1
fi

POSITIONAL_TARGET="${POSITIONAL[0]:-}"
if [[ -z "$TARGET_WORKTREE" && -z "$TARGET_SPEC" && -z "$TARGET_ISSUE" && -n "$POSITIONAL_TARGET" ]]; then
  if [[ "$POSITIONAL_TARGET" =~ ^#?[0-9]+$ ]]; then
    TARGET_ISSUE="${POSITIONAL_TARGET#\#}"
  elif [[ "$POSITIONAL_TARGET" == specs/* ]] || [[ "$POSITIONAL_TARGET" == */specs/* ]]; then
    TARGET_SPEC="$POSITIONAL_TARGET"
  else
    TARGET_WORKTREE="$POSITIONAL_TARGET"
  fi
fi

if [[ -n "$TARGET_WORKTREE" && -n "$TARGET_SPEC" ]] || [[ -n "$TARGET_WORKTREE" && -n "$TARGET_ISSUE" ]] || [[ -n "$TARGET_SPEC" && -n "$TARGET_ISSUE" ]]; then
  echo "[clean] pick exactly one of --worktree, --spec, or --issue" >&2
  exit 1
fi

SCRIPT_DIR="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_project_root() {
  local dir="$1"
  while [[ "$dir" != "/" ]]; do
    if [[ -d "$dir/.specify" ]] || [[ -d "$dir/.git" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

read_feature_json() {
  local json_file="$1"
  FEATURE_DIRECTORY=""
  WORKTREE_PATH=""
  SOURCE_ISSUE=""

  [[ -f "$json_file" ]] || return 1

  FEATURE_DIRECTORY="$(sed -nE 's/.*"feature_directory"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$json_file" | head -1 || true)"
  WORKTREE_PATH="$(sed -nE 's/.*"worktree_path"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$json_file" | head -1 || true)"
  SOURCE_ISSUE="$(sed -nE 's/.*"source_issue"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$json_file" | head -1 || true)"
}

get_primary_worktree() {
  git worktree list --porcelain 2>/dev/null | awk '/^worktree / {print $2; exit}'
}

get_branch_for_worktree() {
  local worktree_root="$1"
  git -C "$worktree_root" branch --show-current 2>/dev/null || true
}

get_status_files() {
  local worktree_root="$1"
  git -C "$worktree_root" status --porcelain
}

REPO_ROOT="$(find_project_root "$SCRIPT_DIR")" || REPO_ROOT="$(pwd)"
cd "$REPO_ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "[clean] git not found" >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[clean] not a git repository" >&2
  exit 1
fi

WORKTREE_ROOT=""
SPEC_PATH=""
FEATURE_JSON=""
FEATURE_DIRECTORY=""
WORKTREE_PATH=""
SOURCE_ISSUE=""
BRANCH_NAME=""

if [[ -n "$TARGET_WORKTREE" ]]; then
  WORKTREE_ROOT="$TARGET_WORKTREE"
elif [[ -n "$TARGET_SPEC" ]]; then
  SPEC_PATH="$TARGET_SPEC"
  if [[ -d "$SPEC_PATH" && "$(basename "$(dirname "$SPEC_PATH")")" == specs ]]; then
    WORKTREE_ROOT="$(dirname "$(dirname "$SPEC_PATH")")"
  else
    WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
  fi
elif [[ -n "$TARGET_ISSUE" ]]; then
  WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
else
  WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
fi

if [[ -n "$WORKTREE_ROOT" ]]; then
  WORKTREE_ROOT="$(cd "$WORKTREE_ROOT" && pwd)"
fi

FEATURE_JSON="$WORKTREE_ROOT/.specify/feature.json"
if [[ -f "$FEATURE_JSON" ]]; then
  read_feature_json "$FEATURE_JSON"
  [[ -n "$WORKTREE_PATH" ]] && WORKTREE_ROOT="$WORKTREE_PATH"
  [[ -z "$WORKTREE_ROOT" ]] && WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
  BRANCH_NAME="$(get_branch_for_worktree "$WORKTREE_ROOT")"
fi

if [[ -z "$BRANCH_NAME" ]]; then
  BRANCH_NAME="$(git -C "$WORKTREE_ROOT" branch --show-current 2>/dev/null || true)"
fi

if [[ -n "$TARGET_ISSUE" ]]; then
  if [[ -z "$SOURCE_ISSUE" ]]; then
    echo "[clean] no source_issue recorded in $FEATURE_JSON; cannot match issue #$TARGET_ISSUE" >&2
    exit 1
  fi
  if [[ "$SOURCE_ISSUE" != "$TARGET_ISSUE" ]]; then
    echo "[clean] recorded source_issue #$SOURCE_ISSUE does not match requested issue #$TARGET_ISSUE" >&2
    exit 1
  fi
fi

if [[ -z "$FEATURE_DIRECTORY" && -z "$TARGET_SPEC" && -z "$TARGET_WORKTREE" && -z "$TARGET_ISSUE" ]]; then
  echo "[clean] .specify/feature.json is missing; pass --worktree, --spec, or --issue to identify the feature" >&2
  exit 1
fi

STATUS_FILES="$(get_status_files "$WORKTREE_ROOT")"
if [[ -n "$STATUS_FILES" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "[clean] refusing to discard uncommitted changes in $WORKTREE_ROOT (use --force to override):" >&2
    printf '%s\n' "$STATUS_FILES" | sed 's/^/[clean]   /' >&2
    exit 1
  fi
  echo "[clean] --force: discarding uncommitted changes in $WORKTREE_ROOT" >&2
  git -C "$WORKTREE_ROOT" reset --hard
  git -C "$WORKTREE_ROOT" clean -fd
fi

if [[ -n "$SOURCE_ISSUE" ]]; then
  if command -v gh >/dev/null 2>&1; then
    if gh issue view "$SOURCE_ISSUE" >/dev/null 2>&1; then
      gh issue close "$SOURCE_ISSUE" -c "Feature cleaned up from ${FEATURE_DIRECTORY:-$WORKTREE_ROOT}." || echo "[clean] warning: failed to close issue #$SOURCE_ISSUE" >&2
      echo "[clean] closed issue #$SOURCE_ISSUE"
    else
      echo "[clean] issue #$SOURCE_ISSUE not visible to gh; skipping close" >&2
    fi
  else
    echo "[clean] gh CLI not found; skipping issue close (#$SOURCE_ISSUE)" >&2
  fi
fi

PRIMARY_WORKTREE="$(get_primary_worktree)"
if [[ -z "$PRIMARY_WORKTREE" ]]; then
  PRIMARY_WORKTREE="$WORKTREE_ROOT"
fi

if [[ "$WORKTREE_ROOT" != "$PRIMARY_WORKTREE" && -d "$WORKTREE_ROOT" ]]; then
  echo "[clean] removing worktree $WORKTREE_ROOT"
  git -C "$PRIMARY_WORKTREE" worktree remove --force "$WORKTREE_ROOT"
elif [[ "$WORKTREE_ROOT" == "$PRIMARY_WORKTREE" ]]; then
  echo "[clean] target is the primary checkout; worktree removal skipped"
fi

if [[ -n "$BRANCH_NAME" ]]; then
  if git -C "$PRIMARY_WORKTREE" show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    if git -C "$PRIMARY_WORKTREE" branch -D "$BRANCH_NAME"; then
      echo "[clean] deleted branch $BRANCH_NAME"
    else
      echo "[clean] warning: branch $BRANCH_NAME could not be deleted" >&2
    fi
  fi
fi

if [[ -n "$FEATURE_DIRECTORY" ]]; then
  echo "[clean] cleaned feature $FEATURE_DIRECTORY"
else
  echo "[clean] cleaned worktree $WORKTREE_ROOT"
fi