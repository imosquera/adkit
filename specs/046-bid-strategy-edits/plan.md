# Implementation Plan: Bid-strategy edits via `ads.sh update`

**Branch**: `046-bid-strategy-edits` | **Date**: 2026-08-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/046-bid-strategy-edits/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Add a `bidding` section to the `ads.sh update` (`bin/apply-fixes.ts`) plan
format so a campaign's bid strategy can move `maximize-conversions` →
`maximize-clicks` with a `cpcBidCeilingMicros` ceiling, staged through the
same dry-run-diff-then-`--apply` flow as every other plan section. A new
guard (`biddingErrors` in `fixes/plan.ts`) refuses that specific direction
when the campaign has ≥30 conversions in the trailing 30 days unless the plan
entry sets `acknowledgeStrategyDowngrade: true`; a separate, non-blocking
warning surfaces when the proposed ceiling is below the campaign's trailing-
30-day average CPC. Both numbers come from one new GAQL query
(`applyBiddingGuardQuery`) fetched once per run, following the same
`inListQuery` shape the file's other apply-fixes queries already use.
`cpcBidCeilingMicros`/`bidStrategy` pairing validity is enforced for free by
the existing `CampaignSchema.superRefine` rule, since every staged brief is
already re-parsed through it before being written (`apply-fixes.ts:529`) — no
duplicate validation is added.

## Technical Context

**Language/Version**: TypeScript 5.7 (Node >=24)

**Primary Dependencies**: `google-ads-api` SDK, `zod`, `yaml`

**Storage**: Adbriefs on disk (`adbriefs/<slug>.yaml`), staged/diffed/written
by the existing `apply-plan.ts` / `store.ts` pipeline — unchanged mechanism,
new fields flow through it.

**Testing**: vitest — `fixes/plan.test.ts` (pure guard-function unit tests),
`bin/apply-fixes.test.ts` (fake-`AdsClient` end-to-end plan runs), `gaql/
builders.test.ts` (new query shape), `adbriefs/apply-plan.test.ts` (bidding
staging into a `Brief`).

**Target Platform**: Node CLI (`ads.sh update` / `apply-fixes` bin)

**Project Type**: CLI (single project, `skills/adkit/scripts/`)

**Performance Goals**: N/A — one additional GAQL query per `update` run,
same shape/cost as the existing `applyBudgetsQuery` fetch.

**Constraints**: Must not change behavior for any plan that has no `bidding`
section (every other section's validation, diff, and apply behavior is
untouched); the conversion-count guard and CPC-ceiling warning must use a
fixed 30-day lookback regardless of any other flag (there is no `--days` flag
on `update`).

**Scale/Scope**: One new GAQL builder (`applyBiddingGuardQuery`), one new
fetch function (`biddingGuardState`), one new pure validator
(`biddingErrors`), one new `ResolvedPlanGroup`/`PlanSections` field
(`bidding`), staging logic in `applyPlanToBrief`, one new mutation step in
`apply-fixes.ts`'s apply branch, plus two reference-doc edits.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled
`speckit init` template — every principle heading is a literal placeholder
token (`### [PRINCIPLE_1_NAME]`, etc.), not a real principle. Confirmed via
`python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py list`,
which reports zero matched principle headings.

**No constitution defined** — there are no real principles to check against.
The repo's actual binding conventions live in `/Users/iam/Code/adkit/CLAUDE.md`
(functional style: pure functions, immutable data, no classes for logic;
parse-don't-validate: parse untrusted input once at the boundary, don't
re-validate downstream) and are honored via the `## Parse Boundaries` section
below and the functional design in Phase 1 (the new guard is a pure
`(blocks, liveState) -> string[]` function mirroring `budgetsErrors`
exactly; the new GAQL builder and fetch function are the sole I/O, isolated
at the CLI-shell edge in `apply-fixes.ts`, same as every existing section).

## Project Structure

### Documentation (this feature)

Under the `spec-minimal` preset, the feature directory contains only:

```text
specs/046-bid-strategy-edits/
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
interface contract (no new public API, only an internal plan-format
addition and CLI behavior change).

### Source Code (repository root)

```text
skills/adkit/scripts/
├── src/
│   ├── gaql/
│   │   ├── builders.ts          # + applyBiddingGuardQuery, near applyBudgetsQuery
│   │   └── builders.test.ts     # + test for the new query's fields/conditions
│   ├── fixes/
│   │   ├── plan.ts              # + CONVERSION_GUARD_THRESHOLD, biddingErrors,
│   │   │                        #   wired into validate()
│   │   └── plan.test.ts         # + biddingErrors unit tests
│   ├── adbriefs/
│   │   ├── apply-plan.ts        # + `bidding` field on ResolvedPlanGroup /
│   │   │                        #   PlanSections / emptySections; staging logic
│   │   │                        #   in applyPlanToBrief mirroring budgets
│   │   └── apply-plan.test.ts   # + bidding staging tests
│   └── bin/
│       ├── apply-fixes.ts       # + biddingGuardState() fetch, validate() call
│       │                        #   site, action-string line, non-blocking
│       │                        #   warning block, new mutation step
│       └── apply-fixes.test.ts  # + end-to-end bidding plan test (dry-run +
│                                 #   --apply) against a fake AdsClient
└── (no new files — every change lands in an existing module)
```

**Structure Decision**: Single project, no new files. Every change extends
an existing module in its existing role (query builder, pure validator,
brief-staging, CLI shell) — this is additive to the established `budgets`
pattern, not a new subsystem.

### Phase 0: Research

Findings from reading the existing code (no `research.md` needed — nothing
here required external research, only locating the right precedent to
mirror):

- **No `bidding`/`budgets` zod schema exists to "reuse" at the plan-block
  level** — `schema.ts`'s `CampaignSchema.superRefine` (`cpcBidCeilingMicros`
  valid only when `bidStrategy === 'maximize-clicks'`, lines 255-260) governs
  the **brief** shape, not the update-plan block shape. The update-plan
  format itself is intentionally *not* zod-validated (`fixes/plan.ts`'s
  `budgetsErrors` etc. are hand-written string-array validators over loosely
  typed `Record<string, unknown>` blocks — see `bin/apply-fixes.ts:658`'s
  "PARSE, DON'T VALIDATE" comment on `loadPlan`, which parses YAML only).
  FR-002 ("reuse the existing schema rules — don't duplicate") is satisfied
  differently than a literal zod-schema reuse: `stageResolvedGroups`
  (`apply-fixes.ts:529-533`) already re-parses every proposed brief through
  `parseBrief`/`BriefSchema` before it can be written, so once a `bidding`
  entry stages `campaign.bidStrategy` / `campaign.cpcBidCeilingMicros` onto
  the brief, `CampaignSchema.superRefine`'s existing rule runs against it for
  free — a plan that tries to set `cpcBidCeilingMicros` on a
  `maximize-conversions` target is rejected at the staging step with zero new
  validation code. This is the "reuse" the requirement calls for.
- **`budgetsErrors` is the direct precedent to mirror**
  (`fixes/plan.ts:500`): a pure `(blocks, liveState) -> string[]` function,
  given a *pre-fetched* live-state map (never fetches itself). `MAX_RAISE_PCT_CAP
  = 50` (line 33) is the sibling constant to a new `CONVERSION_GUARD_THRESHOLD
  = 30`. It's wired into the `validate()` aggregator (`fixes/plan.ts:803-827`)
  by spreading `...budgetsErrors(arr("budgets"), budgets)` (line 816) — a new
  `...biddingErrors(arr("bidding"), biddingState)` slots in identically, and
  `validate()`'s signature grows one new required parameter.
- **There is no `bin/update.ts`** — `ads.sh update` maps to
  `bin/apply-fixes.ts` (`ads.sh:22`). All wiring below targets that file.
- **Campaign-level trailing-30-day `average_cpc` does not exist anywhere
  yet.** The audit command's `auditServingQuery` (`gaql/builders.ts:418-438`)
  fetches `campaign.bidding_strategy_type` and `metrics.conversions` over a
  caller-supplied `days` window (not fixed to 30), but has no
  `metrics.average_cpc` field — that metric currently exists only at
  keyword level (`auditKeywordMetricsQuery`). The new guard needs its own
  query, `applyBiddingGuardQuery`, following the exact same shape (built via
  the shared `inListQuery` factory, same as `applyBudgetsQuery`), fixed to
  `LAST_30_DAYS` regardless of any other setting, fetching
  `campaign.bidding_strategy_type`, `metrics.conversions`,
  `metrics.average_cpc`. This refines this feature's earlier clarification
  ("reuse the same trailing-30-day query pattern the audit command uses") —
  it reuses the *pattern* (`inListQuery`, `campaignScope`, `lastNDays`) and
  the *concept* (30-day conversions + bidding strategy), not the literal
  existing query object, since `average_cpc` isn't in it today.
- **`bidStrategyFields` (`ads/entities.ts:69-77`) only covers campaign
  *create*.** There is no existing update-mutation path for bid strategy.
  The Google Ads API models `maximize_conversions` / `target_spend` as a
  proto oneof (`campaign_bidding_strategy`); per the same pattern
  `setSearchPartners` documents (`entities.ts:203-217` — "the SDK derives the
  update mask from the fields present"), sending `target_spend:
  { cpc_bid_ceiling_micros }` on a `campaign` update operation should switch
  the oneof and implicitly clear `maximize_conversions`. This needs a quick
  smoke check against the `google-ads-api` SDK's mutate-operation building in
  `toSdkMutateOperations` (`lib/auth.ts`) during implementation, since a
  oneof swap is a stronger claim than the nested-field case the comment
  describes — if the SDK does *not* clear the old oneof branch automatically,
  the mutation op must explicitly null the unused branch.

### Phase 1: Design

**Data flow** (mirrors `budgets` end to end):

1. **Plan format** — a `bidding` array in the plan YAML, one entry per
   campaign:
   ```yaml
   bidding:
     - campaignId: 24057685583
       strategy: maximize-clicks
       cpcBidCeilingMicros: 5500000       # $5.50
       acknowledgeStrategyDowngrade: false # only needed for the risky direction
   ```
2. **Fetch** (`bin/apply-fixes.ts`, alongside the existing `campaignBudgets`
   call at line ~688): `biddingGuardState(client, customerId, campaignIds)` —
   new function mirroring `campaignBudgets` (`apply-fixes.ts:310-327`),
   built on `applyBiddingGuardQuery`, returning
   `Map<number, { biddingStrategyType: string; conversions30d: number; avgCpcMicros30d: number }>`.
3. **Validate** (`fixes/plan.ts`): new `biddingErrors(blocks, biddingState)`
   next to `budgetsErrors` (line ~500). Per block:
   - Look up live state via `campaignId`; error if missing (mirrors
     `budgetsErrors`' "no current budget found" pattern).
   - If `strategy === "maximize-clicks"` AND live `biddingStrategyType ===
     "MAXIMIZE_CONVERSIONS"` AND live `conversions30d >= CONVERSION_GUARD_THRESHOLD`
     (=30) AND `block.acknowledgeStrategyDowngrade !== true`: error, message
     names the campaign, its conversion count, and the threshold (mirrors
     the budgets-cap error's style at `plan.ts:525`).
   - No error for the reverse direction (`maximize-clicks` →
     `maximize-conversions`) regardless of conversion count — the guard only
     inspects the `maximize-clicks`-target case.
   - `cpcBidCeilingMicros`/`strategy` pairing validity is **not** checked
     here — deferred to the free `CampaignSchema.superRefine` reuse described
     in Phase 0.
   - Spread into `validate()`'s aggregate error array (`plan.ts:816`-style),
     which already hard-fails the whole run before any staging/mutation —
     unchanged failure semantics (FR-004, FR-007: a refused bidding entry
     doesn't block *other* plan sections, but per FR-007's edge case any
     other bidding/other-section entries only proceed once `validate()`
     overall passes; a single refused `bidding` block therefore fails the
     whole `update` invocation the same way a single invalid `budgets` block
     does today — this matches the existing all-or-nothing `validate()` gate
     and is called out explicitly since the spec's FR-007 wording is
     satisfied at the "other campaigns aren't singled out for extra
     restrictions" level, not by allowing partial success within one
     `validate()`-gated run).
4. **Ceiling-sanity warning** (non-blocking, `bin/apply-fixes.ts`): a
   separate pass over `section(plan, "bidding")`, comparing each block's
   `cpcBidCeilingMicros` to `biddingState.get(campaignId).avgCpcMicros30d`;
   when the ceiling is lower, push a `WARNING:` line into the existing
   warning-printing block (pattern at `apply-fixes.ts:917-940`, which already
   prints non-blocking `WARNING:` lines for other risky-but-allowed actions).
   This is deliberately **not** part of `biddingErrors`/`validate()`, since
   FR-006 requires it to never block the change.
5. **Staging** (`adbriefs/apply-plan.ts`):
   - `ResolvedPlanGroup["sections"]` (line ~66) and `PlanSections` (line ~89)
     both get a new `bidding: Array<Record<string, unknown>>` field;
     `emptySections()` (line ~83) initializes it to `[]`.
   - `resolvePlanGroups`'s `campaignSection(...)` wiring (line ~188, sibling
     to the `"budgets"` line) adds `campaignSection("bidding", (g, b) =>
     g.sections.bidding.push(b))`.
   - `applyPlanToBrief` (line ~244): mirrors the `lastBudget`/`budgetMicros`
     pattern (lines 339-342) — take the last `bidding` block for the slug's
     campaign, and if present, compute `bidStrategy`/`cpcBidCeilingMicros`
     from it; fold into the `campaignChanged` check (line ~343) and the
     returned `campaign` object alongside the existing budget field.
   - The proposed `Brief` is re-parsed through `parseBrief` in
     `stageResolvedGroups` exactly as today (`apply-fixes.ts:529`) — this is
     where `CampaignSchema.superRefine`'s `cpcBidCeilingMicros`/`bidStrategy`
     rule is enforced (FR-002), and where an invalid combination causes the
     slug to be skipped rather than corrupt the adbrief, matching the
     existing "skip, don't crash the whole run" behavior for any other
     schema violation.
6. **Diff/print**: unchanged mechanism — `diffBriefs` (`adbriefs/diff.ts:74`)
   picks up the new `campaign.bidStrategy` / `campaign.cpcBidCeilingMicros`
   fields automatically since it diffs serialized YAML (FR-003). A new
   action-string line is added to the printed summary list
   (`apply-fixes.ts:878`-style, sibling to the `budgets` action string),
   e.g. `` `bidding campaign ${pyStr(cid)}: ${strategy} -> ${newStrategy}` ``.
7. **Apply** (`bin/apply-fixes.ts`, new numbered mutation step alongside step
   5 "budgets" at line ~1110): for each accepted `bidding` block, issue a
   `client.mutate` with a `campaign` `update` operation:
   ```ts
   {
     entity: "campaign",
     operation: "update",
     resource: {
       resource_name: `customers/${customerId}/campaigns/${campaignId}`,
       target_spend: { cpc_bid_ceiling_micros: cpcBidCeilingMicros },
     },
   }
   ```
   (or `{ maximize_conversions: {} }` for the reverse/graduate-up direction,
   with no ceiling field) — same `recordFailure`-per-campaign error handling
   as the existing budgets step (`apply-fixes.ts:1123-1125`).
8. **Docs**: `reference/update.md:104` (the `budgets` paragraph that ends
   "Bid *strategy* is intentionally **not** editable here…") and
   `reference/update.md:153` ("It **cannot** change a bid strategy…") both
   get rewritten to describe the new `bidding` lever and its guardrail.
   `reference/audit.md:52`'s `cold_start_throttle` description and its
   `:55` "mostly not creative fixes" summary get a pointer to the new
   `bidding` section as the fix for a starved `maximize-conversions`
   campaign.

**Test plan**:
- `gaql/builders.test.ts`: `applyBiddingGuardQuery` returns the right
  resource/fields/`IN (...)`/`LAST_30_DAYS` condition for a set of campaign
  ids.
- `fixes/plan.test.ts`: `biddingErrors` — refuses a downgrade at exactly 30
  conversions without acknowledgement (boundary, SC-003); allows it at 29;
  allows it at 30+ with `acknowledgeStrategyDowngrade: true`; never guards
  the graduate-up direction regardless of conversion count; errors on an
  unknown `campaignId`.
- `adbriefs/apply-plan.test.ts`: a `bidding` block stages
  `bidStrategy`/`cpcBidCeilingMicros` onto the proposed `Brief`; absent
  `bidding` blocks leave `campaign` unchanged (no regression).
- `bin/apply-fixes.test.ts`: end-to-end fake-`AdsClient` run — dry-run shows
  the diff and issues zero mutate calls (SC-002); `--apply` issues the
  `campaign` update mutate op with the right fields; a plan with a refused
  downgrade fails `validate()` and mutates nothing; a ceiling below average
  CPC prints the warning and still applies (SC-004).

## Parse Boundaries

This is a TypeScript feature (`skills/adkit/scripts`, `.ts`).

1. **Trust boundaries**: one new boundary — the Google Ads API's JSON
   response for the new `applyBiddingGuardQuery`, deserialized the same way
   every other `searchStructured` call already is (typed row interface,
   consistent with `BudgetRow` etc.). The update-plan YAML itself crosses an
   existing, already-established boundary (`loadPlan`, parse-only, per the
   codebase's existing "PARSE, DON'T VALIDATE" comment at
   `apply-fixes.ts:658`) — the new `bidding` blocks are untyped
   `Record<string, unknown>` at that boundary, same as every other plan
   section today; this feature does not change that boundary's strictness,
   it adds one more section to it, consistent with the existing design.
2. **Domain types**: no new branded/domain type. `bidding` blocks stay
   `Record<string, unknown>` until they're folded into the existing `Brief`
   type via `applyPlanToBrief`, at which point `CampaignSchema` (already a
   parsed, strong type) is where the real type guarantee lives — this is the
   existing pattern (`budgets` blocks work the same way) and this feature
   doesn't introduce a new type family, it reuses the established
   "loose plan block → validated brief" pipeline.
3. **Parsers**: no new parser. `parseBrief`/`BriefSchema` (existing) is the
   single parse step that turns the proposed brief into a trusted value
   before it's written — this feature relies on it running again for the
   `bidding`-augmented brief rather than adding a second parse path.
4. **Library choice**: N/A — no new schema library. The new `biddingErrors`
   guard is plain functional code (a pure function producing a `string[]`,
   no mutation, no class), matching `budgetsErrors`'s existing style exactly.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No constitution violations — no constitution is defined (see Constitution
Check above). No new abstractions or files are introduced; every change
extends an existing module (`plan.ts`, `apply-plan.ts`, `apply-fixes.ts`,
`builders.ts`) in the same role it already plays for the `budgets` section.
