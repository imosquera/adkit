# Feature Specification: Full bid-strategy lever (target-CPA / target-ROAS) via `ads.sh update`

**Feature Branch**: `048-bid-strategy-lever`

**Created**: 2026-08-01

**Status**: Draft

**Input**: User description: "ads.sh update: add a bidStrategy lever to the plan schema, so a campaign's bid strategy can be graduated (e.g. maximize-clicks → maximize-conversions) without going through the UI — extended to the full 4-strategy set (maximize-clicks, maximize-conversions, target-cpa, target-roas), idempotent skip-if-unchanged, and a loud warning + distinct envelope key whenever a change affects spend optimization."

## Clarifications

### Session 2026-08-01

- Q: Should this feature use a new `bidStrategy` plan section key, or extend the existing `bidding` section key already shipped in PR #60? → A: Extend the existing `bidding` key — a second, differently-named section for the same concept would duplicate plan-parsing/staging logic and confuse operators.
- Q: For graduating a campaign into a spend-optimizing strategy on low trailing-30d conversion volume, should the system hard-refuse or warn-only? → A: Warn-only, via the same spend-affecting `WARNING:` + envelope key already required for any change into these strategies — no separate volume-based block. A hard block on graduating up would contradict the sibling downgrade-only guardrail precedent.
- Q: What shape does the spend-affecting envelope key take? → A: An array of affected campaign IDs, matching the `enableStartsLiveSpend`/`searchPartnersEnableIncreasesReach` precedent.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Graduate a campaign onto target-CPA or target-ROAS (Priority: P1)

An operator has a campaign that has proven itself on `maximize-conversions` and
is ready to graduate to a stricter, goal-based Smart Bidding strategy —
`target-cpa` (with a target cost-per-acquisition) or `target-roas` (with a
target return on ad spend) — without leaving the terminal for the Google Ads
UI.

**Why this priority**: This is the actual motivating gap this feature closes.
The existing `bidding` lever (shipped separately) only covers the
`maximize-clicks` ↔ `maximize-conversions` pair; without target-CPA/ROAS
support, graduating a campaign further still dead-ends in the UI exactly the
way the original bid-strategy edit gap did.

**Independent Test**: Add a bidding entry for a campaign currently on
`maximize-conversions` with `strategy: target-cpa` and `targetCpaMicros` set,
run `ads.sh update` in dry-run, confirm the diff shows the staged bid-strategy
and target-value change plus the spend-affecting warning, then run with
`--apply` and confirm the live campaign's bid strategy and target value match
the plan.

**Acceptance Scenarios**:

1. **Given** an update plan entry moving a campaign from `maximize-conversions`
   to `target-cpa` with a `targetCpaMicros` value, **When** an operator runs
   `ads.sh update` without `--apply`, **Then** the command prints a diff
   showing the strategy and target-value change and does not touch the live
   account.
2. **Given** the same plan, **When** the operator re-runs `ads.sh update
   --apply`, **Then** the live campaign's bid strategy and target value match
   the plan, and the staged adbrief file reflects the new values.
3. **Given** an equivalent plan entry using `strategy: target-roas` and
   `targetRoas` instead, **When** the operator runs the same dry-run/apply
   sequence, **Then** the outcome mirrors Scenario 1 and 2 for the ROAS target.

---

### User Story 2 - Loud warning whenever a change affects spend optimization (Priority: P1)

An operator (or an unattended script driven by an audit recommendation)
submits a bid-strategy change that moves a campaign into
`maximize-conversions`, `target-cpa`, or `target-roas` — any strategy that
lets the platform optimize toward spend/conversions rather than clicks. This
is never a silent, routine edit: it changes how the campaign spends money and
can behave unpredictably on low conversion volume.

**Why this priority**: This is the safety property the issue exists to
enforce — the same "loud, not silent" treatment already given to
`enableStartsLiveSpend` and `searchPartnersEnableIncreasesReach`. Without it,
a bid-strategy graduation could quietly destabilize spend on a low-volume
campaign.

**Independent Test**: Submit a plan entry changing a campaign's strategy from
`maximize-clicks` to `maximize-conversions` (or to `target-cpa`/`target-roas`),
run `ads.sh update` in dry-run, and confirm the output includes a `WARNING:`
line and a distinct, machine-readable envelope key marking the change as
spend-affecting. Submit a plan entry that leaves the strategy unchanged, or
that downgrades to `maximize-clicks`, and confirm neither the warning nor the
envelope key appears.

**Acceptance Scenarios**:

1. **Given** a campaign moving into `maximize-conversions`, `target-cpa`, or
   `target-roas` from any other strategy, **When** an operator runs `ads.sh
   update` (dry-run or `--apply`), **Then** the output includes a `WARNING:`
   line calling out that the change affects spend optimization, and the
   command's structured output envelope includes a distinct key identifying
   which campaigns triggered it.
2. **Given** a campaign whose plan entry sets `strategy` to the campaign's
   current live strategy (no actual change), **When** the operator runs `ads.sh
   update`, **Then** no warning or spend-affecting envelope key is produced for
   that entry.
3. **Given** a campaign downgrading to `maximize-clicks` from any other
   strategy, **When** the operator runs `ads.sh update`, **Then** the change is
   accepted with no spend-affecting warning (mirrors the existing
   always-safe-to-pause precedent).

---

### User Story 3 - Idempotent re-runs report "skipped," not re-mutated (Priority: P2)

An operator re-runs the same update plan (e.g. as part of a repeatable script
or CI-style check) after a bid-strategy change has already been applied. The
campaign is already on the target strategy; the tool should recognize this and
report the entry as skipped rather than re-issuing a live mutation or
re-triggering the spend-affecting warning.

**Why this priority**: This is the same idempotency contract every other
lever in `ads.sh update` (`campaignStatus`, `adGroupStatus`) already
guarantees. Without it, safe re-runs of a plan become unpredictable —
re-applying a no-op edit, or worse, re-surfacing a warning for a change that
isn't actually happening.

**Independent Test**: Apply a bid-strategy plan entry once (`--apply`), then
run the exact same plan again. Confirm the second run reports that entry as
skipped, issues no live mutation for it, and produces no spend-affecting
warning for it.

**Acceptance Scenarios**:

1. **Given** a campaign already on `target-cpa` with a matching target value,
   **When** an operator submits a plan entry for that same campaign and
   strategy, **Then** `ads.sh update` reports the entry as skipped and makes no
   live mutation.
2. **Given** a campaign already on `target-cpa` but with a *different* target
   value than the plan requests (e.g. a changed `targetCpaMicros`), **When**
   the operator runs the plan, **Then** the system treats this as a real
   change (not a skip) and applies the new target value, subject to the same
   spend-affecting warning treatment as a strategy change.

---

### Edge Cases

- What happens when a `target-cpa`/`target-roas` entry's target value
  (`targetCpaMicros`/`targetRoas`) is present but the strategy field doesn't
  match it, or vice versa? The existing cross-field schema validation already
  rejects mismatched strategy/target-field pairings and must continue to do so
  unchanged.
- What happens when the plan includes multiple bid-strategy entries and one is
  refused or errors? The other, unrelated entries must still be eligible to
  apply — a single failed entry must not abort the whole update run (same
  precedent as the existing `bidding` guardrail).
- What happens when a low trailing-30-day conversion count makes a
  `maximize-conversions`/`target-cpa`/`target-roas` graduation especially
  risky? The change is allowed to proceed; the existing spend-affecting
  `WARNING:` (FR-004) is the only guard applied — there is no separate
  volume-based hard refusal for graduating up (see Clarifications).
- What happens when `--apply` is used but the account's live bid strategy has
  drifted out-of-band since the last audit? This follows the same
  staged-diff-then-apply precedent as `budgets`/`bidding`; no new conflict
  handling is introduced by this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The existing `bidding` plan section (shipped in PR #60) MUST
  accept all four bid strategies (`maximize-clicks`, `maximize-conversions`,
  `target-cpa`, `target-roas`), including `targetCpaMicros`/`targetRoas`
  target values, reusing the existing schema enum and cross-field validation
  rather than duplicating it or introducing a second, parallel plan section.
- **FR-002**: The system MUST read the campaign's live bid strategy (and
  target value, where applicable) before evaluating an entry, and MUST report
  an entry that requests the strategy (and target value) the campaign is
  already on as skipped, issuing no live mutation.
- **FR-003**: The system MUST treat a target-value-only change (same strategy,
  different `targetCpaMicros`/`targetRoas`) as a real, applyable change, not a
  skip.
- **FR-004**: Whenever an entry causes an actual live strategy change into
  `maximize-conversions`, `target-cpa`, or `target-roas`, the system MUST
  surface a `WARNING:` line in command output and add the campaign ID to a
  distinct, dedicated array-valued key in the structured output envelope
  (mirroring the `campaignId[]` shape of `enableStartsLiveSpend` and
  `searchPartnersEnableIncreasesReach`), regardless of the campaign's trailing
  conversion volume — no separate hard-refusal floor applies to graduating
  into these strategies.
- **FR-005**: A change that downgrades a campaign to `maximize-clicks` MUST
  NOT trigger the spend-affecting warning or envelope key, regardless of the
  originating strategy.
- **FR-006**: A bid-strategy entry MUST stage into the campaign's adbrief file
  and appear in the brief diff shown to the operator before it is applied,
  the same as the existing `bidding` lever.
- **FR-007**: A refused or failed bid-strategy entry MUST NOT prevent other,
  unrelated entries in the same update plan from being evaluated and applied.
- **FR-008**: Reference documentation (`reference/update.md`) MUST be updated
  to describe the full 4-strategy lever and its spend-affecting warning
  behavior, replacing any documentation that describes only the 2-strategy
  subset.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can graduate a campaign to `target-cpa` or
  `target-roas` using only `ads.sh update`, with zero required steps in the
  Google Ads UI.
- **SC-002**: 100% of bid-strategy changes run without `--apply` produce a
  dry-run diff only, with zero live account mutations.
- **SC-003**: 100% of live strategy changes into `maximize-conversions`,
  `target-cpa`, or `target-roas` produce both the `WARNING:` output line and
  the distinct envelope key, verified by an automated test.
- **SC-004**: 100% of plan entries requesting a campaign's already-current
  strategy and target value are reported as skipped with zero live mutations,
  verified by an automated test.
- **SC-005**: 0% of downgrade-to-`maximize-clicks` entries produce the
  spend-affecting warning or envelope key.
