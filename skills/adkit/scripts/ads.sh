#!/usr/bin/env bash
# Thin launcher: ensures node deps exist, then runs one of the src/bin/* entry
# points directly from TypeScript via tsx (no build step, no dist/).
# Usage: ads.sh <subcommand> [args...]
#   subcommands: preflight | create | keyword-ideas | research | report | audit | update | render-yaml | bootstrap-secrets
#   (apply-fixes is a deprecated alias for update)
set -euo pipefail

# pwd -P resolves symlinks to the physical path, matching how Node resolves a
# module's import.meta.url. The bins' run-guard (src/cli/entry.ts) now realpaths
# both sides so it's symlink-robust on its own; passing the realpath here keeps the
# two aligned anyway (defense-in-depth, and cleaner paths in diagnostics).
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"

if [ "$#" -lt 1 ]; then
  echo "usage: ads.sh <preflight|create|keyword-ideas|research|report|audit|update|render-yaml|bootstrap-secrets> [args...]" >&2
  exit 1
fi

cmd="$1"; shift
case "$cmd" in
  update|apply-fixes) mod="apply-fixes" ;;  # apply-fixes is a deprecated alias for update
  preflight|create|keyword-ideas|research|report|audit|render-yaml|bootstrap-secrets) mod="$cmd" ;;
  *) echo "unknown subcommand: $cmd" >&2; exit 1 ;;
esac

command -v node >/dev/null 2>&1 || {
  echo "error: 'node' not on PATH (https://nodejs.org). Node >= 24 required." >&2
  exit 1
}

# Install deps on first run (or after tsx was added to an older install).
# Idempotent; quiet. Keying on the tsx binary rather than the node_modules/ dir
# catches the case where deps were installed before tsx existed — otherwise the
# exec below would fail with a raw "Cannot find module".
if [ ! -x "$SCRIPT_DIR/node_modules/.bin/tsx" ]; then
  ( cd "$SCRIPT_DIR" && npm ci --silent 2>/dev/null || npm install --silent )
fi

# Run from the repo root so relative paths (ideas/, ads/output/reports) resolve,
# matching the Python wrapper's behavior. tsx transpiles the .ts entry on the fly;
# stdout stays clean for the JSON envelope (tsx prints nothing on a successful run).
# Exec the bin directly (its shebang selects node) — layout-agnostic vs `node <bin>`.
REPO_ROOT="$( cd "${SCRIPT_DIR}/../../../.." && pwd )"
cd "$REPO_ROOT"
exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/src/bin/${mod}.ts" "$@"
