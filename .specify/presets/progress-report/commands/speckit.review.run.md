---
description: "Wraps the review coordinator (/speckit-review-run) to drive the dashboard card's review phase and substeps live: mark review active on entry, flip each substep as its pass runs, and mark review done at the end. Composes with other review wrappers via the wrap seam."
---

## Dashboard — enter `review`

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter review
```

As you run each specialized review pass in the core flow, update its substep on the
card — mark it `active` when you start it and `done` when it returns. The substep
keys are exactly `code comments tests errors types simplify` (plus `pr` for a
PR-review pass, if one runs):

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" substep code=active     # when the code pass starts
python3 "$REPORT" substep code=done       # when it returns
# ...and likewise for comments, tests, errors, types, simplify
```

{CORE_TEMPLATE}

## Dashboard — `review` done

When every pass has run, mark the review phase done. If a pass surfaced findings you
fixed, say so in the summary; if it surfaced a blocker you can't resolve, mark the
phase blocked instead.

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" substep code=done comments=done tests=done errors=done types=done simplify=done
python3 "$REPORT" done review --summary "<pass/fail + what was fixed>"
# blocked instead:  python3 "$REPORT" block review --reason "<what's blocking>"
```

The `pr` substep tracks a PR-review pass; if the PR is opened/reviewed by a later
step (e.g. autopilot's draft-PR step or `/speckit-git-pr`), mark it there with
`python3 "$REPORT" substep pr=done`. When all five phases read `done`, the dashboard
auto-renders the card as complete.
