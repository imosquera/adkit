# Tasks: Simplify & consolidate the adkit scripts codebase

**Feature**: 028-simplify-consolidate-scripts
**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md)

All paths are relative to the CLI package root `skills/adkit/scripts/`.

This is a **behavior-preserving refactor**. The existing `vitest` suite is the equivalence guardrail: the strategy is to keep tests green throughout, never weaken them, and treat any required test edit as an intentional, listed behavior delta (FR-007, FR-008). Consolidations are ordered low-risk-first: GAQL builders → audit decomposition → cross-file + lib consolidation.

## Phase 1: Setup

- [ ] T001 Establish a green baseline: from `skills/adkit/scripts/` run `npm ci` (or `npm install` if `node_modules` absent), then `npx tsc --noEmit` and `npm test`. Record the passing test count and total line counts of the in-scope files (`gaql/builders.ts`, `bin/audit.ts`, `bin/apply-fixes.ts`, `fixes/plan.ts`, `ads/entities.ts`, `bin/research.ts`, `lib/*.ts`) for the FR-009 before/after delta.

## Phase 2: Foundational

- [ ] T002 Confirm the consolidation map: verify (grep `index.ts` + all importers under `skills/adkit/` incl. `reference/` and any callers) exactly which `gaql/builders.ts` exports, `bin/audit.ts` exports, and the `lib/report → gaql/builders` re-export are consumed externally. Produce the authoritative "must-stay-resolvable" export list that every later phase preserves (FR-012). (depends on T001)

## Phase 3: User Story 1 — Consolidate the GAQL builder layer (P1)

**Goal**: Collapse the 26 report/audit/apply builders onto a parameterized core; keep every named export as a thin wrapper; preserve output byte-for-byte and the `gaqlId` guard.

**Independent Test**: `gaql/builders.test.ts` + `gaql/builders-parity.test.ts` pass unchanged; every builder emits identical `SearchArgs`/GAQL.

- [ ] T003 [US1] Define the parameterized core in `src/gaql/builders.ts`: a query-descriptor shape (`resource`, `fields`, `conditions`, optional `orderings`/`limit`) and a single function that produces `SearchArgs` from it, reusing the existing `_METRICS` / `_whereConds` / `_ENABLED` fragments. Route all id interpolation through `gaqlId`. (depends on T002)
- [ ] T004 [US1] Re-express the **report** family (`campaignTotalsQuery`, `campaignDailyQuery`, `adGroupQuery`, `adQuery`, `keywordQuery`, `searchTermQuery`) as thin wrappers over the core, preserving each export signature. Run `builders-parity.test.ts` after. (depends on T003)
- [ ] T005 [US1] Re-express the **audit** family (`auditKeywordsQuery` … `auditServingQuery`) as thin wrappers over the core, preserving signatures and the digits-only id guards. Run the builder tests after. (depends on T003)
- [ ] T006 [US1] Re-express the **apply/mutate** family (`applyNegativesQuery` … `applyPositiveKeywordsQuery`) as thin wrappers over the core, preserving signatures. Run the builder tests after. (depends on T003)
- [ ] T007 [P] [US1] Full gate for US1: `npx tsc --noEmit` + `npm test` green with no test edits; record the `builders.ts` line-count delta. Any builder whose output legitimately cannot be reproduced is left un-merged and noted (FR-001). (depends on T004, T005, T006)

## Phase 4: User Story 2 — Decompose bin/audit.ts (P1)

**Goal**: Split `bin/audit.ts` (~1500 lines) by concern into `src/audit/*`; fold the 7 `normalize*Row` functions into one generic row-mapper; keep exported symbols resolvable and audit output identical.

**Independent Test**: `bin/audit.test.ts` passes unchanged; the audit command renders identical output for a fixed input.

- [ ] T008 [US2] Create `src/audit/normalize.ts`: a single generic `RawRow → TypedRow` mapper driven by a per-shape field spec, replacing `normalizeAdGroupAdRow`, `normalizeServingRow`, `normalizeKeywordMetricsRow`, `normalizeSearchTermRow`, `normalizeQualityScoreRow`, `normalizeLandingPageMobileRow`, `normalizePolicyTopicRow`. Keep the produced typed-row types identical. (depends on T002)
- [ ] T009 [US2] Create `src/audit/render.ts`: move the `render*` / formatting helpers (`renderCreativeSummary`, `renderImpressionShare`, `renderKeywordCpc`, `renderSearchTermCandidates`, `renderQualityScoreSection`, `renderLandingPageHealth`, `ljust`/`rjust`/`pct`/`emitLines`) with no output change. (depends on T002)
- [ ] T010 [US2] Create `src/audit/orchestrate.ts` (or `scoring.ts`): move query/scoring orchestration (`auditCampaign`, `campaignServing`, `keywordCpc`, `searchTerms`, `qualityScore`, `landingPageMobile`, `landingPagePolicy`, `scoreAd`, `scoreServing`, `clusterSplits`, `negativesAndPromotions`), importing normalize + builders. (depends on T008)
- [ ] T011 [US2] Slim `src/bin/audit.ts` to arg parsing (`parseAudarArgs`), `main`/`runAudit`, and re-exports of every symbol T002 flagged as externally consumed (so `index.ts` and importers keep resolving). (depends on T009, T010)
- [ ] T012 [P] [US2] Full gate for US2: `npx tsc --noEmit` + `npm test` green with `bin/audit.test.ts` unedited; record the audit line-count delta across `bin/audit.ts` + `src/audit/*`. (depends on T011)

## Phase 5: User Story 3 — Cross-file + lib/ consolidation (P2)

**Goal**: Extract logic duplicated across `apply-fixes.ts`/`fixes/plan.ts`/`entities.ts`/`research.ts`; consolidate overlapping `lib/` helpers to one home; collapse the `lib/report` back-compat re-export if unused externally.

**Independent Test**: `bin/apply-fixes.test.ts`, `fixes/plan.test.ts`, and `lib/*.test.ts` pass unchanged; consumers resolve helpers from the new single home.

- [ ] T013 [US3] Extract logic duplicated between `src/bin/apply-fixes.ts` and `src/fixes/plan.ts` (plan-shape / mutate-op construction) into a shared helper module used by both; keep the mutate operations identical. (depends on T002)
- [ ] T014 [P] [US3] Consolidate overlapping `lib/` helpers (formatting / ratio / micros-to-currency across `lib/report.ts`, `lib/metrics.ts`, `lib/merge.ts`, `lib/cluster.ts`, `lib/schema.ts`) to one home per responsibility; update importers. (depends on T002)
- [ ] T015 [US3] Collapse the `lib/report → gaql/builders` back-compat re-export **only if** T002 confirmed no external consumer; otherwise leave it and note why (FR-006). (depends on T002, T007)
- [ ] T016 [P] [US3] Full gate for US3: `npx tsc --noEmit` + `npm test` green with the lib/apply-fixes/plan tests unedited; record line-count deltas. (depends on T013, T014, T015)

## Phase 6: Polish & Verification

- [ ] T017 Whole-suite equivalence gate: `npx tsc --noEmit` + `npm test` from `skills/adkit/scripts/` all green; confirm no test was weakened. (depends on T007, T012, T016)
- [ ] T018 [P] Compile the FR-008 behavior-delta list (ideally empty) and the FR-009 per-area before/after line-count reduction table for the PR body and the issue #28 consolidation survey (FR-011). Confirm `reference/*.md` and `SKILL.md` are untouched (FR-010). (depends on T017)

## Dependencies & Execution Waves

- **Wave 1** (after setup): T001 → T002.
- **Wave 2** (parallel per story, all depend on T002): US1 core T003 → {T004, T005, T006} → T007; US2 T008/T009 → T010 → T011 → T012; US3 T013, T014, (T015 also needs T007).
- **Wave 3**: T016 → T017 → T018.
- US1, US2, US3 touch largely independent files and can proceed in parallel after T002; T015 waits on T007 (re-export lives in the builder area).
