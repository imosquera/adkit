# Implementation Plan: Stage campaign changes into an `adbriefs/` brief with a diff-before-apply gate

**Branch**: `026-adbriefs-stage-diff` | **Date**: 2026-07-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/026-adbriefs-stage-diff/spec.md`

## Summary

Persist one YAML brief per campaign under a new repo-root `adbriefs/` directory and gate every live Google Ads mutation behind a diff the operator sees first. The existing `Brief` zod type (`src/lib/schema.ts`) already models a campaign's full state, so it *is* the brief file format — `/adkit create` stops discarding its scaffolded brief to `$TMPDIR` and instead persists the filled brief to `adbriefs/<slug>.yaml` before publishing; `/adkit update` applies its audit-driven plan to a base brief (loaded from `adbriefs/`, or hydrated best-effort from the live read when absent) to produce a *proposed* brief, shows the current→proposed diff, and mutates live only under the existing `--apply` flag. After a successful apply, the brief is rewritten to reflect the new live state. A new pure `src/adbriefs/` module (store + diff + apply-plan-to-brief) is shared by both commands; the two `bin/*` entrypoints and the `reference/*.md` docs are the only I/O/edge changes.

## Technical Context

**Language/Version**: TypeScript on Node ≥ 24, run directly via `tsx` (no build step).

**Primary Dependencies**: existing only — `zod` (brief parse), `yaml` (serialize/parse), `google-ads-api` (live mutations). No new runtime dependency; the brief diff is a small hand-rolled line/structural diff over the YAML serialization (no diff library).

**Storage**: flat YAML files under `adbriefs/` at the repo root, one per campaign, tracked in git.

**Testing**: `vitest` (co-located `*.test.ts`), the repo's existing suite.

**Target Platform**: local CLI (`ads.sh <subcommand>`), invoked by the `/adkit` skills.

**Project Type**: single CLI package (`skills/adkit/scripts`).

**Performance Goals**: N/A (interactive CLI; a diff over one campaign's brief is trivial).

**Constraints**: preserve the JSON-envelope stdout contract; preserve dry-run-by-default / `--apply`; no live mutation before the diff is surfaced; never overwrite a different campaign's brief.

**Scale/Scope**: tens of campaigns per account; a brief is a few hundred lines of YAML.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after design.*

The project constitution at `.specify/memory/constitution.md` is an unfilled template (placeholder principle names); `constitution_audit.py validate` treats it as a no-op. The binding conventions for this repo live in `CLAUDE.md` and are honored here:

- **Functional style** (CLAUDE.md rule 1): "Isolate I/O (network, filesystem, stdout, SDK mutations) to the edges". The new `src/adbriefs/` module is pure — `slugForCampaign`, `diffBriefs`, and `applyPlanToBrief` are same-input→same-output with no fs/network; reading/writing `adbriefs/*.yaml` and calling the Ads API stay in the `bin/create.ts` / `bin/apply-fixes.ts` command shells. **PASS**
- **Immutable data** (CLAUDE.md rule 1): "never mutate a parameter". `applyPlanToBrief` returns a new `Brief` built with spread/`map`, never mutating the base brief it diffs against. **PASS**
- **Parse, don't validate** (CLAUDE.md rule 2): "Turn untrusted/loose input into a precise, well-typed value once, at the edge". The brief file is parsed once via `parseBrief` (zod) at load; downstream diff/apply/persist code operates on the typed `Brief` and does not re-check fields the boundary established. **PASS**
- **Strengthen arguments, don't weaken results** (CLAUDE.md rule 2): the diff and apply functions take a parsed `Brief` (a proof of its invariants), not a loose record, so illegal states are unrepresentable at those call sites. **PASS**
- **No classes for logic** (CLAUDE.md rule 1): no new classes are introduced; only the existing `ExitError` and third-party SDK objects remain. **PASS**

No violations; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/026-adbriefs-stage-diff/
├── spec.md
├── plan.md
├── tasks.md              # created by /speckit-tasks
└── checklists/
    └── requirements.md   # spec quality checklist
```

### Source Code (repository root)

```text
adbriefs/                     # NEW tracked dir — one brief per campaign (<slug>.yaml)
└── .gitkeep                  # keep the dir tracked when empty

skills/adkit/scripts/src/
├── adbriefs/                 # NEW pure module shared by create + update
│   ├── store.ts              # slugForCampaign, briefPathForCampaign, loadBriefIfExists,
│   │                         #   writeBrief (collision-guarded), serializeBrief  (fs at edge)
│   ├── store.test.ts
│   ├── diff.ts               # diffBriefs(current, proposed) → structured + rendered unified diff (pure)
│   ├── diff.test.ts
│   ├── apply-plan.ts         # applyPlanToBrief(base: Brief, plan) → Brief   (pure, immutable)
│   ├── apply-plan.test.ts
│   ├── hydrate.ts            # briefFromLive(read) → Brief  (best-effort base brief for update; fs/net at caller edge)
│   └── hydrate.test.ts
├── bin/
│   ├── create.ts             # persist filled brief to adbriefs/ before publish; diff vs existing brief; sync after publish
│   ├── create.test.ts
│   ├── apply-fixes.ts        # load/hydrate base brief → applyPlanToBrief → diff (dry-run) → mutate on --apply → persist
│   └── apply-fixes.test.ts
├── lib/schema.ts             # Brief type reused as the brief-file format (unchanged shape)
└── fixes/plan.ts             # existing plan validation reused; feeds applyPlanToBrief
```

**Structure Decision**: Single CLI package (`skills/adkit/scripts`). All new logic lives in a new pure `src/adbriefs/` module so `create` and `update` share one write-brief → diff → apply implementation (spec FR-011). The `Brief` schema is reused verbatim as the file format — no new schema. The only edited entrypoints are `bin/create.ts` (persist + gate) and `bin/apply-fixes.ts` (base-brief + apply-to-brief + gate + sync). `reference/create.md`, `reference/update.md`, and `reference/conventions.md` are updated to document the new flow and remove the stale "Publishes are not persisted locally" guidance.

## Parse Boundaries

TypeScript feature — enumerated per the parse-dont-validate gate.

1. **Trust boundaries**
   - **Brief YAML file** (`adbriefs/<slug>.yaml`, loose `unknown` from `yamlParse`) enters through `parseBrief` (the existing zod boundary in `lib/schema.ts`) exactly as `create.ts::readBrief` already does. Loading a persisted brief for diffing reuses this one boundary — the on-disk file is untrusted until parsed.
   - **Fixes-plan JSON** (`unknown`) enters through the existing `fixes/plan.ts::validate` / plan coercers (`coerceKeyword`, etc.) — the boundary that turns a loose plan into typed deltas. `applyPlanToBrief` consumes only already-coerced delta values, never raw JSON.
   - **Live Google Ads read rows** (`unknown` / loose `Record`) enter `adbriefs/hydrate.ts::briefFromLive`, which narrows the read into a schema-valid `Brief` via `parseBrief` — so a hydrated base brief crosses the same typed boundary as a file-loaded one, never leaking untyped rows downstream.
   - **CLI argv** (`string[]`) enters each `bin/*` arg parser (unchanged); the `--apply` / `--dry-run` flags are read there.
2. **Domain types**
   - `Brief` (`lib/schema.ts`) — the single trusted campaign-state type; it is the file format, the diff operand, and the apply result. Once parsed, its invariants (15/4 RSA, ≤10 ad groups, id patterns) are carried, not re-checked.
   - The typed plan-delta values from `fixes/plan.ts` (`Keyword`, status entries, ad-group-create entries) — trusted inputs to `applyPlanToBrief`.
   - A `BriefDiff` value (new, in `adbriefs/diff.ts`) — a structured, typed description of what changed (added/removed/changed paths) plus its rendered text; downstream code renders it, it does not re-parse briefs.
3. **Parsers**
   - `parseBrief` (module `lib/schema.ts`) — the one YAML/live→`Brief` parser, reused by both the file-load and live-hydrate paths; returns the strong type or throws a `ZodError` surfaced as a readable message (as `readBrief` already does).
   - `validate` / `coerceKeyword` (module `fixes/plan.ts`) — the plan JSON parsers, unchanged; they return typed deltas or a typed error.
   - `slugForCampaign` (module `adbriefs/store.ts`) — maps a `Brief`'s campaign name to a filesystem slug; a total pure function (no throw), its output is the deterministic filename identity FR-008 requires.
4. **Library choice**
   - Existing project dependencies only: `zod` for the brief/plan boundaries (kept), `yaml` for serialize/parse (kept). The brief diff is a small hand-rolled function over the deterministic YAML serialization (stable key order) rather than a new dependency — a fixed, tiny grammar where an ordered structural compare is the right tool, consistent with the repo's other hand-rolled parsers. No new schema or diff library is introduced.

## Complexity Tracking

*No entries — the Constitution Check passed with no violations.*

## Phasing (MVP-first)

- **Phase 1 (US1, P1 — MVP):** `adbriefs/` dir + `adbriefs/store.ts` + `adbriefs/diff.ts`; `create.ts` persists the filled brief to `adbriefs/<slug>.yaml` before publish, diffs against any existing brief, and rewrites it after a successful publish. Independently shippable — delivers a durable local source of truth and the create-side gate.
- **Phase 2 (US2, P1):** `adbriefs/apply-plan.ts` + `adbriefs/hydrate.ts`; `apply-fixes.ts` builds the base brief (load or hydrate), applies the plan to it, shows the diff on dry-run, and mutates live only under `--apply`. Delivers the core review-the-change gate for updates.
- **Phase 3 (US3, P2):** post-apply sync — `apply-fixes.ts` (and `create.ts`) rewrite the brief to the applied state on success, and leave a detectable divergence marker (not a lying "fully applied" brief) on partial failure (FR-006, FR-010).
- Docs (`reference/create.md`, `reference/update.md`, `reference/conventions.md`) updated alongside the phase that changes each command; the shared flow lives in `conventions.md` (FR-011).
