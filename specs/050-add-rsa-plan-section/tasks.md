# Tasks: `addRsa` plan section (add a 2nd RSA to an existing ad group)

**Input**: Design documents from `specs/050-add-rsa-plan-section/` (`plan.md`, `spec.md`)

**Prerequisites**: `plan.md` (required), `spec.md` (required for user stories)

**Tests**: Included — `plan.md`'s Test plan section explicitly scopes new
`fixes/plan.test.ts`, `bin/apply-fixes.test.ts`, and
`adbriefs/apply-plan.test.ts` coverage, mirroring this repo's co-located
test convention (tests live next to the source they cover, added alongside
each new function — not a separate TDD-before phase).

**Organization**: Tasks are grouped by user story (spec.md) to enable
independent implementation and testing of each story. No new files are
created anywhere — every task widens an existing module named in `plan.md`
(`fixes/plan.ts`, `gaql/builders.ts`, `bin/apply-fixes.ts`,
`adbriefs/apply-plan.ts`, `reference/update.md`, `reference/audit.md`), all
under `skills/adkit/scripts/src/` unless noted.

## Format: `[ID] [P?] [Story?] Description [(depends on ...)]`

- **[P]**: Can run in parallel with other ready tasks once any listed
  dependencies are satisfied (different files or non-overlapping regions)
- **[Story?]**: Which user story this task belongs to (US1, US2, US3, US4).
  Required for user story phase tasks only.
- **(depends on ...)**: Explicit dependency on any earlier task IDs. Omit if
  the task has no explicit dependencies.

---

## Phase 1: Setup

**Purpose**: None required — this feature extends an existing, already-built
CLI (`skills/adkit/scripts`) with no new project, dependency, or tooling.
Proceed directly to Phase 2.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Stand up the plan-shape type, the live-RSA-state read path, and
the two pure decision functions (`resolveAddRsaFinalUrl`, `addRsaPlan`) that
every user story's validation, mutation, and staging work depends on. No
`addRsa` block can be validated, created, or skipped until this phase is
complete.

- [ ] T001 Add `addRsa?: Array<Record<string, unknown>>` to the `FixesPlan` interface in `skills/adkit/scripts/src/bin/apply-fixes.ts` (~line 487), alongside the existing `adGroups`/`bidding` fields.
- [ ] T002 [P] Add `applyRsaCountsQuery(adGroupIds: Array<string | number>): SearchArgs` in `skills/adkit/scripts/src/gaql/builders.ts`, an `inListQuery` factory scoped by `ad_group.id IN (...)` selecting `ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls`, filtered by `status != 'REMOVED'` and `ad.type = 'RESPONSIVE_SEARCH_AD'` (the same "live RSA" definition `auditAdGroupAdQuery`, ~line 419, already uses for `rsa_count_mismatch`).
- [ ] T003 Add `liveRsaState(client, customerId, adGroupIds): Promise<Map<number, { count: number; soleFinalUrl?: string }>>` in `skills/adkit/scripts/src/bin/apply-fixes.ts`, alongside `liveAdGroupNames` (~line 429): short-circuits to an empty `Map` when `adGroupIds` is empty; otherwise runs `applyRsaCountsQuery` and reduces rows by `ad_group.id`, setting `soleFinalUrl` only when a group's count is exactly 1 (depends on T002).
- [ ] T004 [P] Add `AddRsaCreatePlanEntry` interface and pure `resolveAddRsaFinalUrl(block, liveRsaState): string | undefined` (`block.finalUrl ?? liveRsaState.get(adGroupId)?.soleFinalUrl`) in `skills/adkit/scripts/src/fixes/plan.ts`, exported alongside the existing `biddingPlan`/`addAdGroupsPlan` pair (~line 949).
- [ ] T005 Add pure `addRsaPlan(blocks, liveRsaState): [AddRsaCreatePlanEntry[], Array<Record<string, unknown>>]` in `skills/adkit/scripts/src/fixes/plan.ts`, mirroring `biddingPlan`'s create/skip partition shape: a single left-to-right `reduce` over `blocks` threading a `Map<adGroupId, number>` of running counts (seeded from `liveRsaState`, incremented once per prior block in the same call that resolved to a create for the same `adGroupId`) — a block is a skip when its current running count is already `>= RSAS_PER_AD_GROUP` (depends on T004).
- [ ] T006 Wire `liveRsaState` (T003) and the `addRsaPlan` (T005) partition call into `skills/adkit/scripts/src/bin/apply-fixes.ts`: fetch `liveRsaState` alongside the other live-state fetches (~line 798), scoped to `section(plan, "addRsa").map(b => b.adGroupId)`; compute `const [addRsaChanges, addRsaSkips] = addRsaPlan(section(plan, "addRsa"), rsaState);` ahead of the `validate()` call (~line 819), mirroring the existing `biddingChanges`/`biddingSkips` placement (depends on T001, T003, T005).

**Checkpoint**: A plan's `addRsa` blocks can now be fetched against live
state and correctly partitioned into create-vs-skip entries — including the
same-`adGroupId`-twice edge case — before any validation or mutation exists.

---

## Phase 3: User Story 1 - Close an `rsa_count_mismatch` finding via a plan (Priority: P1) 🎯 MVP

**Goal**: An operator can author an `addRsa` block for an ad group with
fewer than 2 live RSAs and, via `ads.sh update --apply`, get a second,
distinct RSA created live in PAUSED status.

**Independent Test**: Apply a plan with one `addRsa` block for an ad group
with exactly 1 live, non-REMOVED RSA carrying a valid 15H/4D RSA. Verify a
second, distinct RSA is now live and PAUSED, the first RSA is untouched, and
the CLI reports the ad group as changed (not skipped).

- [ ] T007 [US1] Add `addRsaErrors(blocks, liveRsaState): string[]` in `skills/adkit/scripts/src/fixes/plan.ts`, mirroring `adGroupsErrors`'s issue-prefixing: for each block, check `adGroupId` is present/numeric, resolve `finalUrl` via `resolveAddRsaFinalUrl` (missing + nothing to default from → error naming the ad group, FR-007), then parse `{ headlines: normalizeRsa(block).headlines, descriptions: normalizeRsa(block).descriptions, finalUrl, path1, path2 }` through `ResponsiveSearchAdSchema.safeParse`, prefixing every zod issue `addRsa adGroup <id>: <path>: <message>` (depends on T004).
- [ ] T008 [US1] Route only `addRsaChanges` (never `addRsaSkips`) into `addRsaErrors` from `validate()` in `skills/adkit/scripts/src/fixes/plan.ts`/`skills/adkit/scripts/src/bin/apply-fixes.ts`, mirroring how only `biddingChanges` reaches `biddingErrors` (depends on T006, T007).
- [ ] T009 [US1] Add a mutation loop block in `skills/adkit/scripts/src/bin/apply-fixes.ts` alongside the existing "9) new ad groups" block (~line 1366): for each `addRsaChanges` entry, build `adGroupRn = customers/${customer}/adGroups/${pyStr(agid)}`, call `createResponsiveSearchAd(client, customer, entry.rsa, adGroupRn)`, log `+ RSA -> ad group <id>`, and on failure call `recordFailure` with `slugsForIds([agid], stateIndex.byAdGroupId)` (FR-008); log each `addRsaSkips` entry as `already 2/2 RSAs, skipped` (depends on T006, T008).
- [ ] T010 [US1] Add `addRsaChanges`/`addRsaSkipped` keys to `emitStatusEnvelope` in `skills/adkit/scripts/src/bin/apply-fixes.ts` (~line 912), mirroring the existing `biddingChanges`/`biddingSkipped` shapes (FR-010) (depends on T006).
- [ ] T011 [P] [US1] Unit tests in `skills/adkit/scripts/src/fixes/plan.test.ts`, new `describe("addRsa validation")`: `resolveAddRsaFinalUrl` returns the block's own `finalUrl` when present, the sole live RSA's `finalUrl` when omitted and live count is 1, and `undefined` when omitted and live count is 0; `addRsaErrors` accepts a well-formed 15H/4D block and rejects a block with a 0-count `finalUrl` gap (depends on T004, T007).
- [ ] T012 [P] [US1] Unit tests in `skills/adkit/scripts/src/fixes/plan.test.ts`, new `describe("addRsaPlan")`: a block targeting an ad group with 1 live RSA partitions as a create; a block targeting an ad group with 0 live RSAs partitions as a create (depends on T005).
- [ ] T013 [US1] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`, new `describe("addRsa (add-2nd-RSA) path")`: against a fake `AdsClient`, a 1-live-RSA ad group creates exactly one new PAUSED RSA on `--apply` (SC-001), the existing RSA is untouched, and `addRsaChanges` in the envelope reflects it; dry-run (no `--apply`) performs zero mutate calls while still reporting the would-be create (FR-009) (depends on T009, T010).

**Checkpoint**: User Story 1 is independently functional — the
`rsa_count_mismatch` gap `reference/audit.md` documents as unfixable is now
closeable end-to-end via `ads.sh update --apply`.

---

## Phase 4: User Story 2 - Re-running an already-applied plan is a safe no-op (Priority: P1)

**Goal**: Re-running the same plan against an ad group that already has 2
live RSAs never creates a 3rd; the block is reported skipped.

**Independent Test**: Apply the same plan twice against an ad group starting
with 1 live RSA. After the first apply the ad group has 2 live RSAs; after
the second apply it still has exactly 2, and the second run reports the
block as skipped.

- [ ] T014 [US2] Unit tests in `skills/adkit/scripts/src/fixes/plan.test.ts`'s `describe("addRsaPlan")`: a block targeting an ad group already at 2 (and, separately, 3+) live RSAs partitions as a skip; two `addRsa` blocks in the same call targeting the same `adGroupId` starting from 1 live RSA partition as `[create, skip]` — the second evaluated against the post-first-block count, not the live count both started from (spec Edge Cases, SC-002) (depends on T005).
- [ ] T015 [US2] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: re-applying the same plan against an ad group already at 2 live RSAs issues zero `createResponsiveSearchAd` calls and reports the block in `addRsaSkipped`, not `addRsaChanges` (depends on T009, T010).
- [ ] T016 [US2] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: a dry-run (no `--apply`) against an ad group already at 2 live RSAs shows the block would be skipped and performs no live mutation, matching the dry-run behavior already asserted for the create case in T013 (depends on T009, T010).

**Checkpoint**: User Stories 1 and 2 are both independently functional — the
feature can create the missing 2nd RSA and is provably idempotent across
re-runs, including the same-plan double-target edge case.

---

## Phase 5: User Story 3 - Invalid `addRsa` copy is rejected before any live mutation (Priority: P2)

**Goal**: A malformed `addRsa` block (wrong count, over-length text,
duplicate text, bad `adGroupId`, bad display path) fails validation for the
whole plan before any live mutation is attempted for any block.

**Independent Test**: Validate a plan with one well-formed and one malformed
`addRsa` block. Verify validation fails naming the offending block, and no
live mutation occurs for either block.

- [ ] T017 [US3] Extend `skills/adkit/scripts/src/fixes/plan.test.ts`'s `describe("addRsa validation")` with `addRsaErrors` rejection cases: wrong headline/description count (not 15/4), a headline over 30 chars, a description over 90 chars, duplicate headline/description text, an invalid `path1`/`path2`, and a missing/non-numeric `adGroupId` — each asserting the error names the offending `adGroupId` and rule (FR-003, SC-003) (depends on T007).
- [ ] T018 [US3] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: a plan with one valid and one invalid `addRsa` block fails validation before any block's `createResponsiveSearchAd` is called — zero mutate calls total, mirroring the existing malformed-`rewrites`/`adGroups` dry-run-safe behavior (FR-004) (depends on T008, T009).
- [ ] T019 [US3] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: an `addRsa` block whose `adGroupId` has no live ad group at all fails the mutate call and is caught per-block via `recordFailure`, without aborting unrelated `addRsa` blocks or other plan sections in the same run (FR-008, Acceptance Scenario 5) (depends on T009).

**Checkpoint**: All safety properties from spec.md are covered — no partial
apply, no live mutation on validation failure, per-block failure isolation.

---

## Phase 6: User Story 4 - The local brief gains the new RSA (Priority: P2)

**Goal**: After a successful `addRsa` apply, the resolved `adbriefs/<slug>.yaml`
reflects the new RSA in the targeted ad group's `responsiveSearchAds` array.

**Independent Test**: Apply a plan with one `addRsa` block targeting an ad
group resolvable to a known brief slug. After apply, the diff shown before
writing includes the new RSA, and the written brief has exactly 2 entries
there and re-parses against `BriefSchema`.

- [ ] T020 [US4] Add a `ResolvedAddRsaBlock { adGroupName: string; block: Record<string, unknown> }` type and a `sections.addRsa` array to `PlanSections`/`ResolvedPlanGroup` in `skills/adkit/scripts/src/adbriefs/apply-plan.ts`; add the `byAdGroupId(b, "adGroupId")` resolution arm for `addRsa` in `resolvePlanGroups` (~line 191), mirroring the existing `keywords` arm — unresolved ids fall through to the existing `standalone`/`unresolvedIds` path automatically (FR-012) (depends on T004).
- [ ] T021 [US4] Add `addRsaCreates?: AddRsaCreatePlanEntry[]` to `ApplyPlanComputed` in `skills/adkit/scripts/src/adbriefs/apply-plan.ts` (~line 224); populate it in `skills/adkit/scripts/src/bin/apply-fixes.ts` from `addRsaChanges`, mirroring how `computed.adGroupCreates` is populated from `agCreates` today (depends on T006, T009, T020).
- [ ] T022 [US4] Extend `applyPlanToBrief`'s existing `adGroups.map` in `skills/adkit/scripts/src/adbriefs/apply-plan.ts` (~line 266): for each `ag`, if `group.sections.addRsa` has an entry whose `adGroupName === ag.name` AND `ag.responsiveSearchAds.length < RSAS_PER_AD_GROUP` AND a matching entry exists in `computed.addRsaCreates`, append that entry's already-parsed `rsa` via `{ ...ag, responsiveSearchAds: [...ag.responsiveSearchAds, newRsa] }` — never mutating `ag.responsiveSearchAds` in place (depends on T020, T021).
- [ ] T023 [P] [US4] Staging test in `skills/adkit/scripts/src/adbriefs/apply-plan.test.ts`, alongside the existing `adGroups create appends a new ad group…` tests: a resolved `addRsa` block stages the new RSA onto the targeted ad group's `responsiveSearchAds`, producing a brief that re-parses against `BriefSchema` with exactly 2 entries (SC-004) (depends on T022).
- [ ] T024 [P] [US4] Staging test in `skills/adkit/scripts/src/adbriefs/apply-plan.test.ts`: an `addRsa` block whose `adGroupId` does not resolve to any tracked brief slug produces no brief change and surfaces via the existing `unresolvedIds`/warning path (FR-012), while the live mutation (US1) is unaffected (depends on T020).

**Checkpoint**: All four user stories are independently functional — the
live mutation, its idempotency, its validation-time safety, and its brief
bookkeeping are each complete and tested.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final verification.

- [ ] T025 [P] Add an `addRsa` bullet to `skills/adkit/reference/update.md` (style of the existing `adGroups` bullet, ~line 106) documenting fields, the `finalUrl` default, the PAUSED convention, and idempotency; add an `"addRsa": [...]` line to the plan-shape example next to `"adGroups"` (FR-013) (depends on T009, T022).
- [ ] T026 [P] Rewrite the `rsa_count_mismatch` note in `skills/adkit/reference/audit.md` (~line 42) to state the under-2 case is now fixable via `ads.sh update`'s `addRsa` lever, while an over-2 (3+) count still requires manual UI cleanup (FR-013).
- [ ] T027 Run `npm run typecheck` and `npx vitest run` from `skills/adkit/scripts` and confirm a clean pass with all new tests included (depends on T001-T026).

---

## Dependencies & Execution Order

- **Phase 2 (Foundational)** blocks all user stories — T001-T006 must
  complete first; nothing can validate, create, or skip an `addRsa` block
  before the plan-shape type, live-state read, and partition function exist.
- **User Story 1 (P1)** depends only on Foundational; delivers the MVP (a
  working create path).
- **User Story 2 (P1)** depends on Foundational (specifically T005's
  partition, which already encodes the skip decision) and on US1's mutation
  loop/envelope wiring (T009/T010) for its end-to-end tests to observe zero
  mutate calls — both are P1 and ship together.
- **User Story 3 (P2)** depends on Foundational and on US1's validation
  wiring (T008/T009) for its end-to-end dry-run-safety tests.
- **User Story 4 (P2)** depends on Foundational (T004) and on US1's mutation
  wiring (T006/T009) since brief staging consumes `addRsaChanges`'s already-
  parsed entries.
- **Polish** depends on all user stories being complete.

## Execution Wave DAG

Tasks grouped by dependency resolution. Tasks within the same wave can run
in parallel.

```text
Wave 1 (no dependencies):
  T001  Add addRsa field to FixesPlan
  T002 [P] Add applyRsaCountsQuery builder
  T004 [P] Add AddRsaCreatePlanEntry + resolveAddRsaFinalUrl
  T026 [P] Rewrite audit.md rsa_count_mismatch note

Wave 2 (T001/T002/T004 done):
  T003  Add liveRsaState fetch (depends on T002)
  T005  Add addRsaPlan partition (depends on T004)
  T007 [P] [US1] Add addRsaErrors (depends on T004)
  T020 [P] [US4] Add ResolvedAddRsaBlock + byAdGroupId resolution arm (depends on T004)

Wave 3 (T003/T005/T007/T020 done):
  T006  Wire liveRsaState + addRsaPlan into apply-fixes.ts (depends on T001, T003, T005)
  T011 [P] [US1] resolveAddRsaFinalUrl/addRsaErrors unit tests (depends on T004, T007)
  T012 [P] [US1] addRsaPlan create-partition unit tests (depends on T005)
  T014 [P] [US2] addRsaPlan skip-partition + double-target unit tests (depends on T005)
  T017 [P] [US3] addRsaErrors rejection-case unit tests (depends on T007)
  T024 [P] [US4] Unresolved-id staging test (depends on T020)

Wave 4 (T006 done):
  T008  [US1] Route addRsaChanges into addRsaErrors (depends on T006, T007)
  T010  [US1] Add addRsaChanges/addRsaSkipped envelope keys (depends on T006)

Wave 5 (T008 done):
  T009  [US1] Add addRsa mutation loop block (depends on T006, T008)

Wave 6 (T009/T010 done):
  T013  [US1] End-to-end create + dry-run test (depends on T009, T010)
  T015  [US2] End-to-end re-run-is-skip test (depends on T009, T010)
  T016  [US2] End-to-end dry-run-skip test (depends on T009, T010)
  T018  [US3] End-to-end invalid-plan-aborts-mutation test (depends on T008, T009)
  T019  [US3] End-to-end unresolvable-adGroupId isolation test (depends on T009)
  T021  [US4] Add ApplyPlanComputed.addRsaCreates + populate (depends on T006, T009, T020)

Wave 7 (T021 done):
  T022  [US4] Extend applyPlanToBrief staging (depends on T020, T021)

Wave 8 (T022 done):
  T023 [P] [US4] Staging test: resolved block appends RSA (depends on T022)
  T025 [P] Update reference/update.md (depends on T009, T022)

Wave 9 (all above done):
  T027  Run typecheck + vitest (depends on T001-T026)
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational.
2. Complete Phase 3: User Story 1 (T007-T013).
3. **STOP and VALIDATE**: apply a plan with one `addRsa` block against a
   1-live-RSA ad group; confirm a 2nd PAUSED RSA is created and the audit
   finding is closeable.

### Incremental Delivery

1. Foundational (Phase 2) → live-state read + create/skip decision ready.
2. User Story 1 (Phase 3) → the actual gap closes (MVP).
3. User Story 2 (Phase 4) → re-runs are provably safe (ships with US1 — both
   P1, required together for the feature to be safe to release).
4. User Story 3 (Phase 5) → invalid plans are provably rejected before any
   mutation.
5. User Story 4 (Phase 6) → the local brief stays in sync with live state.
6. Polish (Phase 7) → docs updated, full test suite green.

### Parallel Team Strategy

With multiple developers, once Phase 2 (Foundational) is complete:

- Developer A: User Story 1 (T007-T013), then User Story 2 (T014-T016) since
  both share the mutation/envelope wiring.
- Developer B: User Story 3 tests (T017), then T018-T019 once T008/T009 land.
- Developer C: User Story 4 (T020-T024) — independent of US1's mutation loop
  except for consuming `addRsaChanges`'s parsed entries at T021.
