# Feature Specification: Bid-strategy edits via `ads.sh update`

**Feature Branch**: `046-bid-strategy-edits`

**Created**: 2026-08-01

**Status**: Draft

**Input**: User description: "ads.sh update: allow bid-strategy edits (maximize-conversions → maximize-clicks + CPC ceiling)"

## Clarifications

### Session 2026-08-01

- Q: What mechanism authorizes the risky `maximize-conversions` → `maximize-clicks` downgrade on a campaign with ≥30 trailing-30-day conversions — a global CLI flag or a per-entry plan field? → A: A per-entry plan field (`acknowledgeStrategyDowngrade: true` on the `bidding` entry). No existing `--force-*` precedent exists in this codebase (the `budgets` guard is a hard, non-overridable cap), and a global flag would silently authorize every risky entry in a multi-campaign plan run.
- Q: What time window / data source backs "conversions in trailing 30 days" (guardrail) and "current average CPC" (ceiling-sanity warning)? → A: The same trailing-30-day Ads API metrics query pattern the audit command already uses for `bidding_strategy_type` context, so the guard's threshold matches what the operator saw in the audit that prompted the change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reverse a stalled Smart Bidding campaign back to Maximize Clicks (Priority: P1)

An operator runs `/adkit audit` on a live campaign and gets a recommendation to
drop the campaign from `maximize-conversions` back to `maximize-clicks` with a
CPC ceiling, because the campaign doesn't have enough conversion volume to
support Smart Bidding (cold-start throttle). Today every other audit
recommendation is applyable through `ads.sh update`, but this one dead-ends —
the operator has to make the change by hand in the Google Ads UI, breaking the
audit → update loop.

**Why this priority**: This is the actual motivating case and the core value of
the feature — without it, the feature doesn't exist. It's the only path that
turns an audit recommendation into an applied change.

**Independent Test**: Add a `bidding` entry to an update plan for a campaign
currently on `maximize-conversions` with `strategy: maximize-clicks` and a
`cpcBidCeilingMicros` value, run `ads.sh update` in dry-run, confirm the diff
shows the staged `campaign.bidStrategy` / `campaign.cpcBidCeilingMicros`
change, then run with `--apply` and confirm the live campaign's bid strategy
and CPC ceiling match the plan.

**Acceptance Scenarios**:

1. **Given** an update plan with a `bidding` entry for a campaign on
   `maximize-conversions` with fewer than 30 conversions in the trailing 30
   days, **When** an operator runs `ads.sh update` without `--apply`, **Then**
   the command prints a diff showing the campaign's `bidStrategy` changing to
   `maximize-clicks` and `cpcBidCeilingMicros` being set, and makes no live
   change.
2. **Given** the same plan, **When** the operator re-runs `ads.sh update
   --apply`, **Then** the live campaign's bid strategy becomes Maximize Clicks
   with the specified CPC bid ceiling, and the staged adbrief file reflects the
   new values.
3. **Given** an update plan with a `bidding` entry that sets
   `cpcBidCeilingMicros` on a campaign already on `maximize-clicks` (ceiling-only
   adjustment, no strategy change), **When** the operator runs `ads.sh update`,
   **Then** the command accepts the change and stages/applies it the same way,
   with no guardrail triggered (the guardrail only applies to a strategy
   change).

---

### User Story 2 - Guardrail blocks an accidental downgrade off proven Smart Bidding (Priority: P2)

An operator (or a script consuming audit output) attempts to move a campaign
from `maximize-conversions` to `maximize-clicks`, but the campaign already has
strong, established conversion volume. Dropping Smart Bidding here would be a
regression, not a fix. The system should refuse this specific, risky direction
by default.

**Why this priority**: Without this guardrail, the feature this issue exists to
add could itself cause the same class of harm the `budgets` guardrail already
prevents for spend changes — an unattended or careless update silently
undoing a campaign's Smart Bidding graduation.

**Independent Test**: Build an update plan that changes a campaign with ≥30
conversions in the trailing 30 days from `maximize-conversions` to
`maximize-clicks` with no override present; run `ads.sh update` and confirm it
refuses the change with a clear message, then re-run with the override present
and confirm it proceeds.

**Acceptance Scenarios**:

1. **Given** a campaign with 30 or more conversions in the trailing 30 days
   currently on `maximize-conversions`, **When** an operator submits a
   `bidding` entry changing it to `maximize-clicks` without the override,
   **Then** `ads.sh update` refuses the change for that campaign, leaves it out
   of the applied diff, and explains why (conversion count and threshold).
2. **Given** the same campaign and plan, **When** the operator adds
   `acknowledgeStrategyDowngrade: true` to that `bidding` entry, **Then**
   `ads.sh update` accepts and stages/applies the change like any other
   bidding edit.
3. **Given** a campaign currently on `maximize-clicks` moving to
   `maximize-conversions` (graduating up), **When** an operator submits that
   change regardless of conversion count, **Then** `ads.sh update` accepts it
   without requiring the override — the guard only applies to the downgrade
   direction.

---

### User Story 3 - Ceiling-sanity warning on dry run (Priority: P3)

An operator sets a `cpcBidCeilingMicros` value that is lower than the
campaign's actual recent average CPC. This wouldn't fail validation (it's a
valid, if risky, value) but would likely starve the campaign of traffic. The
dry-run output should call this out so the operator can catch it before
applying.

**Why this priority**: This is a safety nicety, not core functionality — the
feature is usable without it (User Story 1) and the risky-direction guard
(User Story 2) covers the higher-severity mistake. This is about catching a
self-inflicted misconfiguration, not preventing an app-level guardrail
violation.

**Independent Test**: Submit a `bidding` entry with a `cpcBidCeilingMicros`
below the campaign's current average CPC, run `ads.sh update` in dry-run, and
confirm the output includes a visible warning comparing the two values. Submit
one at or above the average CPC and confirm no warning appears.

**Acceptance Scenarios**:

1. **Given** a campaign whose current average CPC is higher than the proposed
   `cpcBidCeilingMicros`, **When** an operator runs `ads.sh update` in dry-run,
   **Then** the output includes a warning showing both the proposed ceiling and
   the campaign's current average CPC, and the command still proceeds (this is
   a warning, not a block).
2. **Given** a campaign whose current average CPC is at or below the proposed
   `cpcBidCeilingMicros`, **When** an operator runs `ads.sh update` in dry-run,
   **Then** no ceiling-sanity warning is shown.

---

### Edge Cases

- What happens when a `bidding` entry sets `cpcBidCeilingMicros` on a campaign
  targeted for `maximize-conversions` (a strategy that doesn't use a CPC
  ceiling)? The existing cross-field schema rule already rejects this
  combination and must continue to do so unchanged.
- What happens at the exact 30-conversion boundary (trailing 30 days)? 30
  conversions counts as "has proven volume" and requires the override; 29 does
  not.
- What happens when a `bidding` entry references a campaign ID that doesn't
  exist in the account, or that the current adbrief doesn't recognize? The
  command must fail that entry the same way other update-plan sections already
  fail on an unknown campaign reference, without partially applying other
  entries.
- What happens when the plan includes multiple `bidding` entries, one of which
  is refused by the guardrail? The other, unrelated entries must still be
  eligible to apply — a single refused entry must not abort the whole update
  run.
- What happens when `--apply` is used but the account's live bid strategy has
  already changed out-of-band since the last audit (drift between the staged
  adbrief and the live account)? This follows the same staged-diff-then-apply
  precedent as `budgets`; no new conflict handling is introduced by this
  feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The update plan format MUST support a `bidding` section listing
  per-campaign bid-strategy edits (`campaignId`, `strategy`, optional
  `cpcBidCeilingMicros`), gated by the same dry-run-by-default /
  `--apply`-required flow as the existing `budgets` section.
- **FR-002**: The system MUST validate `bidding` entries using the existing
  schema rule that `cpcBidCeilingMicros` is only valid when `strategy` is
  `maximize-clicks`, rather than duplicating that validation logic.
- **FR-003**: A `bidding` edit MUST stage into the campaign's adbrief file
  (`campaign.bidStrategy` / `campaign.cpcBidCeilingMicros`) and appear in the
  brief diff shown to the operator before it is applied.
- **FR-004**: The system MUST refuse a `bidding` entry that changes a campaign
  from `maximize-conversions` to `maximize-clicks` when that campaign has 30 or
  more conversions in the trailing 30 days (per the audit command's existing
  trailing-30-day metrics query), unless the entry sets
  `acknowledgeStrategyDowngrade: true`.
- **FR-005**: The system MUST NOT apply the conversion-count guard in FR-004 to
  the reverse direction (`maximize-clicks` → `maximize-conversions`); that
  direction requires no override regardless of conversion count.
- **FR-006**: When a `bidding` entry's `cpcBidCeilingMicros` is below the
  campaign's current average CPC (sourced via the same trailing-30-day metrics
  query used for FR-004), the dry-run output MUST include a warning comparing
  the proposed ceiling to the current average CPC, without blocking the
  change.
- **FR-007**: A refused `bidding` entry (per FR-004) MUST NOT prevent other,
  unrelated entries in the same update plan (bidding or otherwise) from being
  evaluated and applied.
- **FR-008**: Reference documentation (`reference/update.md`) MUST be updated
  to describe the new `bidding` lever, replacing the current statement that bid
  strategy is not editable through `ads.sh update`.
- **FR-009**: Reference documentation (`reference/audit.md`) MUST mention the
  new `bidding` update lever alongside its existing cold-start / rank-
  constrained recommendation guidance, so an audit finding points the operator
  at the fix command.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can take an audit's cold-start recommendation
  (downgrade to Maximize Clicks with a CPC ceiling) from finding to applied
  change using only `ads.sh update`, with zero required steps in the Google
  Ads UI.
- **SC-002**: 100% of `bidding` changes run without `--apply` produce a dry-run
  diff only, with zero live account mutations.
- **SC-003**: 100% of attempted `maximize-conversions` → `maximize-clicks`
  changes on campaigns with ≥30 trailing-30-day conversions are refused unless
  the override is explicitly supplied, verified by an automated test.
- **SC-004**: 100% of dry runs where the proposed CPC ceiling is below the
  campaign's current average CPC display the comparison warning, verified by
  an automated test.
