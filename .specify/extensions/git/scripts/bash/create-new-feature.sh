#!/usr/bin/env bash
# Git extension: create-new-feature.sh
# Adapted from core scripts/bash/create-new-feature.sh for extension layout.
# Sources common.sh from the project's installed scripts, falling back to
# git-common.sh for minimal git helpers.

set -e

JSON_MODE=false
DRY_RUN=false
ALLOW_EXISTING=false
SHORT_NAME=""
BRANCH_NUMBER=""
USE_TIMESTAMP=false
ARGS=()
i=1
while [ $i -le $# ]; do
    arg="${!i}"
    case "$arg" in
        --json)
            JSON_MODE=true
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        --allow-existing-branch)
            ALLOW_EXISTING=true
            ;;
        --short-name)
            if [ $((i + 1)) -gt $# ]; then
                echo 'Error: --short-name requires a value' >&2
                exit 1
            fi
            i=$((i + 1))
            next_arg="${!i}"
            if [[ "$next_arg" == --* ]]; then
                echo 'Error: --short-name requires a value' >&2
                exit 1
            fi
            SHORT_NAME="$next_arg"
            ;;
        --number)
            if [ $((i + 1)) -gt $# ]; then
                echo 'Error: --number requires a value' >&2
                exit 1
            fi
            i=$((i + 1))
            next_arg="${!i}"
            if [[ "$next_arg" == --* ]]; then
                echo 'Error: --number requires a value' >&2
                exit 1
            fi
            BRANCH_NUMBER="$next_arg"
            if [[ ! "$BRANCH_NUMBER" =~ ^[0-9]+$ ]]; then
                echo 'Error: --number must be a non-negative integer' >&2
                exit 1
            fi
            ;;
        --timestamp)
            USE_TIMESTAMP=true
            ;;
        --help|-h)
            echo "Usage: $0 [--json] [--dry-run] [--allow-existing-branch] [--short-name <name>] [--number N] [--timestamp] <feature_description>"
            echo ""
            echo "Options:"
            echo "  --json              Output in JSON format"
            echo "  --dry-run           Compute branch name without creating the branch"
            echo "  --allow-existing-branch  Switch to branch if it already exists instead of failing"
            echo "  --short-name <name> Provide a custom short name (2-4 words) for the branch"
            echo "  --number N          Specify branch number manually (overrides auto-detection)"
            echo "  --timestamp         Use timestamp prefix (YYYYMMDD-HHMMSS) instead of sequential numbering"
            echo "  --help, -h          Show this help message"
            echo ""
            echo "Environment variables:"
            echo "  GIT_BRANCH_NAME     Use this exact branch name, bypassing all prefix/suffix generation"
            echo ""
            echo "Examples:"
            echo "  $0 'Add user authentication system' --short-name 'user-auth'"
            echo "  $0 'Implement OAuth2 integration for API' --number 5"
            echo "  $0 --timestamp --short-name 'user-auth' 'Add user authentication'"
            echo "  GIT_BRANCH_NAME=my-branch $0 'feature description'"
            exit 0
            ;;
        *)
            ARGS+=("$arg")
            ;;
    esac
    i=$((i + 1))
done

FEATURE_DESCRIPTION="${ARGS[*]}"
if [ -z "$FEATURE_DESCRIPTION" ]; then
    echo "Usage: $0 [--json] [--dry-run] [--allow-existing-branch] [--short-name <name>] [--number N] [--timestamp] <feature_description>" >&2
    exit 1
fi

# Trim whitespace and validate description is not empty
FEATURE_DESCRIPTION=$(echo "$FEATURE_DESCRIPTION" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
if [ -z "$FEATURE_DESCRIPTION" ]; then
    echo "Error: Feature description cannot be empty or contain only whitespace" >&2
    exit 1
fi

# Function to get highest number from specs directory
get_highest_from_specs() {
    local specs_dir="$1"
    local highest=0

    if [ -d "$specs_dir" ]; then
        for dir in "$specs_dir"/*; do
            [ -d "$dir" ] || continue
            dirname=$(basename "$dir")
            # Match sequential prefixes (>=3 digits), but skip timestamp dirs.
            if echo "$dirname" | grep -Eq '^[0-9]{3,}-' && ! echo "$dirname" | grep -Eq '^[0-9]{8}-[0-9]{6}-'; then
                number=$(echo "$dirname" | grep -Eo '^[0-9]+')
                number=$((10#$number))
                if [ "$number" -gt "$highest" ]; then
                    highest=$number
                fi
            fi
        done
    fi

    echo "$highest"
}

# Function to get highest number from git branches
get_highest_from_branches() {
    git branch -a 2>/dev/null | sed 's/^[* ]*//; s|^remotes/[^/]*/||' | _extract_highest_number
}

# Extract the highest sequential feature number from a list of ref names (one per line).
_extract_highest_number() {
    local highest=0
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        if echo "$name" | grep -Eq '^[0-9]{3,}-' && ! echo "$name" | grep -Eq '^[0-9]{8}-[0-9]{6}-'; then
            number=$(echo "$name" | grep -Eo '^[0-9]+' || echo "0")
            number=$((10#$number))
            if [ "$number" -gt "$highest" ]; then
                highest=$number
            fi
        fi
    done
    echo "$highest"
}

# Function to get highest number from remote branches without fetching (side-effect-free)
get_highest_from_remote_refs() {
    local highest=0

    for remote in $(git remote 2>/dev/null); do
        local remote_highest
        remote_highest=$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$remote" 2>/dev/null | sed 's|.*refs/heads/||' | _extract_highest_number)
        if [ "$remote_highest" -gt "$highest" ]; then
            highest=$remote_highest
        fi
    done

    echo "$highest"
}

# Function to check existing branches and return next available number.
check_existing_branches() {
    local specs_dir="$1"
    local skip_fetch="${2:-false}"

    if [ "$skip_fetch" = true ]; then
        local highest_remote=$(get_highest_from_remote_refs)
        local highest_branch=$(get_highest_from_branches)
        if [ "$highest_remote" -gt "$highest_branch" ]; then
            highest_branch=$highest_remote
        fi
    else
        git fetch --all --prune >/dev/null 2>&1 || true
        local highest_branch=$(get_highest_from_branches)
    fi

    local highest_spec=$(get_highest_from_specs "$specs_dir")

    local max_num=$highest_branch
    if [ "$highest_spec" -gt "$max_num" ]; then
        max_num=$highest_spec
    fi

    echo $((max_num + 1))
}

# Function to clean and format a branch name
clean_branch_name() {
    local name="$1"
    echo "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/-\+/-/g' | sed 's/^-//' | sed 's/-$//'
}

# ---------------------------------------------------------------------------
# Source common.sh for resolve_template, json_escape, get_repo_root, has_git.
#
# Search locations in priority order:
#  1. .specify/scripts/bash/common.sh under the project root (installed project)
#  2. scripts/bash/common.sh under the project root (source checkout fallback)
#  3. git-common.sh next to this script (minimal fallback — lacks resolve_template)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find project root by walking up from the script location
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

_common_loaded=false
_PROJECT_ROOT=$(_find_project_root "$SCRIPT_DIR") || true

if [ -n "$_PROJECT_ROOT" ] && [ -f "$_PROJECT_ROOT/.specify/scripts/bash/common.sh" ]; then
    source "$_PROJECT_ROOT/.specify/scripts/bash/common.sh"
    _common_loaded=true
elif [ -n "$_PROJECT_ROOT" ] && [ -f "$_PROJECT_ROOT/scripts/bash/common.sh" ]; then
    source "$_PROJECT_ROOT/scripts/bash/common.sh"
    _common_loaded=true
elif [ -f "$SCRIPT_DIR/git-common.sh" ]; then
    source "$SCRIPT_DIR/git-common.sh"
    _common_loaded=true
fi

if [ "$_common_loaded" != "true" ]; then
    echo "Error: Could not locate common.sh or git-common.sh. Please ensure the Specify core scripts are installed." >&2
    exit 1
fi

# Resolve repository root
if type get_repo_root >/dev/null 2>&1; then
    REPO_ROOT=$(get_repo_root)
elif git rev-parse --show-toplevel >/dev/null 2>&1; then
    REPO_ROOT=$(git rev-parse --show-toplevel)
elif [ -n "$_PROJECT_ROOT" ]; then
    REPO_ROOT="$_PROJECT_ROOT"
else
    echo "Error: Could not determine repository root." >&2
    exit 1
fi

# Check if git is available at this repo root
if type has_git >/dev/null 2>&1; then
    if has_git "$REPO_ROOT"; then
        HAS_GIT=true
    else
        HAS_GIT=false
    fi
elif git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    HAS_GIT=true
else
    HAS_GIT=false
fi

cd "$REPO_ROOT"

SPECS_DIR="$REPO_ROOT/specs"

# ---------------------------------------------------------------------------
# Auto-detect branch_numbering = timestamp from configuration when --timestamp
# was not explicitly passed. Lookup order:
#   1. .specify/extensions/git/git-config.yml (yaml: branch_numbering: ...)
#   2. .specify/init-options.json (json: { "branch_numbering": "..." })
# Defaults to sequential (USE_TIMESTAMP=false) when neither exists.
# ---------------------------------------------------------------------------
if [ "$USE_TIMESTAMP" != true ] && [ -z "${GIT_BRANCH_NAME:-}" ]; then
    _branch_numbering=""
    _cfg_yaml="$REPO_ROOT/.specify/extensions/git/git-config.yml"
    _cfg_json="$REPO_ROOT/.specify/init-options.json"

    if [ -f "$_cfg_yaml" ]; then
        _branch_numbering=$(grep -E '^[[:space:]]*branch_numbering:' "$_cfg_yaml" 2>/dev/null \
            | head -1 \
            | sed -E 's/^[[:space:]]*branch_numbering:[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' \
            | tr '[:upper:]' '[:lower:]')
    fi

    if [ -z "$_branch_numbering" ] && [ -f "$_cfg_json" ]; then
        if command -v jq >/dev/null 2>&1; then
            _branch_numbering=$(jq -r '.branch_numbering // ""' "$_cfg_json" 2>/dev/null \
                | tr '[:upper:]' '[:lower:]')
        else
            _branch_numbering=$(grep -Eo '"branch_numbering"[[:space:]]*:[[:space:]]*"[^"]*"' "$_cfg_json" 2>/dev/null \
                | head -1 \
                | sed -E 's/.*"branch_numbering"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' \
                | tr '[:upper:]' '[:lower:]')
        fi
    fi

    if [ "$_branch_numbering" = "timestamp" ]; then
        USE_TIMESTAMP=true
    fi
fi

# Function to generate branch name with stop word filtering
generate_branch_name() {
    local description="$1"

    local stop_words="^(i|a|an|the|to|for|of|in|on|at|by|with|from|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|should|could|can|may|might|must|shall|this|that|these|those|my|your|our|their|want|need|add|get|set)$"

    local clean_name=$(echo "$description" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/ /g')

    local meaningful_words=()
    for word in $clean_name; do
        [ -z "$word" ] && continue
        if ! echo "$word" | grep -qiE "$stop_words"; then
            if [ ${#word} -ge 3 ]; then
                meaningful_words+=("$word")
            elif echo "$description" | grep -qw -- "${word^^}"; then
                meaningful_words+=("$word")
            fi
        fi
    done

    if [ ${#meaningful_words[@]} -gt 0 ]; then
        local max_words=3
        if [ ${#meaningful_words[@]} -eq 4 ]; then max_words=4; fi

        local result=""
        local count=0
        for word in "${meaningful_words[@]}"; do
            if [ $count -ge $max_words ]; then break; fi
            if [ -n "$result" ]; then result="$result-"; fi
            result="$result$word"
            count=$((count + 1))
        done
        echo "$result"
    else
        local cleaned=$(clean_branch_name "$description")
        echo "$cleaned" | tr '-' '\n' | grep -v '^$' | head -3 | tr '\n' '-' | sed 's/-$//'
    fi
}

# Check for GIT_BRANCH_NAME env var override (exact branch name, no prefix/suffix)
if [ -n "${GIT_BRANCH_NAME:-}" ]; then
    BRANCH_NAME="$GIT_BRANCH_NAME"
    # Extract FEATURE_NUM from the branch name if it starts with a numeric prefix
    # Check timestamp pattern first (YYYYMMDD-HHMMSS-) since it also matches the simpler ^[0-9]+ pattern
    if echo "$BRANCH_NAME" | grep -Eq '^[0-9]{8}-[0-9]{6}-'; then
        FEATURE_NUM=$(echo "$BRANCH_NAME" | grep -Eo '^[0-9]{8}-[0-9]{6}')
        BRANCH_SUFFIX="${BRANCH_NAME#${FEATURE_NUM}-}"
    elif echo "$BRANCH_NAME" | grep -Eq '^[0-9]+-'; then
        FEATURE_NUM=$(echo "$BRANCH_NAME" | grep -Eo '^[0-9]+')
        BRANCH_SUFFIX="${BRANCH_NAME#${FEATURE_NUM}-}"
    else
        FEATURE_NUM="$BRANCH_NAME"
        BRANCH_SUFFIX="$BRANCH_NAME"
    fi
else
    # Generate branch name
    if [ -n "$SHORT_NAME" ]; then
        BRANCH_SUFFIX=$(clean_branch_name "$SHORT_NAME")
    else
        BRANCH_SUFFIX=$(generate_branch_name "$FEATURE_DESCRIPTION")
    fi

    # Warn if --number and --timestamp are both specified
    if [ "$USE_TIMESTAMP" = true ] && [ -n "$BRANCH_NUMBER" ]; then
        >&2 echo "[specify] Warning: --number is ignored when --timestamp is used"
        BRANCH_NUMBER=""
    fi

    # ---------------------------------------------------------------------
    # GitHub issue creation drives FEATURE_NUM. `gh` is REQUIRED.
    #
    # We create a stub issue *before* branch numbering and use the
    # resulting issue number as FEATURE_NUM. This keeps the spec
    # directory, branch name, and tracking issue all aligned on one
    # identifier (e.g. specs/008-user-auth/, branch 008-user-auth, issue #8).
    #
    # Bypassed only when the caller has explicitly opted out of
    # issue-driven numbering:
    #   - GIT_BRANCH_NAME is set (caller controls the branch name explicitly)
    #   - --timestamp is used (different naming scheme)
    #   - --number is passed (caller controls numbering explicitly)
    #   - --dry-run is set
    #
    # Outside those cases, a missing `gh`, an unauthenticated session, or a
    # failing `gh issue create` is a hard error.
    # ---------------------------------------------------------------------
    SOURCE_ISSUE=""
    ISSUE_URL=""
    if [ "$USE_TIMESTAMP" != true ] \
       && [ -z "$BRANCH_NUMBER" ] \
       && [ "$DRY_RUN" != true ] \
       && [ "$HAS_GIT" = true ]; then

        if ! command -v gh >/dev/null 2>&1; then
            >&2 echo "[specify] Error: \`gh\` is required for /speckit-git-feature but is not installed."
            >&2 echo "[specify]   Install GitHub CLI from https://cli.github.com/ and run \`gh auth login\`,"
            >&2 echo "[specify]   or pass --timestamp / --number / GIT_BRANCH_NAME to bypass issue creation."
            exit 1
        fi

        if ! gh auth status >/dev/null 2>&1; then
            >&2 echo "[specify] Error: \`gh\` is installed but not authenticated."
            >&2 echo "[specify]   Run \`gh auth login\`,"
            >&2 echo "[specify]   or pass --timestamp / --number / GIT_BRANCH_NAME to bypass issue creation."
            exit 1
        fi

        _issue_body="Tracking issue for feature: ${FEATURE_DESCRIPTION}

Stub created by \`/speckit-git-feature\`. The full spec body will be filled in by \`/speckit-specify\`."

        _issue_out=""
        if ! _issue_out=$(gh issue create --title "$FEATURE_DESCRIPTION" --body "$_issue_body" 2>&1); then
            >&2 echo "[specify] Error: \`gh issue create\` failed:"
            >&2 printf '%s\n' "$_issue_out" | sed 's/^/[specify]   /'
            exit 1
        fi

        ISSUE_URL=$(printf '%s\n' "$_issue_out" | grep -Eo 'https?://[^[:space:]]+/issues/[0-9]+' | head -1)
        if [ -n "$ISSUE_URL" ]; then
            SOURCE_ISSUE=$(printf '%s' "$ISSUE_URL" | grep -Eo '[0-9]+$')
        fi

        if [ -z "$SOURCE_ISSUE" ]; then
            >&2 echo "[specify] Error: created issue but could not parse number from gh output:"
            >&2 printf '%s\n' "$_issue_out" | sed 's/^/[specify]   /'
            exit 1
        fi

        >&2 echo "[specify] Created GitHub issue #${SOURCE_ISSUE}: ${ISSUE_URL}"

        # Compare the newly-created issue number with the next-free spec/branch
        # number. When the GitHub issue counter is behind existing specs/NNN-*
        # directories or branches (common when enabling this integration on an
        # existing project), using the raw issue number would either reuse a
        # taken slot or fail later on an existing branch — leaving the issue
        # orphaned. Pick the larger of the two so FEATURE_NUM is always free.
        if [ "$HAS_GIT" = true ]; then
            _next_free=$(check_existing_branches "$SPECS_DIR")
        else
            _highest=$(get_highest_from_specs "$SPECS_DIR")
            _next_free=$((_highest + 1))
        fi

        if [ "$((10#$SOURCE_ISSUE))" -lt "$((10#$_next_free))" ]; then
            >&2 echo "[specify] Issue #${SOURCE_ISSUE} is behind next free spec number ${_next_free}; using ${_next_free} for FEATURE_NUM (issue title will be updated to match)."
            BRANCH_NUMBER="$_next_free"
        else
            BRANCH_NUMBER="$SOURCE_ISSUE"
        fi
    fi

    # Determine branch prefix
    if [ "$USE_TIMESTAMP" = true ]; then
        FEATURE_NUM=$(date +%Y%m%d-%H%M%S)
        BRANCH_NAME="${FEATURE_NUM}-${BRANCH_SUFFIX}"
    else
        if [ -z "$BRANCH_NUMBER" ]; then
            if [ "$DRY_RUN" = true ] && [ "$HAS_GIT" = true ]; then
                BRANCH_NUMBER=$(check_existing_branches "$SPECS_DIR" true)
            elif [ "$DRY_RUN" = true ]; then
                HIGHEST=$(get_highest_from_specs "$SPECS_DIR")
                BRANCH_NUMBER=$((HIGHEST + 1))
            elif [ "$HAS_GIT" = true ]; then
                BRANCH_NUMBER=$(check_existing_branches "$SPECS_DIR")
            else
                HIGHEST=$(get_highest_from_specs "$SPECS_DIR")
                BRANCH_NUMBER=$((HIGHEST + 1))
            fi
        fi

        FEATURE_NUM=$(printf "%03d" "$((10#$BRANCH_NUMBER))")
        BRANCH_NAME="${FEATURE_NUM}-${BRANCH_SUFFIX}"
    fi
fi

# GitHub enforces a 244-byte limit on branch names
MAX_BRANCH_LENGTH=244
_byte_length() { printf '%s' "$1" | LC_ALL=C wc -c | tr -d ' '; }
BRANCH_BYTE_LEN=$(_byte_length "$BRANCH_NAME")
if [ -n "${GIT_BRANCH_NAME:-}" ] && [ "$BRANCH_BYTE_LEN" -gt $MAX_BRANCH_LENGTH ]; then
    >&2 echo "Error: GIT_BRANCH_NAME must be 244 bytes or fewer in UTF-8. Provided value is ${BRANCH_BYTE_LEN} bytes."
    exit 1
elif [ "$BRANCH_BYTE_LEN" -gt $MAX_BRANCH_LENGTH ]; then
    PREFIX_LENGTH=$(( ${#FEATURE_NUM} + 1 ))
    MAX_SUFFIX_LENGTH=$((MAX_BRANCH_LENGTH - PREFIX_LENGTH))

    TRUNCATED_SUFFIX=$(echo "$BRANCH_SUFFIX" | cut -c1-$MAX_SUFFIX_LENGTH)
    TRUNCATED_SUFFIX=$(echo "$TRUNCATED_SUFFIX" | sed 's/-$//')

    ORIGINAL_BRANCH_NAME="$BRANCH_NAME"
    BRANCH_NAME="${FEATURE_NUM}-${TRUNCATED_SUFFIX}"

    >&2 echo "[specify] Warning: Branch name exceeded GitHub's 244-byte limit"
    >&2 echo "[specify] Original: $ORIGINAL_BRANCH_NAME (${#ORIGINAL_BRANCH_NAME} bytes)"
    >&2 echo "[specify] Truncated to: $BRANCH_NAME (${#BRANCH_NAME} bytes)"
fi

# ---------------------------------------------------------------------------
# Worktree path derivation (Constitution v2.3.0, Principle VII)
#
# Convention: worktrees for project <project> live under a collector dir
# "${parent-of-primary-checkout}/<project>.worktrees/", with one subdirectory
# per branch. So a primary checkout at /Users/iam/Code/beadbits yields
# worktrees at /Users/iam/Code/beadbits.worktrees/<branch>.
#
# The repo's basename is normalised: a trailing "-main" / "-master" / "-trunk"
# is stripped if present (so /Users/iam/Code/beadbits-main → "beadbits").
#
# Overrides:
#   SPECKIT_WORKTREE_PATH    — absolute path, takes precedence over everything.
#   SPECKIT_WORKTREE_PARENT  — absolute collector dir (worktree path becomes
#                              "$SPECKIT_WORKTREE_PARENT/<branch>").
# ---------------------------------------------------------------------------
WORKTREE_PATH=""
if [ "$HAS_GIT" = true ] && [ "$DRY_RUN" != true ]; then
    if [ -n "${SPECKIT_WORKTREE_PATH:-}" ]; then
        WORKTREE_PATH="$SPECKIT_WORKTREE_PATH"
    else
        # Resolve the *primary* checkout (the worktree git considers main) so
        # the naming convention stays stable even when this script is invoked
        # from inside another worktree. `git worktree list --porcelain` lists
        # the primary first.
        _primary_root="$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
        if [ -z "$_primary_root" ]; then
            _primary_root="$REPO_ROOT"
        fi
        _repo_base="$(basename "$_primary_root")"
        _repo_base_stripped="$(echo "$_repo_base" | sed -E 's/-(main|master|trunk)$//')"
        # Collector convention: all feature worktrees for this project live in
        # "<parent-of-primary-checkout>/<project>.worktrees/<branch>". This keeps
        # the parent directory tidy and groups every worktree under one folder
        # named after the project. SPECKIT_WORKTREE_PARENT overrides the
        # collector dir; SPECKIT_WORKTREE_PATH (handled above) overrides
        # everything.
        if [ -n "${SPECKIT_WORKTREE_PARENT:-}" ]; then
            _worktree_parent="$SPECKIT_WORKTREE_PARENT"
        else
            _worktree_parent="$(dirname "$_primary_root")/${_repo_base_stripped}.worktrees"
        fi
        mkdir -p "$_worktree_parent"
        WORKTREE_PATH="${_worktree_parent}/${BRANCH_NAME}"
    fi
fi

if [ "$DRY_RUN" != true ]; then
    if [ "$HAS_GIT" = true ]; then
        # Per Constitution v2.3.0, the primary checkout MUST NOT be switched to
        # the new feature branch. We create the branch with `git branch` (no
        # checkout) and immediately materialise a dedicated worktree at it.
        branch_create_error=""
        if ! branch_create_error=$(git branch "$BRANCH_NAME" 2>&1); then
            if git branch --list "$BRANCH_NAME" | grep -q .; then
                if [ "$ALLOW_EXISTING" != true ]; then
                    if [ "$USE_TIMESTAMP" = true ]; then
                        >&2 echo "Error: Branch '$BRANCH_NAME' already exists. Rerun to get a new timestamp or use a different --short-name."
                        exit 1
                    else
                        >&2 echo "Error: Branch '$BRANCH_NAME' already exists. Please use a different feature name or specify a different number with --number."
                        exit 1
                    fi
                fi
                # ALLOW_EXISTING=true: branch already exists. Fall through to worktree setup.
            else
                >&2 echo "Error: Failed to create git branch '$BRANCH_NAME'."
                if [ -n "$branch_create_error" ]; then
                    >&2 printf '%s\n' "$branch_create_error"
                else
                    >&2 echo "Please check your git configuration and try again."
                fi
                exit 1
            fi
        fi

        # Worktree creation. Idempotent if the worktree already exists at the
        # expected path with the expected branch; any other path collision is
        # an error the caller must resolve.
        if git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch refs\/heads\//{b=$2; print p, b}' | grep -Fq "$WORKTREE_PATH refs/heads/$BRANCH_NAME"; then
            : # already exists at the expected path with the expected branch
        elif [ -e "$WORKTREE_PATH" ]; then
            >&2 echo "Error: Worktree target path '$WORKTREE_PATH' already exists and is not the expected worktree."
            >&2 echo "       Resolve the collision (rm/mv the path, or pass SPECKIT_WORKTREE_PATH) and retry."
            exit 1
        else
            worktree_error=""
            if ! worktree_error=$(git worktree add "$WORKTREE_PATH" "$BRANCH_NAME" 2>&1); then
                >&2 echo "Error: Failed to create worktree at '$WORKTREE_PATH' for branch '$BRANCH_NAME'."
                if [ -n "$worktree_error" ]; then
                    >&2 printf '%s\n' "$worktree_error"
                fi
                exit 1
            fi
        fi
    else
        >&2 echo "[specify] Warning: Git repository not detected; skipped branch + worktree creation for $BRANCH_NAME"
    fi

    # ---------------------------------------------------------------------
    # Persist source_issue into the worktree's .specify/feature.json and
    # prefix the issue title with the actual FEATURE_NUM.
    #
    # In the common case FEATURE_NUM == SOURCE_ISSUE because issue creation
    # drives numbering. They can diverge if the next free spec number was
    # already higher than the issue number (e.g. issue #5 created while
    # specs/008-* already exists), in which case we still write the issue
    # title with FEATURE_NUM so the issue ↔ spec alignment is visible.
    # ---------------------------------------------------------------------
    if [ -n "$SOURCE_ISSUE" ] && [ "$HAS_GIT" = true ] && [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then
        _wt_specify_dir="$WORKTREE_PATH/.specify"
        _wt_feature_json="$_wt_specify_dir/feature.json"
        mkdir -p "$_wt_specify_dir"

        # Write or merge feature.json. When the file already exists (e.g. the
        # previous feature committed it and it was carried into the new worktree
        # via the base branch), we OVERWRITE the four feature-identity fields
        # rather than skipping — otherwise the worktree keeps the stale
        # source_issue/feature_directory and downstream commands (PR, archive,
        # clean, auto-commit) would close or operate on the previous feature's
        # tracking artefacts.
        if command -v jq >/dev/null 2>&1; then
            if [ -f "$_wt_feature_json" ]; then
                _tmp_json="${_wt_feature_json}.tmp.$$"
                if jq \
                    --arg branch_name "$BRANCH_NAME" \
                    --arg feature_num "$FEATURE_NUM" \
                    --arg worktree_path "$WORKTREE_PATH" \
                    --argjson source_issue "$SOURCE_ISSUE" \
                    '. + {branch_name:$branch_name,feature_num:$feature_num,worktree_path:$worktree_path,source_issue:$source_issue} | del(.feature_directory)' \
                    "$_wt_feature_json" > "$_tmp_json"; then
                    mv "$_tmp_json" "$_wt_feature_json"
                    >&2 echo "[specify] Updated stale .specify/feature.json in worktree with new feature identity (source_issue=${SOURCE_ISSUE})."
                else
                    rm -f "$_tmp_json"
                    >&2 echo "[specify] Warning: failed to merge .specify/feature.json; overwriting with new feature identity."
                    jq -n \
                        --arg branch_name "$BRANCH_NAME" \
                        --arg feature_num "$FEATURE_NUM" \
                        --arg worktree_path "$WORKTREE_PATH" \
                        --argjson source_issue "$SOURCE_ISSUE" \
                        '{branch_name:$branch_name,feature_num:$feature_num,worktree_path:$worktree_path,source_issue:$source_issue}' \
                        > "$_wt_feature_json"
                fi
            else
                jq -n \
                    --arg branch_name "$BRANCH_NAME" \
                    --arg feature_num "$FEATURE_NUM" \
                    --arg worktree_path "$WORKTREE_PATH" \
                    --argjson source_issue "$SOURCE_ISSUE" \
                    '{branch_name:$branch_name,feature_num:$feature_num,worktree_path:$worktree_path,source_issue:$source_issue}' \
                    > "$_wt_feature_json"
            fi
        else
            # No jq → write minimal JSON, overwriting any prior content. This
            # loses non-identity fields the previous owner may have stashed,
            # but keeping stale identity fields is the worse failure mode.
            if type json_escape >/dev/null 2>&1; then
                _je_branch=$(json_escape "$BRANCH_NAME")
                _je_num=$(json_escape "$FEATURE_NUM")
                _je_wt=$(json_escape "$WORKTREE_PATH")
            else
                _je_branch="$BRANCH_NAME"
                _je_num="$FEATURE_NUM"
                _je_wt="$WORKTREE_PATH"
            fi
            if [ -f "$_wt_feature_json" ]; then
                >&2 echo "[specify] Warning: jq not installed; overwriting stale .specify/feature.json (non-identity fields will be lost)."
            fi
            printf '{"branch_name":"%s","feature_num":"%s","worktree_path":"%s","source_issue":%s}\n' \
                "$_je_branch" "$_je_num" "$_je_wt" "$SOURCE_ISSUE" \
                > "$_wt_feature_json"
        fi

        # Prefix the issue title with the spec number so the issue list
        # mirrors the specs/ layout. Best-effort; failures are non-fatal.
        if command -v gh >/dev/null 2>&1; then
            _new_title="${FEATURE_NUM}: ${FEATURE_DESCRIPTION}"
            if ! gh issue edit "$SOURCE_ISSUE" --title "$_new_title" >/dev/null 2>&1; then
                >&2 echo "[specify] Warning: failed to prefix issue #${SOURCE_ISSUE} title with '${FEATURE_NUM}:'"
            fi
        fi
    fi

    printf '# To persist: export SPECIFY_FEATURE=%q\n' "$BRANCH_NAME" >&2
    if [ -n "$WORKTREE_PATH" ]; then
        printf '# Worktree created at: %s\n' "$WORKTREE_PATH" >&2
        printf '# NEXT STEP (Constitution v2.3.0 Principle VII): cd %q\n' "$WORKTREE_PATH" >&2
    fi
    if [ -n "$ISSUE_URL" ]; then
        printf '# Linked GitHub issue: %s\n' "$ISSUE_URL" >&2
    fi
fi

if $JSON_MODE; then
    if command -v jq >/dev/null 2>&1; then
        if [ "$DRY_RUN" = true ]; then
            jq -cn \
                --arg branch_name "$BRANCH_NAME" \
                --arg feature_num "$FEATURE_NUM" \
                '{BRANCH_NAME:$branch_name,FEATURE_NUM:$feature_num,DRY_RUN:true}'
        else
            if [ -n "$SOURCE_ISSUE" ]; then
                jq -cn \
                    --arg branch_name "$BRANCH_NAME" \
                    --arg feature_num "$FEATURE_NUM" \
                    --arg worktree_path "$WORKTREE_PATH" \
                    --argjson source_issue "$SOURCE_ISSUE" \
                    --arg issue_url "$ISSUE_URL" \
                    '{BRANCH_NAME:$branch_name,FEATURE_NUM:$feature_num,WORKTREE_PATH:$worktree_path,SOURCE_ISSUE:$source_issue,ISSUE_URL:$issue_url}'
            else
                jq -cn \
                    --arg branch_name "$BRANCH_NAME" \
                    --arg feature_num "$FEATURE_NUM" \
                    --arg worktree_path "$WORKTREE_PATH" \
                    '{BRANCH_NAME:$branch_name,FEATURE_NUM:$feature_num,WORKTREE_PATH:$worktree_path}'
            fi
        fi
    else
        if type json_escape >/dev/null 2>&1; then
            _je_branch=$(json_escape "$BRANCH_NAME")
            _je_num=$(json_escape "$FEATURE_NUM")
            _je_wt=$(json_escape "$WORKTREE_PATH")
            _je_url=$(json_escape "$ISSUE_URL")
        else
            _je_branch="$BRANCH_NAME"
            _je_num="$FEATURE_NUM"
            _je_wt="$WORKTREE_PATH"
            _je_url="$ISSUE_URL"
        fi
        if [ "$DRY_RUN" = true ]; then
            printf '{"BRANCH_NAME":"%s","FEATURE_NUM":"%s","DRY_RUN":true}\n' "$_je_branch" "$_je_num"
        elif [ -n "$SOURCE_ISSUE" ]; then
            printf '{"BRANCH_NAME":"%s","FEATURE_NUM":"%s","WORKTREE_PATH":"%s","SOURCE_ISSUE":%s,"ISSUE_URL":"%s"}\n' \
                "$_je_branch" "$_je_num" "$_je_wt" "$SOURCE_ISSUE" "$_je_url"
        else
            printf '{"BRANCH_NAME":"%s","FEATURE_NUM":"%s","WORKTREE_PATH":"%s"}\n' "$_je_branch" "$_je_num" "$_je_wt"
        fi
    fi
else
    echo "BRANCH_NAME: $BRANCH_NAME"
    echo "FEATURE_NUM: $FEATURE_NUM"
    if [ "$DRY_RUN" != true ] && [ -n "$WORKTREE_PATH" ]; then
        echo "WORKTREE_PATH: $WORKTREE_PATH"
    fi
    if [ -n "$SOURCE_ISSUE" ]; then
        echo "SOURCE_ISSUE: $SOURCE_ISSUE"
        echo "ISSUE_URL: $ISSUE_URL"
    fi
    if [ "$DRY_RUN" != true ]; then
        printf '# To persist in your shell: export SPECIFY_FEATURE=%q\n' "$BRANCH_NAME"
        if [ -n "$WORKTREE_PATH" ]; then
            printf '# NEXT STEP (Constitution v2.3.0 Principle VII): cd %q\n' "$WORKTREE_PATH"
        fi
    fi
fi
