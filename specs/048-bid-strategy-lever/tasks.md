# Tasks: Full bid-strategy lever (target-CPA / target-ROAS) via `ads.sh update`

**Input**: Design documents from `specs/048-bid-strategy-lever/` (`plan.md`, `spec.md`)

**Prerequisites**: `plan.md` (required), `spec.md` (required for user stories)

**Tests**: Included — the source issue explicitly requests tests alongside the
existing `apply-fixes.test.ts` coverage.

**Organization**: Tasks are grouped by user story (spec.md) to enable
independent implementation and testing of each story. No new files are
created anywhere — every task widens an existing module named in `plan.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files or non-overlapping regions,
  no dependency ordering)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Phase 1: Setup

**Purpose**: None required — this feature extends an existing, already-built
CLI (`skills/adkit/scripts`) with no new project, dependency, or tooling.
Proceed directly to Phase 2.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Widen the two choke points every user story depends on — which
strategies the `bidding` lever accepts, and what "already on this
strategy/target value" means — before any story-specific behavior is built
on top.

- [x] T001 Widen `BIDDING_PLAN_STRATEGIES` in `skills/adkit/scripts/src/fixes/plan.ts` from `new Set(["maximize-clicks", "maximize-conversions"])` to `new Set(BID_STRATEGIES)` (import `BID_STRATEGIES` from `../lib/schema.js`), and update the stale comment above it that says only two strategies are supported.
- [x] T002 Extend `BiddingLiveState` in `skills/adkit/scripts/src/fixes/plan.ts` with an optional normalized `targetValue?: number` field (the campaign's live `target_cpa_micros` when on `TARGET_CPA`, or live `target_roas` when on `TARGET_ROAS`, else `undefined`).
- [x] T003 Extend the GAQL query/row type backing `biddingGuardState` in `skills/adkit/scripts/src/bin/apply-fixes.ts` (`BiddingGuardRow`, `applyBiddingGuardQuery`) to select `campaign.target_cpa.target_cpa_micros` and `campaign.target_roas.target_roas`, and populate `targetValue` in the returned map per T002's normalization rule (depends on T002).
- [x] T004 Add a `biddingChanges`/`biddingSkips` partition step in `skills/adkit/scripts/src/bin/apply-fixes.ts`, placed alongside the existing `statusChanges`/`statusSkips` computation and *before* the `validate()` call: for each `bidding` plan block with known live state, compare `(strategy, targetCpaMicros ?? targetRoas ?? cpcBidCeilingMicros)` against `(biddingStrategyType, targetValue)`; equal on both → `biddingSkips`, otherwise (including unknown live state) → `biddingChanges` (depends on T001, T002, T003).
- [x] T005 Route only `biddingChanges` (not the raw `bidding` plan section) into `biddingErrors`'s existing call site and into the mutation loop in `skills/adkit/scripts/src/bin/apply-fixes.ts`, so a skipped entry never reaches the downgrade guardrail or issues a mutate call (depends on T004).

**Checkpoint**: `bidding` plan entries can now express all 4 strategies and
are correctly partitioned into real changes vs. no-op skips before any
mutation or warning logic runs.

---

## Phase 3: User Story 1 - Graduate a campaign onto target-CPA or target-ROAS (Priority: P1) 🎯 MVP

**Goal**: An operator can move a campaign onto `target-cpa` or `target-roas`
(with its target value) entirely through `ads.sh update`, dry-run then
`--apply`.

**Independent Test**: Add a `bidding` entry with `strategy: target-cpa` and
`targetCpaMicros` for a campaign currently on `maximize-conversions`; dry-run
shows the diff, `--apply` changes the live campaign's strategy and target
value and updates the staged adbrief.

- [x] T006 [P] [US1] Add `target-cpa`/`target-roas` mutation branches to the bidding apply loop in `skills/adkit/scripts/src/bin/apply-fixes.ts` (~line 1192): `target-cpa` → `{ target_cpa: { target_cpa_micros: b.targetCpaMicros } }`, `target-roas` → `{ target_roas: { target_roas: b.targetRoas } }`, alongside the existing `maximize-clicks`/else branches (depends on T005).
- [x] T007 [P] [US1] Forward `targetCpaMicros`/`targetRoas` from the last `bidding` block for a campaign onto the proposed `Brief.campaign` in `applyPlanToBrief`, `skills/adkit/scripts/src/adbriefs/apply-plan.ts`, mirroring how `cpcBidCeilingMicros` is forwarded today (depends on T001).
- [x] T008 [P] [US1] Unit test in `skills/adkit/scripts/src/fixes/plan.test.ts`: `biddingErrors` accepts `target-cpa` and `target-roas` blocks (previously rejected as unsupported) (depends on T001).
- [x] T009 [P] [US1] Staging test in `skills/adkit/scripts/src/adbriefs/apply-plan.test.ts`: a `target-cpa` (and separately a `target-roas`) `bidding` block stages `targetCpaMicros`/`targetRoas` onto the proposed `Brief.campaign` (depends on T007).
- [x] T010 [US1] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts` against a fake `AdsClient`: dry-run for a `target-cpa` entry shows the diff and issues zero mutate calls; `--apply` issues the `target_cpa` mutate op with the right fields; repeat for `target-roas` (depends on T006, T007).

**Checkpoint**: US1 is independently functional — target-CPA/ROAS
graduation works end-to-end via `ads.sh update`.

---

## Phase 4: User Story 2 - Loud warning whenever a change affects spend optimization (Priority: P1)

**Goal**: Any live change into `maximize-conversions`/`target-cpa`/
`target-roas` prints a `WARNING:` and populates a distinct
`bidStrategyChangeAffectsSpend` envelope key; a downgrade to
`maximize-clicks` never does.

**Independent Test**: Submit a `bidding` entry changing strategy into a
spend-optimizing strategy; confirm the `WARNING:` line and the envelope key
both appear. Submit a downgrade to `maximize-clicks`; confirm neither
appears.

- [x] T011 [US2] Add a spend-affecting warning loop in `skills/adkit/scripts/src/bin/apply-fixes.ts`, alongside the existing ceiling-sanity warning block (~line 975): for each entry in `biddingChanges` whose target `strategy` is in `{maximize-conversions, target-cpa, target-roas}`, print `WARNING: bid strategy change on campaign <id> affects spend optimization (-> <strategy>)` and collect the campaign ID (depends on T004).
- [x] T012 [US2] Add `bidStrategyChangeAffectsSpend` (campaign-ID array, from T011), `biddingChanges`, and `biddingSkipped` keys to `emitStatusEnvelope` in `skills/adkit/scripts/src/bin/apply-fixes.ts`, mirroring the existing `enableStartsLiveSpend`/`campaignStatusChanges`/`campaignStatusSkipped` shapes (depends on T004, T011).
- [x] T013 [P] [US2] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: a change into `maximize-conversions`, `target-cpa`, and `target-roas` (three cases) each print the `WARNING:` line and populate `bidStrategyChangeAffectsSpend` with the campaign ID (depends on T011, T012).
- [x] T014 [P] [US2] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: a downgrade to `maximize-clicks` (from any other strategy) produces no `WARNING:` line and does not populate `bidStrategyChangeAffectsSpend` (depends on T011, T012).
- [x] T015 [P] [US2] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: the existing `maximize-conversions`→`maximize-clicks` downgrade guardrail (30-conversion boundary, `acknowledgeStrategyDowngrade` override) still behaves identically after the T001/T004/T005 changes — no regression (depends on T005).

**Checkpoint**: US1 and US2 both independently functional — spend-affecting
changes are always loud, downgrades are always quiet, and the pre-existing
downgrade guardrail is provably unchanged.

---

## Phase 5: User Story 3 - Idempotent re-runs report "skipped," not re-mutated (Priority: P2)

**Goal**: Re-running a plan against a campaign already on the target
strategy/target-value reports the entry as skipped, with zero live mutation
and no spend-affecting warning; a target-value-only change is still treated
as a real, applied change.

**Independent Test**: Apply a `bidding` entry once, then re-run the identical
plan; confirm the second run reports the entry skipped and issues no mutate
call for it.

- [x] T016 [US3] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: a `bidding` entry matching the campaign's current live strategy and target value is placed in `biddingSkipped`, issues zero mutate calls, and produces no spend-affecting warning (depends on T004, T005, T011, T012).
- [x] T017 [US3] End-to-end test in `skills/adkit/scripts/src/bin/apply-fixes.test.ts`: a `bidding` entry with the same `strategy` as the live campaign but a *different* `targetCpaMicros`/`targetRoas`/`cpcBidCeilingMicros` is placed in `biddingChanges` (not skipped), is applied, and (when the strategy is spend-optimizing) still triggers the spend-affecting warning per FR-004 (depends on T004, T005, T011, T012).

**Checkpoint**: All three user stories independently functional and tested.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final verification.

- [x] T018 [P] Rewrite the `bidding` paragraph (~line 105) in `skills/adkit/reference/update.md` to describe all four strategies, the idempotent-skip behavior, and the `bidStrategyChangeAffectsSpend` warning — replacing the current text describing only `maximize-clicks`/`maximize-conversions`.
- [x] T019 Run `npm run typecheck` and `npx vitest run` from `skills/adkit/scripts` and confirm a clean pass with all new tests included (depends on T001-T017).

---

## Dependencies & Execution Order

- **Phase 2 (Foundational)** blocks all user stories — T001-T005 must
  complete first.
- **User Story 1 (P1)** depends only on Foundational; delivers the MVP.
- **User Story 2 (P1)** depends only on Foundational (specifically T004's
  partition); independent of US1's mutation-branch work, but both are P1 and
  should ship together for the feature to be complete.
- **User Story 3 (P2)** depends on Foundational (T004/T005) and on US2's
  warning/envelope wiring (T011/T012) for its own tests to assert
  "no warning on skip" — implemented last.
- **Polish** depends on all user stories being complete.

## Execution Wave DAG

```
Wave 1 (parallel): T001, T002
Wave 2 (parallel): T003 (needs T002)
Wave 3:            T004 (needs T001, T002, T003)
Wave 4:            T005 (needs T004)
Wave 5 (parallel): T006 (needs T005), T007 (needs T001), T008 (needs T001),
                   T011 (needs T004)
Wave 6 (parallel): T009 (needs T007), T010 (needs T006, T007),
                   T012 (needs T004, T011)
Wave 7 (parallel): T013 (needs T011, T012), T014 (needs T011, T012),
                   T015 (needs T005), T016 (needs T004, T005, T011, T012),
                   T017 (needs T004, T005, T011, T012)
Wave 8 (parallel): T018, T019 (needs T001-T017)
```

## Implementation Strategy

**MVP first**: Phase 2 (Foundational) + Phase 3 (US1) alone delivers a
working target-CPA/target-ROAS graduation lever — the actual motivating gap.
Phases 4 and 5 (warning/envelope, idempotency) harden it to match the
issue's full safety contract before the draft PR is opened; both are small
enough, and coupled enough to Phase 2's partition step, that shipping them
in the same PR (rather than as follow-ups) is the right scope for this
change.
