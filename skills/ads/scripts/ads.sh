#!/usr/bin/env bash
# Thin wrapper: ensures the uv-managed venv exists, then runs one of the bin/* modules.
# Usage: ads.sh <subcommand> [args...]
#   subcommands: preflight | create | keyword-ideas | report | audit | update | render-yaml | bootstrap-secrets
#   (apply-fixes is a deprecated alias for update)
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/../../../.." && pwd )"

if [ "$#" -lt 1 ]; then
  echo "usage: ads.sh <preflight|create|keyword-ideas|report|audit|update|render-yaml|bootstrap-secrets> [args...]" >&2
  exit 1
fi

cmd="$1"; shift
case "$cmd" in
  render-yaml) mod="render_yaml" ;;
  bootstrap-secrets) mod="bootstrap_secrets" ;;
  keyword-ideas) mod="keyword_ideas" ;;
  update|apply-fixes) mod="apply_fixes" ;;  # apply-fixes is a deprecated alias for update
  preflight|create|report|audit) mod="$cmd" ;;
  *) echo "unknown subcommand: $cmd" >&2; exit 1 ;;
esac

UV_BIN="${UV_BIN:-uv}"
command -v "$UV_BIN" >/dev/null 2>&1 || {
  echo "error: 'uv' not on PATH (https://github.com/astral-sh/uv). Install with: brew install uv" >&2
  exit 1
}

# Keep the venv OUTSIDE .claude/commands/ so Claude Code's skill scanner doesn't
# index every site-packages LICENSE file as a phantom "skill". Repo root keeps
# it close to the project; one venv per worktree. Add .venv-ads to .gitignore.
export UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-$REPO_ROOT/.venv-ads}"
mkdir -p "$(dirname "$UV_PROJECT_ENVIRONMENT")"

# Redirect Python bytecode caches OUT of .claude/commands/ — same reason as the
# pytest cache_dir override: skill scanner indexes everything under that tree.
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-$HOME/.cache/lead-drop/ads-skill-pycache}"
mkdir -p "$PYTHONPYCACHEPREFIX"

# Sync deps on first run (or after pyproject.toml changes). Idempotent and fast.
"$UV_BIN" sync --quiet --project "$SCRIPT_DIR"

# Run from the repo root so relative paths (ideas/, ads/output/reports) resolve.
cd "$REPO_ROOT"
exec "$UV_BIN" run --quiet --project "$SCRIPT_DIR" python -m "ads_skill.bin.$mod" "$@"
