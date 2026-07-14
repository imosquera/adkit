#!/usr/bin/env bash
# Archive extension: archive-feature.sh
# Move specs/{slug}/ to specs/archive/YYYY-MM-DD-{slug}/, update CHANGES.md,
# and close the source GitHub issue (if recorded).
#
# Usage: archive-feature.sh [--force] [feature_slug]
#   When the slug is omitted, it is read from .specify/feature.json (feature_directory).
#   --force skips the "tasks.md must have no unchecked items" gate (use for superseded/stale specs).

set -e

FORCE=0
ARGS=()
for arg in "$@"; do
    case "$arg" in
        --force|-f) FORCE=1 ;;
        *) ARGS+=("$arg") ;;
    esac
done
set -- "${ARGS[@]}"

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

command -v git >/dev/null 2>&1 || { echo "[archive] git not found" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[archive] not a git repo" >&2; exit 1; }

# Resolve feature slug
FEATURE_SLUG="${1:-}"
FEATURE_JSON="$REPO_ROOT/.specify/feature.json"
SOURCE_ISSUE=""

if [ -z "$FEATURE_SLUG" ] && [ -f "$FEATURE_JSON" ]; then
    _feature_dir=$(grep -E '"feature_directory"[[:space:]]*:' "$FEATURE_JSON" \
        | head -1 \
        | sed -E 's/.*"feature_directory"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    FEATURE_SLUG="${_feature_dir#specs/}"
    FEATURE_SLUG="${FEATURE_SLUG%/}"
fi

if [ -f "$FEATURE_JSON" ]; then
    SOURCE_ISSUE=$(grep -E '"source_issue"[[:space:]]*:' "$FEATURE_JSON" 2>/dev/null \
        | head -1 \
        | sed -E 's/.*"source_issue"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/')
fi

if [ -z "$FEATURE_SLUG" ]; then
    echo "[archive] feature slug not provided and .specify/feature.json missing feature_directory" >&2
    exit 1
fi

SRC="specs/$FEATURE_SLUG"
case "$FEATURE_SLUG" in
    archive/*)
        echo "[archive] $SRC is already under specs/archive/" >&2
        exit 1
        ;;
esac

[ -d "$SRC" ] || { echo "[archive] source $SRC does not exist" >&2; exit 1; }

# Readiness check: no unchecked tasks
TASKS_FILE="$SRC/tasks.md"
if [ -f "$TASKS_FILE" ]; then
    if grep -qE '^- \[ \]' "$TASKS_FILE"; then
        if [ "$FORCE" = "1" ]; then
            _open_count=$(grep -cE '^- \[ \]' "$TASKS_FILE")
            echo "[archive] --force: archiving despite $_open_count unchecked tasks in $TASKS_FILE" >&2
        else
            echo "[archive] refusing to archive: $TASKS_FILE has unchecked tasks (use --force to override):" >&2
            grep -nE '^- \[ \]' "$TASKS_FILE" >&2
            # Exit 2 signals "unchecked tasks" specifically, so the command layer
            # can distinguish this from other failures and prompt the user.
            exit 2
        fi
    fi
fi

DATE=$(date +%Y-%m-%d)
DEST="specs/archive/${DATE}-${FEATURE_SLUG}"

[ ! -e "$DEST" ] || { echo "[archive] destination $DEST already exists" >&2; exit 1; }

# Derive feature title from spec.md H1 for changelog entry
TITLE="$FEATURE_SLUG"
if [ -f "$SRC/spec.md" ]; then
    _t=$(grep -m1 -E '^#[[:space:]]*Feature Specification:' "$SRC/spec.md" \
        | sed -E 's/^#[[:space:]]*Feature Specification:[[:space:]]*//')
    [ -n "$_t" ] && TITLE="$_t"
fi

# Update or create CHANGELOG.md (Keep a Changelog style, "Changed" group).
# Detect existing changelog file: prefer CHANGELOG.md, fall back to CHANGES.md if that's what the repo already uses.
if [ -f "$REPO_ROOT/CHANGELOG.md" ]; then
    CHANGES="$REPO_ROOT/CHANGELOG.md"
elif [ -f "$REPO_ROOT/CHANGES.md" ]; then
    CHANGES="$REPO_ROOT/CHANGES.md"
else
    CHANGES="$REPO_ROOT/CHANGELOG.md"
fi
SECTION="Changed"
ENTRY="- ${TITLE} — archived to \`${DEST}/\`"
[ -n "$SOURCE_ISSUE" ] && ENTRY="$ENTRY (closes #${SOURCE_ISSUE})"

if [ ! -f "$CHANGES" ]; then
    cat > "$CHANGES" <<EOF
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## ${DATE}

### ${SECTION}

${ENTRY}
EOF
    echo "[archive] created $(basename "$CHANGES")"
elif grep -qE "^## ${DATE}\$" "$CHANGES"; then
    # Date section exists. Insert entry under its "### Changed" subsection,
    # creating that subsection if it does not yet exist within the date block.
    awk -v date="## ${DATE}" -v section="### ${SECTION}" -v entry="$ENTRY" '
        BEGIN { in_date=0; in_section=0; inserted=0 }
        {
            if ($0 == date) { in_date=1; print; next }
            if (in_date && /^## / && $0 != date) {
                if (!inserted) {
                    print section; print ""; print entry; print ""
                    inserted=1
                }
                in_date=0; in_section=0
            }
            if (in_date && $0 == section) { in_section=1; print; print ""; print entry; inserted=1; in_section=0; in_date=0; next }
            print
        }
        END {
            if (in_date && !inserted) {
                print ""; print section; print ""; print entry
            }
        }
    ' "$CHANGES" > "$CHANGES.tmp" && mv "$CHANGES.tmp" "$CHANGES"
    echo "[archive] appended entry under ${DATE} > ${SECTION}"
else
    # Insert a new dated section + Changed subsection after the top header block
    awk -v date="## ${DATE}" -v section="### ${SECTION}" -v entry="$ENTRY" '
        BEGIN { inserted = 0 }
        /^## / && !inserted {
            print date; print ""
            print section; print ""
            print entry; print ""
            inserted = 1
        }
        { print }
        END {
            if (!inserted) {
                print ""
                print date; print ""
                print section; print ""
                print entry
            }
        }
    ' "$CHANGES" > "$CHANGES.tmp" && mv "$CHANGES.tmp" "$CHANGES"
    echo "[archive] inserted new ${DATE} section"
fi

git add "$CHANGES"

# Ensure parent archive dir exists (git mv requires it)
mkdir -p specs/archive

# Move the planning folder
git mv "$SRC" "$DEST"
echo "[archive] git mv $SRC -> $DEST"

# Close the linked GitHub issue, if any
if [ -n "$SOURCE_ISSUE" ]; then
    if command -v gh >/dev/null 2>&1; then
        if gh issue view "$SOURCE_ISSUE" >/dev/null 2>&1; then
            gh issue close "$SOURCE_ISSUE" \
                -c "Archived in \`${DEST}/\`. See CHANGES.md (${DATE})." \
                || echo "[archive] warning: failed to close issue #${SOURCE_ISSUE}" >&2
            echo "[archive] closed issue #${SOURCE_ISSUE}"
        else
            echo "[archive] issue #${SOURCE_ISSUE} not visible to gh; skipping close" >&2
        fi
    else
        echo "[archive] gh CLI not found; skipping issue close (#${SOURCE_ISSUE})" >&2
    fi
else
    echo "[archive] no source_issue in .specify/feature.json; nothing to close"
fi

echo "[OK] archived to ${DEST}"
