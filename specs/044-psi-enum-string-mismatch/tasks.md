# Tasks: PSI auto-diagnosis never triggers because Quality Score enum fields arrive as integers, not strings

**Input**: Design documents from `specs/044-psi-enum-string-mismatch/` (`spec.md`, `plan.md`)

**Tests**: The source issue explicitly requests a regression test, so test tasks are included.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup

- [x] T001 Confirm the working tree builds/tests cleanly before changes: run `npm --prefix skills/adkit/scripts run typecheck` and `npm --prefix skills/adkit/scripts test` to capture the pre-fix baseline.

## Phase 2: Foundational

*No blocking prerequisites — this is a same-module bug fix with no shared scaffolding to stand up first.*

- [x] T002 Widen `QualityScoreRow.ad_group_criterion.quality_info` (`post_click_quality_score`, `creative_quality_score`, `search_predicted_ctr`) from `string` to `string | number` in `skills/adkit/scripts/src/audit/rows.ts`; `RawQualityScoreRow`'s `Partial<...>` of the same shape widens automatically since it derives from `QualityScoreRow`.

**Checkpoint**: Type widened; `normalizeQualityScoreRow`'s existing `?? ""` defaulting still compiles and behaves unchanged for absent fields (verified in US1/US2 below).

---

## Phase 3: User Story 1 - PSI runs automatically when landing-page experience is below average (Priority: P1) 🎯 MVP

**Goal**: A Quality Score row whose `post_click_quality_score` arrives as the raw integer `2` maps to `landingPageExp: "BELOW_AVERAGE"`, is selected by `belowAverageFinalUrls`, and causes `runPsi` to actually attempt a diagnosis.

**Independent Test**: Feed `qualityScore()` a fake-client row with `post_click_quality_score: 2` (integer) and assert the resulting entry's `landingPageExp === "BELOW_AVERAGE"`; separately, feed that entry into `belowAverageFinalUrls`/`runPsi` and assert the URL is selected / PSI is not a no-op.

### Implementation for User Story 1

- [x] T003 [US1] Add the pure `qualityScoreBucket(value: string | number | null | undefined): string` helper in `skills/adkit/scripts/src/bin/audit.ts` near the "Quality Score layer" section (above `qualityScore()`): pass strings through unchanged, look up numbers in the fixed table `["UNSPECIFIED", "UNKNOWN", "BELOW_AVERAGE", "AVERAGE", "ABOVE_AVERAGE"]` falling back to `"UNKNOWN"` for an out-of-range index, and default null/undefined to `""` (matching today's missing-field behavior).
- [x] T004 [US1] In `qualityScore()` (`skills/adkit/scripts/src/bin/audit.ts`, ~line 647), change `landingPageExp: qi.post_click_quality_score` to `landingPageExp: qualityScoreBucket(qi.post_click_quality_score)` (depends on T002, T003).
- [x] T005 [US1] Add a regression test to the `qualityScore` describe block in `skills/adkit/scripts/src/bin/audit.test.ts`: a fake-client row with `quality_info.post_click_quality_score: 2` (integer, plus a `quality_score` so it isn't dropped) asserts the resulting entry's `landingPageExp` is exactly `"BELOW_AVERAGE"` (depends on T004).
- [x] T006 [US1] Add a regression test to `skills/adkit/scripts/src/bin/audit-psi.test.ts` (or a new adjacent test) proving the integer-form entry (`landingPageExp: "BELOW_AVERAGE"` as produced by the real mapping, or a hand-built `QualityScoreEntry` standing in for it) is selected by `belowAverageFinalUrls` in `skills/adkit/scripts/src/lib/psi.ts` and that `runPsi` performs a real fetch attempt (not the `skipped`/no-op path) for the associated final URL (depends on T004).

**Checkpoint**: User Story 1 is independently functional — the primary reported defect (PSI silently never running) is fixed and covered by a regression test.

---

## Phase 4: User Story 2 - Ad Relevance and Expected CTR "below average" render lines also see string buckets (Priority: P2)

**Goal**: `adRelevance` (`creative_quality_score`) and `expectedCtr` (`search_predicted_ctr`) get the same normalization, so the "AD RELEVANCE BELOW AVERAGE" and "EXPECTED CTR BELOW AVERAGE" render sections stop silently omitting genuinely-below-average rows.

**Independent Test**: Feed `qualityScore()` a row with `creative_quality_score: 2` and `search_predicted_ctr: 2` (integers) and assert `adRelevance`/`expectedCtr` are `"BELOW_AVERAGE"` strings; assert the row appears when passed through `renderQualityScoreSection`.

### Implementation for User Story 2

- [x] T007 [US2] In `qualityScore()` (`skills/adkit/scripts/src/bin/audit.ts`, ~line 648-649), change `adRelevance: qi.creative_quality_score` and `expectedCtr: qi.search_predicted_ctr` to use `qualityScoreBucket(...)` the same way as T004 (depends on T002, T003).
- [x] T008 [P] [US2] Add a regression test to `skills/adkit/scripts/src/bin/audit.test.ts`'s `qualityScore` describe block: a row with `creative_quality_score: 2` and `search_predicted_ctr: 2` (integers) asserts both `adRelevance` and `expectedCtr` on the resulting entry are `"BELOW_AVERAGE"` strings (depends on T007).
- [x] T009 [P] [US2] Add/extend a test for `renderQualityScoreSection` (`skills/adkit/scripts/src/audit/render.ts`) — likely in an existing `render.test.ts` if present, otherwise colocated near T008 — confirming a `QualityScoreEntry` with `adRelevance: "BELOW_AVERAGE"` (produced via the fixed mapping) is included in the "AD RELEVANCE BELOW AVERAGE" section output (depends on T007).

**Checkpoint**: Both P1 and P2 user stories pass; all three Quality Score component fields are normalized consistently.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [x] T010 Update the `QualityScoreEntry` JSDoc / any inline comments in `skills/adkit/scripts/src/audit/types.ts` if they document the field as "as returned by the API" in a way that no longer matches (the type itself, `string`, is unchanged — only if comment text needs a small accuracy fix) (depends on T004, T007).
- [x] T011 Run the full gate suite from `skills/adkit/scripts/`: `npm run typecheck`, `npm test` (vitest), and any configured lint command; fix any findings (depends on T005, T006, T008, T009).
- [x] T012 Re-read `skills/adkit/scripts/src/audit/rows.ts`'s file-level doc comment ("Enum fields arrive as their STRING name already") and add a one-line note flagging the three Quality Score component fields as the confirmed exception, so a future reader isn't misled by the general claim (depends on T002).

## Dependencies & Execution Order

- **Setup (Phase 1)**: T001 — no dependencies, run first to capture the baseline.
- **Foundational (Phase 2)**: T002 — no dependencies; blocks T004 and T007 (both call sites need the widened type to compile the helper's `number` branch meaningfully against real data).
- **User Story 1 (Phase 3)**: T003 → T004 (needs T002, T003) → T005, T006 (need T004). US1 has no dependency on US2.
- **User Story 2 (Phase 4)**: T007 (needs T002, T003 — T003 is shared with US1, not duplicated) → T008, T009 (need T007). Independent of US1's test tasks; can start once T002/T003 land.
- **Polish (Phase 5)**: T010 depends on T004 + T007 (both mapping changes complete); T011 depends on all test tasks (T005, T006, T008, T009); T012 depends only on T002.

## Execution Wave DAG

- **Wave 1** (parallel): T001, T002, T003 — no interdependencies among these three.
- **Wave 2** (parallel, after Wave 1): T004 (needs T002, T003), T007 (needs T002, T003), T012 (needs T002).
- **Wave 3** (parallel, after Wave 2): T005, T006 (need T004); T008, T009 (need T007); T010 (needs T004, T007).
- **Wave 4** (after Wave 3): T011 — full gate run, needs every test task green.

## Implementation Strategy

**MVP = User Story 1** (T001-T006 plus the shared T002/T003 foundational work): fixes the primary reported defect (`landingPageExp`/PSI trigger). User Story 2 (T007-T009) extends the identical fix pattern to the two remaining fields and is low-risk/low-effort once US1's helper exists — recommended to ship in the same PR rather than deferred, since it is the same root cause and the issue explicitly asks for all three fields to be fixed together.
