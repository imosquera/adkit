#!/usr/bin/env bash
# Thin launcher: ensures node deps exist, then runs one of the src/bin/* entry
# points directly from TypeScript via tsx (no build step, no dist/).
# Usage: ads.sh <subcommand> [args...]
#   subcommands: preflight | create | keyword-ideas | report | audit | update | render-yaml | bootstrap-secrets
#   (apply-fixes is a deprecated alias for update)
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if [ "$#" -lt 1 ]; then
  echo "usage: ads.sh <preflight|create|keyword-ideas|report|audit|update|render-yaml|bootstrap-secrets> [args...]" >&2
  exit 1
fi

cmd="$1"; shift
case "$cmd" in
  update|apply-fixes) mod="apply-fixes" ;;  # apply-fixes is a deprecated alias for update
  preflight|create|keyword-ideas|report|audit|render-yaml|bootstrap-secrets) mod="$cmd" ;;
  *) echo "unknown subcommand: $cmd" >&2; exit 1 ;;
esac

command -v node >/dev/null 2>&1 || {
  echo "error: 'node' not on PATH (https://nodejs.org). Node >= 24 required." >&2
  exit 1
}

# Install deps on first run (node_modules absent). Idempotent; quiet. This is also
# what puts tsx on disk, so it must complete before the exec below.
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  ( cd "$SCRIPT_DIR" && npm ci --silent 2>/dev/null || npm install --silent )
fi

# Run from the repo root so relative paths (ideas/, ads/output/reports) resolve,
# matching the Python wrapper's behavior. tsx transpiles the .ts entry on the fly;
# stdout stays clean for the JSON envelope (tsx prints nothing on a successful run).
REPO_ROOT="$( cd "${SCRIPT_DIR}/../../../.." && pwd )"
cd "$REPO_ROOT"
exec node "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/src/bin/${mod}.ts" "$@"
