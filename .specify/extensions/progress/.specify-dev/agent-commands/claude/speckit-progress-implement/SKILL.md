---
name: speckit-progress-implement
description: 'Dashboard hook target fired at before_implement: marks the `implement`
  phase active on the progress-report branch-status card. Runs via a lifecycle hook
  so it fires even when another preset REPLACES the /speckit-implement command body
  (a replace clobbers the preset''s wrap; a hook does not). Resolves the progress-report
  preset''s writer and no-ops if the preset — or the dashboard repo — isn''t present.'
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: progress:commands/implement.md
---

## Dashboard — enter `implement` (lifecycle hook)

The `before_implement` hook invoked this command, so it runs regardless of which preset
owns the `/speckit-implement` body. Its only job is to mark the `implement` phase active
on the branch-status card — the writer marks all prior phases done and later phases
pending, so this single call advances the card correctly.

The writer lives in the progress-report **preset**; this extension ships no copy of
it. Resolve it and skip cleanly if the preset isn't installed (the writer itself
already no-ops when the dashboard repo is absent, so a present writer is safe to call):

```bash
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$ROOT/.specify/presets/progress-report/scripts/python/progress_report.py"
if [ -f "$REPORT" ]; then
  python3 "$REPORT" enter implement
else
  echo "progress-report preset not installed — skipping dashboard update (not an error)"
fi
```

Do not run implementation here; the core `/speckit-implement` command does that. This
touches only the dashboard card.