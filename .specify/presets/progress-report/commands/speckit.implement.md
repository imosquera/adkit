---
description: "Wraps /speckit-implement to update the agent-os dashboard card"
---

## Dashboard — enter `implement`

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" enter implement
```

For a long implement phase, you may refresh the card mid-way so the dashboard's
"ago" label stays fresh — re-run `enter implement --summary "<k/N tasks done>"` as
progress lands. It's cheap and idempotent.

{CORE_TEMPLATE}

## Dashboard — `implement` done

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" done implement --summary "<all tasks complete / what shipped>"
```

If implementation stalls on a blocker you can't clear:
`bun "$REPORT" block implement --reason "<reason>"`.
