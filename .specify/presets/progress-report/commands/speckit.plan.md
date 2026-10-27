---
description: "Wraps /speckit-plan to update the agent-os dashboard card"
---

## Dashboard — enter `plan`

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" enter plan
```

{CORE_TEMPLATE}

## Dashboard — `plan` done

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" done plan --summary "<architecture / data model / key decisions in one line>"
```

If the plan is blocked (e.g. a gate you can't clear or an open design decision):
`bun "$REPORT" block plan --reason "<reason>"`.
