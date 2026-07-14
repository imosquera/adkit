---
description: "Wraps /speckit-specify to keep the agent-os dashboard branch-status card current: mark the `specify` phase active on entry, done on completion. Composes with other specify wrappers via the wrap seam."
---

## Dashboard — enter `specify`

Before the core flow, mark this phase active on the branch-status card. This is a
no-op when the dashboard repo isn't present, so it never blocks the run:

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter specify
```

{CORE_TEMPLATE}

## Dashboard — `specify` done

After the spec is written, mark it done with a one-line summary **and** attach the
user stories as the phase's item list — these are what the dashboard shows when
someone expands the `specify` phase, and they carry forward to later phases, so it's
worth grounding them in the actual spec. `--items-json` takes a JSON array of
`{id, title, status}` objects (id like `US1`; status `done|active|pending|blocked`):

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" done specify \
  --summary "<N requirements captured, M clarifications resolved>" \
  --description "<one-paragraph shape of the feature, optional>" \
  --items-json '[{"id":"US1","title":"As a <role>, I can <capability>","status":"done"}]'
```

Build the `--items-json` array from the user stories you actually wrote to `spec.md`
(one object per story). Omit `--items-json` if the spec has no discrete stories.

If specify can't complete (e.g. an irreducibly ambiguous ask), mark the blocker
instead so the card shows why: `python3 "$REPORT" block specify --reason "<reason>"`.
