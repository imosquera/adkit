#!/usr/bin/env bash
# Thin wrapper: ensures the built JS + node deps exist, then runs one of the
# dist/bin/* entrypoints (the TypeScript port of the ads_skill package).
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

# Install deps on first run (node_modules absent). Idempotent; quiet.
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  ( cd "$SCRIPT_DIR" && npm ci --silent 2>/dev/null || npm install --silent )
fi

# Build to dist/ on first run or after a source change (dist missing, or any src
# file newer than the built entrypoint).
needs_build=0
if [ ! -f "$SCRIPT_DIR/dist/bin/${mod}.js" ]; then
  needs_build=1
elif [ -n "$( find "$SCRIPT_DIR/src" -type f -newer "$SCRIPT_DIR/dist/bin/${mod}.js" -print -quit 2>/dev/null )" ]; then
  needs_build=1
fi
if [ "$needs_build" -eq 1 ]; then
  # stdout is reserved for the JSON envelope; tsup's "CLI Building entry…" banner
  # must go to stderr or it corrupts the envelope on any rebuild.
  ( cd "$SCRIPT_DIR" && npm run --silent build 1>&2 )
fi

# Run from the repo root so relative paths (ideas/, ads/output/reports) resolve,
# matching the Python wrapper's behavior.
REPO_ROOT="$( cd "${SCRIPT_DIR}/../../../.." && pwd )"
cd "$REPO_ROOT"
exec node "$SCRIPT_DIR/dist/bin/${mod}.js" "$@"
