# progress-report preset

Maintains a live **branch-status card** per branch in an agent-os dashboard repo as
a feature moves through the SpecKit cycle (specify → plan → tasks → implement →
review). The card is `<dashboard>/branches/<branch-slug>.md`; the dashboard's Astro
site renders it in the "Active branches" panel.

It works by **wrapping** the five cycle commands (`strategy: wrap`), so the card
updates whether **autopilot or a human** drives the cycle — both invoke the same
`/speckit-*` commands. Because it wraps (not replaces), it composes with the other
presets that touch these commands (`spec-minimal`, `constitution-audit`,
`graphify-on-implement`, …).

### Companion `progress` extension (install both)

A `wrap` loses to a `replaces`: when another preset **replaces** the `/speckit-tasks`
or `/speckit-implement` body (e.g. `explicit-task-dependencies`, `constitution-audit`),
this preset's wrap on those two phases is clobbered and they stop updating the card.
Presets can't declare lifecycle hooks to work around it — only extensions can — so the
sibling **`progress` extension** supplies `before_tasks` / `before_implement` hooks that
mark those two phases active regardless of who owns the command body. The extension
ships no writer of its own; its commands resolve *this preset's* `progress_report.py`
and no-op if it's absent. Install the two together for full, clobber-immune coverage;
the preset alone still covers specify/plan/review and any project without a
replace-strategy preset.

## Configuration

- **Dashboard path** — default `~/Code/agent-os`, overridable with the
  `AGENT_OS_DASHBOARD` env var (or `--dashboard` on the script). If
  `<dashboard>/branches/` doesn't exist, every write is a quiet no-op — progress
  reporting never breaks the pipeline it observes.
- **Branch → file** — the current git branch with `/` → `-`
  (`feature/lead-scoring` → `branches/feature-lead-scoring.md`).

## The card

Frontmatter + one-line note, rewritten in full on every transition (never patched):

- `branch` (real git branch), `title`, `spec`, `updated` (bumped to now every write).
- `phases`: `specify plan tasks implement review`, each `done | active | pending |
  blocked`. The running phase is `active`; everything before it `done`, after it
  `pending`. A blocker sets that phase `blocked` with the reason in its `summary` and
  the trailing note.
- `review.substeps`: `code comments tests errors types simplify pr` (the review
  extension's passes), each updated as it runs.

A reference template lives at `<dashboard>/branches/_TEMPLATE.md` (files starting
with `_` are ignored by the dashboard).

## The writer

`scripts/python/progress_report.py` is the single deterministic writer (stdlib-only).
The command wrappers just call it at each transition:

```bash
progress_report.py enter <phase> [--summary S]     # phase active; priors done; laters pending
progress_report.py done  <phase> [--summary S]     # phase done (+ priors done)
progress_report.py block <phase> --reason R        # phase blocked; reason -> summary + note
progress_report.py substep k=v [k=v ...]           # review substeps (review -> active)
progress_report.py done-all                        # all five phases done
```

It reads the existing card first (tolerant parser, no PyYAML needed) so earlier
phases' summaries are preserved across rewrites, then emits the exact schema.

## Install

```bash
specify preset add --dev /path/to/speckit-squads/presets/progress-report
# or, for the whole repo:  /path/to/speckit-squads/install.sh <project>
```
