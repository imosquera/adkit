#!/usr/bin/env bash
# spec-minimal preset: verify-minimal-tree.sh
# Post-flight verifier. FAIL the run (non-zero exit) if the feature
# directory contains anything beyond the allowed set:
#   spec.md, plan.md, tasks.md, requirements.md, quickstart.md (optional)
#
# In particular this fails if research.md, data-model.md, or contracts/
# exist in ANY form (file or directory). spec-minimal forbids those paths
# entirely — content that would have lived in them must be inlined into
# plan.md or requirements.md.
#
# This script is read-only: it NEVER creates, deletes, or modifies
# anything on disk. There are no sentinels to clean up because nothing is
# ever pre-created. It only inspects the tree and reports.
#
# Usage: verify-minimal-tree.sh <feature-dir>

set -e

FEATURE_DIR="${1:-}"
if [[ -z "$FEATURE_DIR" ]]; then
    echo "error: feature directory argument required" >&2
    exit 2
fi
if [[ ! -d "$FEATURE_DIR" ]]; then
    echo "error: not a directory: $FEATURE_DIR" >&2
    exit 2
fi

ALLOWED=(spec.md plan.md tasks.md requirements.md quickstart.md)
FORBIDDEN=(research.md data-model.md contracts)

is_allowed() {
    for a in "${ALLOWED[@]}"; do [[ "$1" == "$a" ]] && return 0; done
    return 1
}
is_forbidden() {
    for f in "${FORBIDDEN[@]}"; do [[ "$1" == "$f" ]] && return 0; done
    return 1
}

violations=()
while IFS= read -r entry; do
    name="$(basename "$entry")"
    [[ "$name" == "." || "$name" == ".." ]] && continue

    if is_forbidden "$name"; then
        violations+=("$entry (forbidden artifact — must be inlined into plan.md or requirements.md)")
        continue
    fi

    if is_allowed "$name"; then
        continue
    fi

    violations+=("$entry (not in allowed set)")
done < <(find "$FEATURE_DIR" -mindepth 1 -maxdepth 1)

if (( ${#violations[@]} > 0 )); then
    echo "FAIL: spec-minimal violations in $FEATURE_DIR" >&2
    for v in "${violations[@]}"; do echo "  - $v" >&2; done
    echo "" >&2
    echo "spec-minimal allows ONLY these top-level entries:" >&2
    for a in "${ALLOWED[@]}"; do echo "  - $a" >&2; done
    echo "Forbidden (never create, in any form): research.md, data-model.md, contracts/" >&2
    exit 1
fi

echo "ok: $FEATURE_DIR matches spec-minimal allowed set"
