---
description: "Wraps /speckit-tasks to update the agent-os dashboard card"
---

## Dashboard — enter `tasks`

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" enter tasks
```

{CORE_TEMPLATE}

## Dashboard — `tasks` done

Mark the phase done and attach the generated task list as items (id `T001`… + title;
all `pending` since none have run yet). This same list is what `implement` will flip
to `done` task-by-task, so it's the backbone of the card's detail view:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" done tasks \
  --summary "<N tasks generated across M workstreams>" \
  --items-json '[{"id":"T001","title":"<task text>","status":"pending"}]'
```

Build `--items-json` from the tasks you wrote to `tasks.md` (one object per task).
During implementation, re-send the same list with statuses flipped to `done`/`active`
via `bun "$REPORT" set implement --items-json '[…]'` so the card tracks progress
without changing phase statuses.

If task generation is blocked: `bun "$REPORT" block tasks --reason "<reason>"`.
