---
description: "Wraps the review coordinator (/speckit-review-run) to drive the dashboard card's review phase and substeps live: mark review active on entry, flip each substep as its pass runs, and mark review done at the end. Composes with other review wrappers via the wrap seam."
---

## Dashboard — enter `review`

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" enter review
```

As you run each specialized review pass in the core flow, update its substep on the
card — mark it `active` when you start it and `done` when it returns. The substep
keys are exactly `code arch comments tests errors types simplify` (plus `pr`, which
tracks the draft PR opening rather than a review pass):

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" substep code=active     # when the code pass starts
bun "$REPORT" substep code=done       # when it returns
# ...and likewise for arch, comments, tests, errors, types, simplify
```

{CORE_TEMPLATE}

## Dashboard — `review` done

When every pass has run, mark the review phase done. If a pass surfaced findings you
fixed, say so in the summary; if it surfaced a blocker you can't resolve, mark the
phase blocked instead.

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" substep code=done arch=done comments=done tests=done errors=done types=done simplify=done
bun "$REPORT" done review --summary "<pass/fail + what was fixed>"
# blocked instead:  bun "$REPORT" block review --reason "<what's blocking>"
```

The `pr` substep tracks the PR itself; when the PR is opened by a later
step (e.g. autopilot's draft-PR step or `/speckit-git-pr`), mark it there with
`bun "$REPORT" substep pr=done`. When all five phases read `done`, the dashboard
auto-renders the card as complete.
