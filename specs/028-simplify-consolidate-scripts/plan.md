# Implementation Plan: Simplify & consolidate the adkit scripts codebase

**Branch**: `028-simplify-consolidate-scripts` | **Date**: 2026-07-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/028-simplify-consolidate-scripts/spec.md`

## Summary

A behavior-preserving consolidation of the adkit TypeScript codebase (`skills/adkit/scripts/src`) across three scoped areas, ordered low-risk-first:

1. **GAQL builders** (`gaql/builders.ts`) — collapse the 26 near-duplicate builders in the report/audit/apply families onto a small parameterized core (a query-descriptor shape plus a builder that fills `SearchArgs`), while keeping every named export (`campaignTotalsQuery`, `auditKeywordsQuery`, `applyNegativesQuery`, …) as a thin wrapper so call sites, `index.ts`, and the `builders-parity` tests stay stable (FR-001, FR-002, FR-012).
2. **`bin/audit.ts`** (~1500 lines) — split by concern into focused modules under `src/audit/` (row normalization, rendering, orchestration/scoring), and fold the 7 repetitive `normalize*Row` functions into one generic row-mapper driven by a per-shape field spec (FR-003, FR-004). Re-exported symbols keep their public paths.
3. **Cross-file + `lib/` consolidation** — extract logic duplicated across `apply-fixes.ts` / `fixes/plan.ts` / `ads/entities.ts` / `research.ts`, consolidate overlapping `lib/` helpers (formatting, ratios, micros) to one home per responsibility, and collapse the `lib/report → gaql/builders` back-compat re-export if no external consumer depends on it (FR-005, FR-006).

Guardrail: the full `vitest` suite stays green (FR-007); the pass aims for zero user-visible output changes, with any unavoidable delta listed in the PR (FR-008); net duplication/line-count deltas are reported per area (FR-009). No changes to `reference/*.md` or `SKILL.md` (FR-010).

## Technical Context

**Language/Version**: TypeScript (Node, ESM), compiled via the adkit `skills/adkit/scripts` package.

**Primary Dependencies**: `google-ads-api` (SDK types/error shapes), `zod` (existing schema parsing), `yaml`, `vitest`. No new dependencies.

**Storage**: N/A (no persistence changes; outputs unchanged).

**Testing**: `vitest` — the existing suite under `skills/adkit/scripts/src`, notably `gaql/builders.test.ts`, `gaql/builders-parity.test.ts`, `bin/audit.test.ts`, `bin/apply-fixes.test.ts`, `fixes/plan.test.ts`, and the `lib/*.test.ts` files, which lock in equivalence.

**Target Platform**: CLI (the `bin/*` entrypoints via `ads.sh`/skill wrappers).

**Project Type**: single CLI project.

**Performance Goals**: N/A (pure refactor; no hot path introduced or altered).

**Constraints**: Pure functions for builders/normalizers/renderers (CLAUDE.md rule 1); parse-once-at-the-boundary with no new downstream re-checks (CLAUDE.md rule 2); named builder exports and existing `bin/*` invocation surfaces must keep working unchanged.

**Scale/Scope**: `gaql/builders.ts`, `bin/audit.ts` (split into `src/audit/*`), `bin/apply-fixes.ts`, `fixes/plan.ts`, `ads/entities.ts`, `bin/research.ts`, and `lib/*.ts`, plus their co-located tests — all under `skills/adkit/scripts/src`.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after design.*

The project constitution at `.specify/memory/constitution.md` is an unfilled template (placeholder principle names); `constitution_audit.py validate` treats it as a no-op. The binding conventions for this repo live in `CLAUDE.md` and are honored here:

- **Functional style** (CLAUDE.md rule 1): "same input → same output, no side effects in the core logic". The consolidated builders, the generic row-mapper, and extracted helpers all remain pure functions returning new values; I/O stays isolated in the `bin/*` command edges. **PASS**
- **Parse, don't validate** (CLAUDE.md rule 2): "Turn untrusted/loose input into a precise, well-typed value once, at the edge". Consolidation moves any re-validation back to the single boundary parse and trusts the parsed type downstream, rather than relocating checks. **PASS**
- **No redundant downstream checks** (CLAUDE.md rule 2): where the refactor finds a re-check of something the boundary already guaranteed, it is removed, not copied; branded/parsed values are trusted. **PASS**
- **No classes for logic** (CLAUDE.md rule 1): no new classes are introduced; only existing error types and third-party SDK objects remain. **PASS**

No violations; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/028-simplify-consolidate-scripts/
├── spec.md
├── plan.md
├── tasks.md              # created by /speckit-tasks
└── checklists/
    └── requirements.md   # spec quality checklist
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── gaql/
│   ├── builders.ts           # parameterized core + named thin-wrapper exports
│   ├── builders.test.ts      # unchanged (equivalence guardrail)
│   └── builders-parity.test.ts
├── audit/                    # NEW module dir carved out of bin/audit.ts
│   ├── normalize.ts          # one generic row-mapper + per-shape field specs
│   ├── render.ts             # render* functions
│   └── orchestrate.ts        # query/scoring orchestration (auditCampaign, etc.)
├── bin/
│   ├── audit.ts              # slim entrypoint: arg parse + main(), delegates to audit/*
│   ├── apply-fixes.ts        # de-duplicated against fixes/plan.ts
│   └── research.ts
├── fixes/
│   └── plan.ts               # shared plan/mutate-op helpers extracted
├── ads/
│   └── entities.ts
└── lib/
    ├── report.ts             # back-compat re-export collapsed if unused
    ├── metrics.ts / merge.ts / cluster.ts / schema.ts   # overlaps consolidated
    └── (shared home for formatting/ratio/micros helpers)
```

**Structure Decision**: Single CLI package (`skills/adkit/scripts`). The largest structural change is carving `bin/audit.ts` into a new `src/audit/` module set; all functions currently exported from `audit.ts` and consumed elsewhere (verified via `index.ts` and importer grep before moving) are re-exported from `bin/audit.ts` or `index.ts` so their public import paths do not break. Every other change is internal reshaping behind stable exports.

## Parse Boundaries

TypeScript feature — enumerated per the parse-dont-validate gate.

1. **Trust boundaries**
   - **CLI argv** (`string[]`) enters each `bin/*` command's arg parser (e.g. `audit.ts::parseAudarArgs`). Raw tokens are untrusted and consumed into a typed args value; they never leak out untyped. This boundary is preserved, not widened, by the refactor.
   - **Google Ads API rows** (`unknown` / loose `Record`) enter the `normalize*Row` mappers in `bin/audit.ts`. Today each is a bespoke `Raw*Row → *Row` function; the refactor keeps these as the single typed boundary for API rows, funneled through one generic mapper that still narrows `unknown`-shaped raw fields to the typed row — never `any`.
   - **SDK thrown errors** (`unknown`) enter the shared error formatter (`cli/output.ts::sdkErrorMessage`), unchanged.
   - **Processed idea / plan JSON** enters via the existing `zod` schemas (`lib/schema.ts`, `fixes/plan.ts::validate`) — the boundary that turns loose JSON into the strong `Brief`/plan types.
2. **Domain types**
   - `SearchArgs` (`gaql/search-args.ts`) — the decomposed, trusted query shape every builder returns; the consolidation preserves its type exactly. Ids interpolated into conditions remain guarded by `gaqlId` (digits-only), which is the nominal guard preventing an arbitrary string from being treated as an id.
   - The typed audit row types (`AdGroupAdRow`, `ServingRow`, `KeywordMetricsRow`, `SearchTermRow`, `QualityScoreRow`, `LandingPageMobileRow`, `PolicyTopicRow`) — the outputs of the normalize boundary; the generic mapper produces exactly these, one field spec per type.
   - The parsed `Brief` / fixes-plan types from the `zod` boundary — trusted downstream; the refactor removes, not relocates, any redundant re-checks of fields these schemas already establish.
3. **Parsers**
   - The per-command arg parsers (module `src/bin/*.ts`) map `string[] → <Command>Args`; pure, no throw for normal flows, consistent with existing behavior.
   - The generic row-mapper (module `src/audit/normalize.ts`) maps `RawRow → TypedRow` given a per-shape field spec; it owns the narrowing casts, so the boundary lives in exactly one place instead of seven.
   - `gaqlId` / `gaqlString` (module `src/gaql/escape.ts`) are the id/string parsers for query interpolation; brand-style casts (accepting only digit strings) live only there. Unchanged.
   - `validate` (module `src/fixes/plan.ts`) and the `zod` schemas in `src/lib/schema.ts` remain the JSON parsers; they return the strong type or a typed error, not a bare boolean.
4. **Library choice**
   - Existing project dependencies: `zod` for JSON/plan/brief parsing (kept), and hand-rolled guarded parsers for CLI args, GAQL id escaping, and API-row narrowing (kept — these are tiny fixed grammars and loose SDK unions where an ordered guarded read is the right tool, consistent with the sibling commands). No new schema library is introduced; the refactor consolidates the existing parsers rather than adding one.

## Complexity Tracking

*No Constitution Check violations; nothing to justify.*
