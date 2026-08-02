---

description: "Task list for bid-strategy edits via ads.sh update"

---

# Tasks: Bid-strategy edits via `ads.sh update`

**Input**: Design documents from `specs/046-bid-strategy-edits/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Included — the spec's success criteria (SC-002/SC-003/SC-004) are
only verifiable via automated tests, and the plan's Test plan section
specifies them explicitly.

**Organization**: Tasks are grouped by user story (US1/US2/US3, matching
spec.md's priorities) after a shared Foundational phase, since all three
stories operate on the same new `bidding` plan section and its one fetched
live-state map.

## Format: `[ID] [P?] [Story?] Description [(depends on ...)]`

All file paths are relative to `skills/adkit/scripts/`.

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: The plan-format plumbing and live-state query every user story
builds on. No user story work starts until this phase is complete.

- [ ] T001 [P] Add `applyBiddingGuardQuery(campaignIds)` to `src/gaql/builders.ts` (near `applyBudgetsQuery`, "`/adkit update` builders" section): `inListQuery("campaign", ["campaign.id", "campaign.bidding_strategy_type", "metrics.conversions", "metrics.average_cpc"], "campaign.id", campaignIds, [lastNDays(30)])`, fixed to 30 days regardless of any other setting.
- [ ] T002 [P] Add a `src/gaql/builders.test.ts` case asserting `applyBiddingGuardQuery`'s resource, fields, `IN (...)` clause, and `LAST_30_DAYS` condition (depends on T001).
- [ ] T003 [P] Add `bidding: Array<Record<string, unknown>>` to `ResolvedPlanGroup["sections"]` and `PlanSections` in `src/adbriefs/apply-plan.ts`, initialize it in `emptySections()`, and wire `campaignSection("bidding", (g, b) => g.sections.bidding.push(b))` alongside the existing `"budgets"` line in `resolvePlanGroups`.
- [ ] T004 Add `biddingGuardState(client, customerId, campaignIds)` to `src/bin/apply-fixes.ts`, mirroring `campaignBudgets` (same file): returns `Map<number, { biddingStrategyType: string; conversions30d: number; avgCpcMicros30d: number }>` built from `client.searchStructured` over `applyBiddingGuardQuery` (depends on T001).
- [ ] T005 Wire the `bidding` plan section into `main()` in `src/bin/apply-fixes.ts`: fetch `biddingGuardState` alongside the existing `campaignBudgets` call, and read `section(plan, "bidding")` / `arr(plan, "bidding")` the same way `"budgets"` is read (depends on T004, T003).

**Checkpoint**: Foundation ready — US1, US2, US3 can now be implemented (US2/US3 still need T005's fetched state, satisfied here).

---

## Phase 2: User Story 1 - Reverse a stalled Smart Bidding campaign back to Maximize Clicks (Priority: P1) 🎯 MVP

**Goal**: A `bidding` plan entry stages, diffs, and (with `--apply`) mutates a
campaign's bid strategy + CPC ceiling through the existing dry-run/apply
flow — the audit → update loop closes for this recommendation.

**Independent Test**: Per spec.md's US1 Independent Test — dry-run shows the
diff, `--apply` mutates the live campaign to match.

### Implementation for User Story 1

- [ ] T006 [US1] Implement bidding staging in `applyPlanToBrief` (`src/adbriefs/apply-plan.ts`): take the last `bidding` block for the slug's campaign, compute `bidStrategy`/`cpcBidCeilingMicros`, fold into the `campaignChanged` check and returned `campaign` object — mirrors the existing `lastBudget`/`budgetMicros` pattern in the same function (depends on T003).
- [ ] T007 [P] [US1] Add `src/adbriefs/apply-plan.test.ts` cases: a `bidding` block stages `bidStrategy`/`cpcBidCeilingMicros` onto the proposed `Brief`; a plan with no `bidding` blocks leaves `campaign` unchanged (depends on T006).
- [ ] T008 [US1] Add a bidding action-string line to the printed plan summary in `src/bin/apply-fixes.ts` (sibling to the existing `budgets` action-string line) (depends on T005).
- [ ] T009 [US1] Add the bidding mutation step in `src/bin/apply-fixes.ts`'s `--apply` branch (numbered step alongside the existing "budgets" step): a `campaign` `update` operation setting `target_spend.cpc_bid_ceiling_micros` for a `maximize-clicks` target or `maximize_conversions` for the reverse, with the same per-campaign `recordFailure` error handling as the budgets step (depends on T006, T005).
- [ ] T010 [US1] Verify (and if needed extend) the oneof-clearing behavior assumed in T009 against the `google-ads-api` SDK's mutate-operation building (`src/lib/auth.ts`) — confirm sending `target_spend` clears a prior `maximize_conversions` value on the live campaign, or add the explicit null if it doesn't (depends on T009).
- [ ] T011 [US1] Add `src/bin/apply-fixes.test.ts` end-to-end case: a `bidding` plan entry with no guard concerns — dry-run prints the diff and issues zero mutate calls; `--apply` issues exactly the expected `campaign` update mutate op (depends on T009).
- [ ] T012 [US1] Add a `src/adbriefs/apply-plan.test.ts` (or `src/lib/schema.test.ts`, whichever already covers `CampaignSchema`) regression case confirming a bidding-staged brief with an invalid `cpcBidCeilingMicros`/`bidStrategy` pairing is rejected by the existing `parseBrief` re-parse in `stageResolvedGroups` — proves FR-002's "reuse, don't duplicate" holds (depends on T006).

**Checkpoint**: User Story 1 is fully functional and independently testable — the audit → update loop closes for the motivating case.

---

## Phase 3: User Story 2 - Guardrail blocks an accidental downgrade off proven Smart Bidding (Priority: P2)

**Goal**: `ads.sh update` refuses a `maximize-conversions` → `maximize-clicks`
change on a campaign with ≥30 trailing-30-day conversions unless
`acknowledgeStrategyDowngrade: true` is set; the reverse direction is never
guarded.

**Independent Test**: Per spec.md's US2 Independent Test — plan without the
acknowledgement is refused with a clear message; the same plan with it
proceeds.

### Tests for User Story 2

- [ ] T013 [P] [US2] Add `src/fixes/plan.test.ts` cases for `biddingErrors`: refuses at exactly 30 conversions without acknowledgement (boundary, SC-003); allows at 29; allows at 30+ with `acknowledgeStrategyDowngrade: true`; never guards the `maximize-clicks` → `maximize-conversions` direction regardless of conversion count; errors on an unknown `campaignId` (write first, confirm it fails before T014/T015 land) (depends on T004).

### Implementation for User Story 2

- [ ] T014 [US2] Add `CONVERSION_GUARD_THRESHOLD = 30` and the pure `biddingErrors(blocks, biddingState)` validator to `src/fixes/plan.ts`, mirroring `budgetsErrors`'s shape and error-message style exactly (depends on T004).
- [ ] T015 [US2] Spread `...biddingErrors(arr("bidding"), biddingState)` into the `validate()` aggregator in `src/fixes/plan.ts`, adding `biddingState` as a new required parameter (mirrors how `budgets` is threaded through) (depends on T014).
- [ ] T016 [US2] Update the `validate()` call site in `src/bin/apply-fixes.ts`'s `main()` to pass the fetched `biddingGuardState` result (depends on T015, T005).
- [ ] T017 [US2] Add `src/bin/apply-fixes.test.ts` end-to-end cases: a refused downgrade fails `validate()` and issues zero mutate calls for the whole run; the same plan with the acknowledgement field proceeds and mutates (depends on T016, T013).

**Checkpoint**: User Stories 1 and 2 both work independently — the risky direction is guarded.

---

## Phase 4: User Story 3 - Ceiling-sanity warning on dry run (Priority: P3)

**Goal**: Dry-run output warns (without blocking) when a proposed
`cpcBidCeilingMicros` is below the campaign's trailing-30-day average CPC.

**Independent Test**: Per spec.md's US3 Independent Test — a low ceiling
produces a visible warning and still proceeds; a ceiling at/above average CPC
produces no warning.

### Implementation for User Story 3

- [ ] T018 [US3] Add the non-blocking ceiling-sanity warning pass in `src/bin/apply-fixes.ts`: for each `bidding` block, compare `cpcBidCeilingMicros` to `biddingGuardState.get(campaignId).avgCpcMicros30d` and push a `WARNING:` line into the existing warning-printing block (sibling to the ENABLE / search-partners-on warnings) when the ceiling is lower — deliberately outside `biddingErrors`/`validate()` so it never blocks (depends on T005).
- [ ] T019 [US3] Add `src/bin/apply-fixes.test.ts` cases: a ceiling below average CPC prints the comparison warning and the run still applies (SC-004); a ceiling at or above average CPC prints no warning (depends on T018).

**Checkpoint**: All three user stories are independently functional.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final verification across all three stories.

- [ ] T020 [P] Rewrite `reference/update.md:104` (the `budgets` paragraph ending "Bid *strategy* is intentionally **not** editable here…") and `reference/update.md:153` ("It **cannot** change a bid strategy…") to describe the new `bidding` section, its guardrail, and the ceiling-sanity warning.
- [ ] T021 [P] Update `reference/audit.md`'s `cold_start_throttle` description (~line 52) and its "mostly not creative fixes" summary (~line 55) to point at the new `bidding` lever as the fix for a starved `maximize-conversions` campaign.
- [ ] T022 Run the full test suite, typecheck, and lint for `skills/adkit/scripts` and confirm all green (depends on T010, T011, T012, T017, T019).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — can start immediately.
- **User Story 1 (Phase 2)**: Depends on Foundational completion (T003, T005).
- **User Story 2 (Phase 3)**: Depends on Foundational completion (T004, T005); independent of US1's staging/mutation work (T006-T012), though both land in `apply-fixes.ts`'s `main()`.
- **User Story 3 (Phase 4)**: Depends on Foundational completion (T005); independent of US1 and US2.
- **Polish (Phase 5)**: T020/T021 have no code dependency (can run any time after Phase 1); T022 depends on every story's tests being written.

### User Story Dependencies

- **User Story 1 (P1)**: No dependency on US2 or US3 — a `bidding` entry with no guard-triggering conversion count and no ceiling warning is fully functional on Foundational alone.
- **User Story 2 (P2)**: No dependency on US1's staging/mutation code — the guard operates purely on the plan block + fetched live state, before staging/apply run.
- **User Story 3 (P3)**: No dependency on US1 or US2 — the warning is a separate, non-blocking pass over the same fetched live state.

### Parallel Opportunities

- T001, T002, T003 (Foundational) can run in parallel.
- T013 (US2 test) can be written in parallel with US1 implementation once T004 lands.
- T020, T021 (docs) can run in parallel with any implementation phase.
- Once Foundational (Phase 1) completes, US1, US2, and US3 implementation can proceed in parallel (different concerns in the same files — coordinate merge order, since T006/T014/T018 all touch `apply-fixes.ts` and `plan.ts`/`apply-plan.ts` respectively but not the same lines).

---

## Execution Wave DAG

```text
Wave 1 (no dependencies):
  T001 [P] Add applyBiddingGuardQuery
  T003 [P] Add bidding field to ResolvedPlanGroup/PlanSections
  T020 [P] Update reference/update.md
  T021 [P] Update reference/audit.md

Wave 2 (T001 done):
  T002 [P] builders.test.ts for applyBiddingGuardQuery (depends on T001)
  T004 Add biddingGuardState fetch fn (depends on T001)

Wave 3 (T003, T004 done):
  T005 Wire bidding section into main() (depends on T004, T003)

Wave 4 (T005 done — US1/US2/US3 implementation begins in parallel):
  T006 [US1] Bidding staging in applyPlanToBrief (depends on T003)
  T008 [US1] Bidding action-string line (depends on T005)
  T013 [P] [US2] biddingErrors tests written first (depends on T004)
  T014 [US2] biddingErrors validator (depends on T004)
  T018 [US3] Ceiling-sanity warning pass (depends on T005)

Wave 5:
  T007 [P] [US1] apply-plan.test.ts staging tests (depends on T006)
  T009 [US1] Bidding mutation step (depends on T006, T005)
  T012 [US1] CampaignSchema reuse regression test (depends on T006)
  T015 [US2] Wire biddingErrors into validate() (depends on T014)
  T019 [US3] apply-fixes.test.ts warning tests (depends on T018)

Wave 6:
  T010 [US1] Verify/extend oneof-clearing behavior (depends on T009)
  T016 [US2] Wire validate() call site with biddingGuardState (depends on T015, T005)

Wave 7:
  T011 [US1] apply-fixes.test.ts end-to-end mutation test (depends on T009)
  T017 [US2] apply-fixes.test.ts refusal/override tests (depends on T016, T013)

Wave 8:
  T022 Full test suite + typecheck + lint (depends on T010, T011, T012, T017, T019)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational.
2. Complete Phase 2: User Story 1.
3. **STOP and VALIDATE**: run US1's tests, confirm a `bidding` entry stages, diffs, and applies correctly against a fake `AdsClient`.
4. This alone closes the audit → update loop for the motivating case in the issue.

### Incremental Delivery

1. Foundational → Foundation ready.
2. US1 → Test independently → the core lever exists.
3. US2 → Test independently → the risky direction is guarded.
4. US3 → Test independently → the ceiling-sanity warning is visible.
5. Polish (docs) → close out FR-008/FR-009.

---

## Notes

- [P] tasks = can run in parallel with other ready tasks once any listed dependencies are satisfied.
- (depends on ...) = explicit dependency on earlier task IDs; omitted where a task has no explicit dependency beyond phase ordering.
- Tests are written before their corresponding implementation task within each story (T013 before T014/T015; existing test files extended alongside their implementation task otherwise, since most of this feature extends already-tested functions rather than introducing new ones from scratch).
- Commit after each task or logical group, consistent with the commits already made for spec.md/plan.md on this branch.
