---
description: "Wraps /speckit-plan to update the agent-os dashboard card"
---

## Dashboard — enter `plan`

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter plan
```

{CORE_TEMPLATE}

## Dashboard — `plan` done

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" done plan --summary "<architecture / data model / key decisions in one line>"
```

If the plan is blocked (e.g. a gate you can't clear or an open design decision):
`python3 "$REPORT" block plan --reason "<reason>"`.
