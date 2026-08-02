# Implementation Plan: Full bid-strategy lever (target-CPA / target-ROAS) via `ads.sh update`

**Branch**: `048-bid-strategy-lever` | **Date**: 2026-08-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/048-bid-strategy-lever/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Extend the existing `bidding` plan section (`bin/apply-fixes.ts` / `fixes/plan.ts`,
shipped in PR #60) from its current 2-strategy subset
(`maximize-clicks`/`maximize-conversions`) to the full 4-strategy
`BID_STRATEGIES` set (`schema.ts`), adding `target-cpa`/`target-roas` with
their `targetCpaMicros`/`targetRoas` companion values. Two behavior changes on
top of the existing lever: (1) idempotent skip — read the campaign's live
strategy/target value first, and report a plan entry that requests the
strategy the campaign is already on (with a matching target value) as
skipped, not re-mutated; (2) a loud, non-blocking `WARNING:` line plus a new
`bidStrategyChangeAffectsSpend` (campaign-ID array) envelope key on **any**
live change into `maximize-conversions`, `target-cpa`, or `target-roas`,
mirroring the `enableStartsLiveSpend`/`searchPartnersEnableIncreasesReach`
treatment. No separate volume-based hard refusal is added for graduating up
(see spec Clarifications) — the existing downgrade-only guardrail
(`biddingErrors`, `CONVERSION_GUARD_THRESHOLD`) is unchanged.

## Technical Context

**Language/Version**: TypeScript 5.7 (Node >=24)

**Primary Dependencies**: `google-ads-api` SDK, `zod`, `yaml`

**Storage**: Adbriefs on disk (`adbriefs/<slug>.yaml`), staged/diffed/written
by the existing `apply-plan.ts` / `store.ts` pipeline — unchanged mechanism,
new strategies flow through it exactly as `maximize-clicks`/
`maximize-conversions` already do.

**Testing**: vitest — `fixes/plan.test.ts` (pure `biddingErrors`/idempotency
unit tests), `bin/apply-fixes.test.ts` (fake-`AdsClient` end-to-end plan
runs), `adbriefs/apply-plan.test.ts` (bidding staging into a `Brief`,
including `targetCpaMicros`/`targetRoas`).

**Target Platform**: Node CLI (`ads.sh update` / `apply-fixes` bin)

**Project Type**: CLI (single project, `skills/adkit/scripts/`)

**Performance Goals**: N/A — reuses the existing `biddingGuardState` fetch
(one GAQL query per `update` run); no new query added.

**Constraints**: Must not change behavior for any existing `bidding` plan
entry that only ever used `maximize-clicks`/`maximize-conversions` (PR #60's
guardrail, ceiling-sanity warning, and mutation shape for those two
strategies are unchanged); the idempotency check must not weaken the existing
downgrade guardrail (a same-strategy "skip" must never bypass
`acknowledgeStrategyDowngrade` logic, since a skip by definition means no
strategy change is happening).

**Scale/Scope**: Extends three existing functions/constants
(`BIDDING_PLAN_STRATEGIES`, `biddingErrors`, the `bin/apply-fixes.ts` mutation
loop) and one existing envelope emitter (`emitStatusEnvelope`); adds one new
idempotency check ahead of the existing guardrail check. No new files, no new
GAQL query, no new schema.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled
`speckit init` template — confirmed via
`python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py list`,
which reports zero matched principle headings (same result as the sibling
`046-bid-strategy-edits` plan).

**No constitution defined** — there are no real principles to check against.
The repo's actual binding conventions live in `/Users/iam/Code/adkit/CLAUDE.md`
(functional style: pure functions, immutable data, no classes for logic;
parse-don't-validate: parse untrusted input once at the boundary, don't
re-validate downstream) and are honored via the `## Parse Boundaries` section
below: the idempotency check and the widened `biddingErrors` set membership
stay pure `(blocks, liveState) -> string[] | boolean` functions with no I/O,
same as the existing `budgetsErrors`/`biddingErrors` pattern; the only new I/O
is reading fields already present in the existing `biddingGuardState` fetch
(no new network call).

## Project Structure

### Documentation (this feature)

Under the `spec-minimal` preset, the feature directory contains only:

```text
specs/048-bid-strategy-lever/
├── spec.md
├── plan.md               # this file — includes the Research and Data Model
│                          #   content that would otherwise live in
│                          #   research.md / data-model.md
├── tasks.md               # Phase 2 output (/speckit-tasks — not this command)
└── checklists/
    └── requirements.md
```

`research.md`, `data-model.md`, and `contracts/` are not created — Phase 0
below folds the (small) research findings inline, and there is no external
interface contract (no new public API, only widening an existing internal
plan-section's accepted values and CLI output).

### Source Code (repository root)

```text
skills/adkit/scripts/
├── src/
│   ├── fixes/
│   │   ├── plan.ts              # BIDDING_PLAN_STRATEGIES -> all 4 BID_STRATEGIES;
│   │   │                        #   BiddingLiveState gains targetCpaMicros/targetRoas;
│   │   │                        #   biddingErrors gains the idempotent-skip check
│   │   │                        #   (returns a skip signal, not just error strings —
│   │   │                        #   see Phase 1 for the exact shape change)
│   │   └── plan.test.ts         # + tests for target-cpa/target-roas acceptance,
│   │                             #   idempotent skip, target-value-only change
│   ├── bin/
│   │   ├── apply-fixes.ts       # + bidStrategyChangeAffectsSpend envelope key;
│   │   │                        #   biddingGuardState reads targetCpaMicros/targetRoas;
│   │   │                        #   mutation loop gains target_cpa/target_roas branches
│   │   │                        #   and an idempotent-skip branch (no mutate call)
│   │   └── apply-fixes.test.ts  # + end-to-end tests: target-cpa/target-roas apply,
│   │                             #   skip-when-unchanged, warning+envelope-key on change
│   └── (no new files — every change extends an existing module)
└── ../reference/update.md       # `bidding` paragraph (line ~105) rewritten for the
                                   #  full 4-strategy set and the spend-affecting warning
```

**Structure Decision**: Single project, no new files. Every change widens an
existing module in its existing role — this is additive to the `bidding`
lever PR #60 already established, not a new subsystem.

### Phase 0: Research

Findings from reading the existing `bidding` lever code (no `research.md`
needed — this is locating the right extension points, not external research):

- **`BIDDING_PLAN_STRATEGIES` (`fixes/plan.ts:548`) is the single choke point
  that currently rejects `target-cpa`/`target-roas`** with the explicit
  comment "a legitimate-but-unsupported `BidStrategy` like `target-cpa`" —
  this is precisely the gap this feature closes. Widening it to
  `new Set(BID_STRATEGIES)` (importing `BID_STRATEGIES` from `../lib/schema.js`,
  already exported) is the FR-001 change; the schema-level
  `targetCpaMicros`/`targetRoas` companion-field validation (`schema.ts`
  lines ~226-252) is already reused for free the same way
  `cpcBidCeilingMicros`/`maximize-clicks` pairing is today (staged brief
  re-parsed through `CampaignSchema.superRefine` in `stageResolvedGroups`).
- **`BiddingLiveState` (`fixes/plan.ts:537-540`) only carries
  `biddingStrategyType`/`conversions30d`.** The idempotency check (FR-002)
  needs the campaign's live target value too, so `biddingGuardState`
  (`bin/apply-fixes.ts:342`) and its `BiddingGuardRow`/query need a third
  field. The existing `applyBiddingGuardQuery` already selects
  `campaign.bidding_strategy_type`; the Google Ads API exposes the live
  target value on the same `campaign` resource as
  `campaign.target_cpa.target_cpa_micros` / `campaign.target_roas.target_roas`
  (oneof-nested, mirroring how `bidStrategyFields` in `ads/entities.ts`
  already writes those same oneof branches on create). Add both as optional
  selected fields (only one will be populated depending on the live
  strategy) and surface them as a single normalized
  `targetValue: number | undefined` on `BiddingLiveState`/`BiddingGuardRow`
  (a `target-cpa` campaign's target value is `target_cpa_micros`, a
  `target-roas` campaign's is `target_roas` — same unit-less "the number that
  matters for this strategy" concept, compared against the plan entry's
  `targetCpaMicros`/`targetRoas` after strategy-appropriate selection).
- **The idempotency check must run *before* the existing downgrade guardrail
  check in `biddingErrors`,** and its result must be visible to the caller as
  more than a validation error — today `biddingErrors` only returns
  `string[]` (errors), consumed by `validate()`'s aggregate array. A "skip"
  is not an error; it needs to reach the mutation loop
  (`bin/apply-fixes.ts` ~line 1188) and the envelope
  (`emitStatusEnvelope`) as a distinct, successful outcome, exactly the way
  `campaignStatus`'s existing `statusSkips` vs `statusChanges` split already
  works (`bin/apply-fixes.ts`, `statusChanges`/`statusSkips` computed ahead
  of `validate()`, same shell). The right shape: compute
  `biddingSkips`/`biddingChanges` (partition `section(plan, "bidding")` by
  "does live state already match strategy + target value") in
  `bin/apply-fixes.ts` alongside where `statusChanges`/`statusSkips` are
  already computed, *before* calling `validate()` — then pass only
  `biddingChanges` into `biddingErrors`/the mutation loop, so a skipped entry
  never reaches the guardrail or the mutate call, and `biddingSkips` feeds a
  new envelope key the same way `campaignStatusSkipped` already does. This
  keeps `biddingErrors` itself a pure function over blocks that are already
  known to represent a real change — no new "skip" return variant needed
  inside it.
- **The spend-affecting warning (FR-004) reuses the existing `WARNING:`
  printing pattern** (`bin/apply-fixes.ts` ~line 975-996, where the
  ceiling-sanity warning already lives) — a new loop over `biddingChanges`
  (the partitioned real-change list above) that checks whether the *new*
  `strategy` is in `{maximize-conversions, target-cpa, target-roas}`, prints
  `WARNING: bid strategy change on campaign <id> affects spend optimization
  (-> <strategy>)`, and collects the campaign ID for the new
  `bidStrategyChangeAffectsSpend` envelope key (array-of-campaignId shape,
  matching `enableStartsLiveSpend`).
- **The update-mutation loop (`bin/apply-fixes.ts` ~line 1192-1207) currently
  has only two branches** (`maximize-clicks` → `target_spend`, else →
  `maximize_conversions`). It needs two more branches:
  `target-cpa` → `{ target_cpa: { target_cpa_micros: b.targetCpaMicros } }`,
  `target-roas` → `{ target_roas: { target_roas: b.targetRoas } }` — the same
  oneof-swap mechanism the existing comment already documents ("the API
  models bid strategy as a oneof, so sending one branch clears whichever the
  campaign previously had"). This needs the same SDK smoke-check flagged in
  PR #60's plan (does `google-ads-api` clear the previous oneof branch
  automatically) — the risk is identical and already accepted for the
  `maximize-clicks`/`maximize-conversions` pair, so no new risk class is
  introduced, only two more codepaths through the same mechanism.

### Phase 1: Design

**Data flow** (extends `bidding`, unchanged plan format shape):

1. **Plan format** — the existing `bidding` array gains two new valid
   `strategy` values and their target fields:
   ```yaml
   bidding:
     - campaignId: 24057685583
       strategy: target-cpa
       targetCpaMicros: 12000000     # $12.00 target CPA
     - campaignId: 24057685584
       strategy: target-roas
       targetRoas: 3.5               # 350% target ROAS
   ```
2. **Fetch** (`bin/apply-fixes.ts`): `biddingGuardState` extends its query
   and return type to include the live target value, normalized per the live
   strategy (`target_cpa.target_cpa_micros` when live strategy is
   `TARGET_CPA`, `target_roas.target_roas` when `TARGET_ROAS`, else
   `undefined`).
3. **Partition** (`bin/apply-fixes.ts`, new step ahead of `validate()`,
   mirroring `campaignStatus`'s `statusChanges`/`statusSkips` split): for
   each `bidding` block, compare `(strategy, targetCpaMicros ?? targetRoas)`
   against the live `(biddingStrategyType, targetValue)`. Equal on both →
   `biddingSkips`; otherwise → `biddingChanges`. Only campaigns with a known
   live state can be compared; an unknown campaign ID falls through to
   `biddingChanges` so the existing "no current bidding state found" error in
   `biddingErrors` still fires for it (FR-002 doesn't apply to campaigns the
   guard has no live state for — that's an existing error case, not a new
   skip case).
4. **Validate** (`fixes/plan.ts`): `biddingErrors` runs over `biddingChanges`
   only (never `biddingSkips`), with `BIDDING_PLAN_STRATEGIES` widened to all
   four `BID_STRATEGIES`. The existing downgrade guardrail
   (`maximize-conversions` → `maximize-clicks` at ≥30 conversions) is
   unchanged and continues to apply only to that specific pair — a plan entry
   graduating into `target-cpa`/`target-roas` is never guardrail-refused
   (FR-004's warning is the only guard for that direction, per spec
   Clarifications).
5. **Warn** (`bin/apply-fixes.ts`, extends the existing ceiling-sanity
   warning block): a new loop over `biddingChanges` where the target
   `strategy` is spend-optimizing (`maximize-conversions`/`target-cpa`/
   `target-roas`) prints the `WARNING:` line and accumulates campaign IDs for
   the envelope key. A downgrade to `maximize-clicks` is excluded by
   construction (its `strategy` value is never in the spend-optimizing set).
6. **Staging** (`adbriefs/apply-plan.ts`): unchanged mechanism —
   `applyPlanToBrief`'s existing `bidStrategy`/`cpcBidCeilingMicros` staging
   logic already reads whatever `strategy`/companion fields the last
   `bidding` block for a campaign carries; it needs to additionally forward
   `targetCpaMicros`/`targetRoas` onto the proposed `Brief.campaign`, mirroring
   how `cpcBidCeilingMicros` is forwarded today. The re-parse through
   `CampaignSchema.superRefine` (`stageResolvedGroups`) enforces the
   strategy/target-field pairing for free, same as before (FR-006).
7. **Apply** (`bin/apply-fixes.ts`): the mutation loop iterates
   `biddingChanges` (not the raw plan section, so a skipped entry issues zero
   mutate calls — FR-002), with two new branches for `target-cpa`/
   `target-roas` as described in Phase 0.
8. **Envelope** (`bin/apply-fixes.ts`, `emitStatusEnvelope`): two new keys —
   `biddingChanges: biddingChanges` (or a summarized form matching the style
   of `campaignStatusChanges`) and `biddingSkipped: biddingSkips`, plus
   `bidStrategyChangeAffectsSpend: <campaignId[] from step 5>` — mirroring
   `campaignStatusChanges`/`campaignStatusSkipped`/`enableStartsLiveSpend`
   exactly.
9. **Docs**: `reference/update.md` line ~105 (the `bidding` paragraph) is
   rewritten to describe all four strategies, the idempotent-skip behavior,
   and the spend-affecting warning — replacing the current text that
   describes only the `maximize-clicks`/`maximize-conversions` pair.

**Test plan**:
- `fixes/plan.test.ts`: `biddingErrors` accepts `target-cpa`/`target-roas`
  blocks (previously rejected); still rejects an unsupported/typo'd strategy;
  downgrade guardrail behavior (30-conversion boundary, override field)
  unchanged for the `maximize-conversions`→`maximize-clicks` pair.
- `bin/apply-fixes.test.ts`: end-to-end fake-`AdsClient` runs — `target-cpa`
  and `target-roas` each apply with the right mutate-op shape (SC-001);
  identical strategy+target-value plan entry is skipped with zero mutate
  calls (SC-004); a target-value-only change (same strategy) is treated as a
  real change and applied; any qualifying strategy change prints the
  `WARNING:` and populates `bidStrategyChangeAffectsSpend` (SC-003); a
  downgrade to `maximize-clicks` never populates that key (SC-005); dry-run
  produces zero live mutations (SC-002).
- `adbriefs/apply-plan.test.ts`: a `target-cpa`/`target-roas` `bidding` block
  stages `targetCpaMicros`/`targetRoas` onto the proposed `Brief`.

## Parse Boundaries

This is a TypeScript feature (`skills/adkit/scripts`, `.ts`).

1. **Trust boundaries**: no new trust boundary. The only I/O this feature
   touches is the existing `biddingGuardState` GAQL fetch (extended with two
   more selected fields, deserialized the same typed-row way every other
   `searchStructured` call already is) and the existing update-plan YAML
   boundary (`loadPlan`, parse-only) — `bidding` blocks remain untyped
   `Record<string, unknown>` at that boundary, unchanged from PR #60.
2. **Domain types**: no new branded/domain type. `bidding` blocks stay
   `Record<string, unknown>` until folded into the existing `Brief` type via
   `applyPlanToBrief`, where `CampaignSchema` (already parsed, already
   enforces the `strategy`/target-field pairing via `superRefine`) is where
   the real type guarantee lives — this feature widens the values that
   pipeline accepts, it doesn't add a new pipeline.
3. **Parsers**: no new parser. `parseBrief`/`BriefSchema` (existing) remains
   the single parse step that turns the proposed brief into a trusted value
   before it's written.
4. **Library choice**: N/A — no new schema library. The widened
   `BIDDING_PLAN_STRATEGIES` set and the new idempotency partition are plain
   functional code (pure functions/set membership, no mutation, no class),
   matching the existing `biddingErrors`/`budgetsErrors` style.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No constitution violations — no constitution is defined (see Constitution
Check above). No new files or abstractions are introduced; every change
widens an existing function, constant, or envelope in its existing role.
