---
description: "Wraps /speckit-implement to keep the agent-os dashboard branch-status card current: mark the `implement` phase active on entry, done on completion. Composes with other implement wrappers via the wrap seam."
---

## Dashboard — enter `implement`

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter implement
```

For a long implement phase, you may refresh the card mid-way so the dashboard's
"ago" label stays fresh — re-run `enter implement --summary "<k/N tasks done>"` as
progress lands. It's cheap and idempotent.

{CORE_TEMPLATE}

## Dashboard — `implement` done

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" done implement --summary "<all tasks complete / what shipped>"
```

If implementation stalls on a blocker you can't clear:
`python3 "$REPORT" block implement --reason "<reason>"`.
