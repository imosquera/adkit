# Tasks: Stage `ads.sh update` changes into the local adbrief before mutating live

**Input**: Design documents from `specs/043-adbrief-stage-update/` (spec.md, plan.md)
**Prerequisites**: plan.md (required)

## Phase 1: Setup

- [ ] T001 Confirm `skills/adkit/scripts` toolchain is ready: `npm install` (if needed) and `npm run typecheck` pass on the current tree before any new code lands, from `skills/adkit/scripts/`

## Phase 2: Foundational (blocking prerequisites)

- [ ] T002 Create `skills/adkit/scripts/src/adbriefs/apply-plan.ts` with the `ResolvedPlanGroup` type (`{ slug: string; sections: <per-section subsets>; unresolvedIds: Array<{ kind: "campaignId" | "adGroupId" | "adId"; id: string }> }`) per plan.md's Parse Boundaries section 2
- [ ] T003 Implement `resolvePlanGroups(plan: FixesPlan, index: StateIndex): ResolvedPlanGroup[]` in `skills/adkit/scripts/src/adbriefs/apply-plan.ts` — walks every id-bearing plan section (rewrites, appendHeadlines, sitelinks, callouts, negatives, keywords, budgets, campaignStatus, adGroupStatus, adStatus, adGroups, languages), looks each id up via `StateIndex.byCampaignId`/`byAdGroupId`/`byAdId`, groups by resolved slug, and collects unresolved ids per FR-001/FR-008 (depends on T002)
- [ ] T004 [P] Write `skills/adkit/scripts/src/adbriefs/apply-plan.test.ts` covering `resolvePlanGroups`: single-slug resolution, multi-slug split (FR-010), unresolved id collected as a warning while sibling ids in the same plan still resolve (FR-001), and an entirely-unresolvable campaign (missing state file, FR-008) (depends on T003)

## Phase 3: User Story 1 - Operator reviews a brief diff before an update goes live (Priority: P1) 🎯 MVP

**Goal**: `ads.sh update <plan>` (no `--apply`) resolves plan ids via the state file, stages the edits into a proposed brief, and prints a non-empty brief diff — without mutating live or writing any file under `adbriefs/`.

**Independent Test**: Run `ads.sh update <plan-with-a-rewrite>` without `--apply` against a campaign with an existing `adbriefs/<slug>.yaml` and `adbriefs/<slug>.state.yaml`; confirm a non-empty brief diff is printed and no file under `adbriefs/` changes.

- [ ] T005 [US1] Implement `applyPlanToBrief(base: Brief, group: ResolvedPlanGroup, computed): Brief` in `skills/adkit/scripts/src/adbriefs/apply-plan.ts` — pure function building a new `Brief` via spread/`map` from the already-computed `fixes/plan.ts` change-lists filtered to `group`'s entities: rewrites replace ad headlines/descriptions/paths/finalUrl; `appendHeadlines` merges with case-sensitive exact-match dedup (mirrors the live-mutation rule in `apply-fixes.ts`); negatives/keywords/sitelinks/callouts/budgets/status fields set from their change-lists (depends on T003)
- [ ] T006 [P] [US1] Extend `skills/adkit/scripts/src/adbriefs/apply-plan.test.ts` with `applyPlanToBrief` cases: each plan section type produces the expected `Brief` field change, a no-op change-list leaves the result serialization-identical to `base` (FR-011), and `appendHeadlines` dedup is case-sensitive (depends on T005)
- [ ] T007 [US1] In `skills/adkit/scripts/src/bin/apply-fixes.ts::main`, after the existing `validate()` call, load the `StateIndex` once via `loadStateIndex` (from `adbriefs/state.ts`), call `resolvePlanGroups`, and for each resolved slug: load its on-disk brief via `loadBriefIfExists`, call `applyPlanToBrief` with that slug's filtered change-lists, then `diffBriefs(current, proposed)` from `adbriefs/diff.ts` (depends on T005, T003)
- [ ] T008 [US1] Print each resolved slug's brief diff in `skills/adkit/scripts/src/bin/apply-fixes.ts` on every run (dry-run and `--apply`), before the existing "planned actions" narration; a slug with `unresolvedIds` prints an explicit warning naming each unresolvable id (depends on T007)
- [ ] T009 [US1] Confirm the existing dry-run path (`!apply` branch) in `skills/adkit/scripts/src/bin/apply-fixes.ts` performs no `writeBrief` call and no live mutation — add/verify a test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts` asserting `adbriefs/` is untouched after a dry-run with a staged diff (depends on T008)
- [ ] T010 [US1] [P] Update `skills/adkit/reference/update.md` to document the new dry-run diff-before-apply behavior, the per-entity unresolvable-id warning, and that `update` now mirrors `create`'s review gate (depends on T008)

**Checkpoint**: User Story 1 fully functional — dry-run shows brief diffs, nothing is written.

## Phase 4: User Story 2 + User Story 3 - Apply syncs the brief, and a partial/failed apply never lies (Priority: P1, ship together)

**Goal**: `--apply` mutates live first (unchanged sequence), then writes each successfully-mutated slug's staged brief to `adbriefs/<slug>.yaml`; a partial/failed apply leaves that slug's brief untouched and the JSON envelope reports it as not synced.

**Independent Test (US2)**: `ads.sh update <plan> --apply` against a campaign with an existing brief/state: live mutation succeeds, `adbriefs/<slug>.yaml` is rewritten to the staged content, JSON envelope reports `briefSynced: true`.

**Independent Test (US3)**: Simulate a live mutation that fails partway through `--apply`; confirm `adbriefs/<slug>.yaml` is byte-for-byte unchanged and the envelope reports `briefSynced: false` with a clear divergence message.

- [ ] T011 [US2] In `skills/adkit/scripts/src/bin/apply-fixes.ts`'s `--apply` branch, after each slug's live mutation steps complete successfully, call `writeBrief` (from `adbriefs/store.ts`) with that slug's `applyPlanToBrief` result; track per-slug success/failure so writes only happen for slugs whose mutation fully succeeded (depends on T007)
- [ ] T012 [US3] Wrap each slug's live-mutation sequence in `skills/adkit/scripts/src/bin/apply-fixes.ts` so a thrown/rejected mutation for that slug is caught, the brief write for that slug is skipped, and the failure is recorded for the envelope — without aborting mutation attempts for other, independent slugs (depends on T011)
- [ ] T013 [US2] [US3] Extend the JSON envelope emitted by `emitStatusEnvelope`/`ok()` in `skills/adkit/scripts/src/bin/apply-fixes.ts` with per-slug `briefSynced: boolean` and `briefPath` (FR-009), populated `true`/path on a successful write, `false`/omitted on skip or failure (depends on T011, T012)
- [ ] T014 [US3] Print an explicit "local brief and live account have diverged" message in `skills/adkit/scripts/src/bin/apply-fixes.ts` naming which planned changes did not apply, for any slug whose live mutation partially or fully failed (depends on T012)
- [ ] T015 [US2] [P] Extend `skills/adkit/scripts/src/bin/apply-fixes.test.ts` with an `--apply` success case: brief rewritten to match the pre-apply dry-run diff exactly, envelope reports `briefSynced: true` (depends on T011)
- [ ] T016 [US3] [P] Extend `skills/adkit/scripts/src/bin/apply-fixes.test.ts` with a simulated partial-failure case: brief unchanged byte-for-byte, envelope reports `briefSynced: false`, divergence message present (depends on T012, T014)
- [ ] T017 [US2] [US3] [P] Update `skills/adkit/reference/update.md` and `skills/adkit/reference/conventions.md` to document the mutate-then-write ordering, per-slug independence (FR-010), and the partial-failure-never-lies guarantee (depends on T013, T014)

**Checkpoint**: User Stories 1–3 fully functional — the core auto-sync gate is complete and safe.

## Phase 5: User Story 4 - Missing-state-file campaigns degrade gracefully (Priority: P3)

**Goal**: A campaign with no `adbriefs/<slug>.state.yaml` still gets its live mutation applied exactly as before this feature; brief staging is skipped with a loud, explicit indicator, never a silent omission.

**Independent Test**: Run `ads.sh update <plan> --apply` against a campaign whose state file does not exist; confirm the live mutation still runs to completion, no file under `adbriefs/` is touched, and the envelope contains an explicit skip indicator.

- [ ] T018 [US4] In `skills/adkit/scripts/src/bin/apply-fixes.ts`, when `resolvePlanGroups` reports a plan section's ids with no matching slug at all (no state file / no index entry), set `briefStagingSkipped: true` and `briefStagingSkipReason: "no-state-file"` (or `"unresolvable-id"` when some but not all ids in a campaign resolve) on that entity's envelope entry, per FR-009 (depends on T008)
- [ ] T019 [US4] Confirm in `skills/adkit/scripts/src/bin/apply-fixes.ts` that the live mutation path for an unresolved entity is completely unaffected by staging being skipped — the existing mutation steps run unconditionally regardless of resolution outcome (depends on T018)
- [ ] T020 [US4] [P] Add a regression test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: a campaign with no state file still gets its live mutation applied, no `adbriefs/` file is created or modified, and the envelope's `briefStagingSkipped`/`briefStagingSkipReason` fields are present and correct (depends on T018, T019)
- [ ] T021 [US4] [P] Update `skills/adkit/reference/update.md` to document the no-state-file fallback behavior and its envelope fields (depends on T018)

**Checkpoint**: All user stories complete.

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T022 [P] Run `npm run typecheck` and the full `vitest run` suite in `skills/adkit/scripts/` to confirm no regressions across `create`, `apply-fixes`, and the `adbriefs/` module family
- [ ] T023 [P] Re-read `skills/adkit/reference/update.md` and `skills/adkit/reference/conventions.md` end-to-end for consistency with the shipped behavior (no stale "not persisted locally" language remaining)

## Dependencies & Execution Order

- **Setup (Phase 1)**: T001 — no dependencies, must complete first.
- **Foundational (Phase 2)**: T002 → T003 → T004. Blocks every user-story phase (US1–US4 all call `resolvePlanGroups`/`ResolvedPlanGroup`).
- **User Story 1 (Phase 3)**: T005 → T006; T007 (needs T003, T005) → T008 → T009; T010 depends on T008. US1 is otherwise independent of US2–US4.
- **User Stories 2+3 (Phase 4)**: depend on US1's T007 (staged brief + diff already wired). T011 → T012 → T013/T014 → T015/T016; T017 depends on T013+T014.
- **User Story 4 (Phase 5)**: depends on US1's T008 (resolution/warning wiring already present). T018 → T019 → T020; T021 depends on T018. Independent of Phase 4 — could be built in parallel by a different task-runner once Phase 3 lands.
- **Polish (Phase 6)**: after all user stories — T022, T023.

## Execution Wave DAG

- **Wave 1**: T001
- **Wave 2**: T002 (depends on Wave 1 completing setup)
- **Wave 3**: T003
- **Wave 4**: T004 [P], T005 [P] (both depend on T003)
- **Wave 5**: T006 (depends on T005), T007 (depends on T003, T005)
- **Wave 6**: T008 (depends on T007)
- **Wave 7**: T009 [P], T010 [P], T011 [P] (all depend on T008/T007 respectively — T009/T010 on T008, T011 on T007; these can run in parallel once their single dependency clears)
- **Wave 8**: T012 (depends on T011)
- **Wave 9**: T013 (depends on T011, T012), T014 (depends on T012), T018 (depends on T008)
- **Wave 10**: T015 [P], T016 [P], T017 [P], T019 (depends on T018)
- **Wave 11**: T020 [P] (depends on T018, T019), T021 [P] (depends on T018)
- **Wave 12**: T022 [P], T023 [P]

## Implementation Strategy

**MVP first**: Ship Phase 3 (User Story 1) alone — a working diff-before-apply gate with zero write behavior is a safe, independently valuable increment (matches `create`'s existing review-only gate pattern).

**Incremental delivery**: Phase 4 (US2+US3) adds the actual auto-sync write, always paired with the partial-failure safety net so the brief can never assert an untrue state. Phase 5 (US4) is a pure fallback-path addition, safely deferrable if time-constrained, since Phase 3's resolution/warning logic already exists — Phase 5 only wires the envelope fields and adds regression coverage.
