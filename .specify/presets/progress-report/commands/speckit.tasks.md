---
description: "Wraps /speckit-tasks to keep the agent-os dashboard branch-status card current: mark the `tasks` phase active on entry, done on completion. Composes with other tasks wrappers via the wrap seam."
---

## Dashboard — enter `tasks`

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter tasks
```

{CORE_TEMPLATE}

## Dashboard — `tasks` done

Mark the phase done and attach the generated task list as items (id `T001`… + title;
all `pending` since none have run yet). This same list is what `implement` will flip
to `done` task-by-task, so it's the backbone of the card's detail view:

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" done tasks \
  --summary "<N tasks generated across M workstreams>" \
  --items-json '[{"id":"T001","title":"<task text>","status":"pending"}]'
```

Build `--items-json` from the tasks you wrote to `tasks.md` (one object per task).
During implementation, re-send the same list with statuses flipped to `done`/`active`
via `python3 "$REPORT" set implement --items-json '[…]'` so the card tracks progress
without changing phase statuses.

If task generation is blocked: `python3 "$REPORT" block tasks --reason "<reason>"`.
