# Implementation Plan: Auction Insights competitor visibility

**Branch**: `047-auction-insights-competitors` | **Date**: 2026-08-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/047-auction-insights-competitors/spec.md` (source: GitHub issue #56)

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

`ads.sh audit`'s impression-share layer (`campaignServing`/`scoreServing` in
`skills/adkit/scripts/src/bin/audit.ts`) already flags a campaign as
`rank_constrained` when it's losing impression share to Ad Rank, but never says
*who* it's losing to. This feature adds a new Auction Insights pull —
`auction_insight_domain` GAQL rows, fetched alongside the existing serving query,
on by default and skipped by `--no-serving` — that emits a per-campaign,
per-domain share table (`auctionInsights` in the JSON envelope) and two
deterministic findings layered onto the existing `ScoredServing` flags:
`losing_to_competitor` (a domain's outranking share exceeds 60% on an
already-`rank_constrained` campaign) and `new_competitor` (a domain present in
the current `--days` window but absent from the `--days`-day window
immediately before it). Both windows are fetched **within the same run** — no
local cache, no cross-run state, no git-ignore concerns, and the result is
identical no matter which machine runs the audit.

## Technical Context

**Language/Version**: TypeScript (Node, ESM), per `skills/adkit/scripts/package.json`

**Primary Dependencies**: `google-ads-api` (already a dependency; adds one new
GAQL resource, `auction_insight_domain`, to the existing query-builder module) —
no other new dependencies

**Storage**: N/A — this feature is entirely stateless. `new_competitor` is
computed by diffing two Auction Insights windows fetched in the same run
(current `--days` window vs. the immediately-preceding `--days`-day window),
not by persisting anything between runs.

**Testing**: `vitest`, per existing `*.test.ts` files in
`skills/adkit/scripts/src` (builder golden-string parity tests, row-normalizer
tests, pure-scorer tests, envelope wiring tests)

**Target Platform**: CLI (`/adkit audit`), Node.js

**Project Type**: CLI tool (single project, `skills/adkit/scripts`)

**Performance Goals**: N/A — two additional GAQL queries per audit run (current
window + prior window), same campaign-id batching the existing serving/
keyword-CPC queries already use; no new hot path

**Constraints**: Must stay silent (no `auctionInsights` entry, no finding) for
a campaign with zero current-window Auction Insights rows (spec Edge Cases);
must report every current-window domain as `new_competitor` when a campaign
has no prior-window data at all — no first-run suppression (spec FR-008); must
never emit `losing_to_competitor` for a campaign that isn't already
`rank_constrained` (spec FR-005); must not fetch or analyze competitor ad
copy/landing pages (spec FR-010, Non-goals)

**Scale/Scope**: One new GAQL builder + resource for the current window, one
sibling builder for the prior window (domain identity only, no share
metrics), one new row type + normalizer, one new pure grouping/sort function,
one new pure window-diff function, two new flags layered onto the existing
`ScoredServing` type, one new envelope field (`auctionInsights`) — no new CLI
subcommand, no new module, no persisted state

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled
`speckit init` template — every principle heading is a literal placeholder
token (`### [PRINCIPLE_1_NAME]`, etc.), not a real principle. Confirmed via
`python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py list`,
which reports zero matched principle headings (same state as the `046-ad-strength-enum-fix`
plan, which established this precedent). Per the plan skill's own rule ("When
`.specify/memory/constitution.md` does not exist, the Constitution Check
section may state 'No constitution defined'"), this is treated equivalently —
there is no constitution content to quote or gate against.

**No constitution defined** — `.specify/memory/constitution.md` contains only
unfilled placeholder headings, so there are no real principles to check
against. The repo's actual binding conventions live in
`/Users/iam/Code/adkit/CLAUDE.md` (functional style, parse-don't-validate) and
are honored via the `## Parse Boundaries` section below: the one new trust
boundary (the Auction Insights GAQL rows) is parsed once into a strong domain
type at the edge, and every pure function in this feature (row normalizer,
grouping/sort, window diff, finding computation) takes and returns immutable
values with no mutation or class state.

## Project Structure

### Documentation (this feature)

```text
specs/047-auction-insights-competitors/
├── spec.md               # Feature specification
├── plan.md               # This file (/speckit-plan command output)
├── tasks.md              # Phase 2 output (/speckit-tasks command)
└── requirements.md       # Spec quality checklist
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── gaql/
│   ├── builders.ts                    # auctionInsightDomainQuery() (current window, LAST_N_DAYS) and
│   │                                  #   auctionInsightDomainPriorWindowQuery() (prior window, explicit
│   │                                  #   BETWEEN dates via the new priorWindow() date-math helper)
│   └── builders.test.ts               # Golden-string parity tests for both builders + priorWindow()
├── audit/
│   ├── types.ts                       # Add AuctionInsightRow; extend ScoredServing.flags' known values
│   ├── rows.ts                        # Add RawAuctionInsightRow + normalizeAuctionInsightRow()
│   ├── rows.test.ts                   # Normalizer tests
│   ├── scoring.ts                     # auctionInsightsByCampaign() (group+sort), losingToCompetitorFlag(),
│   │                                  #   newCompetitorDomains() (pure set-difference, no cache)
│   └── scoring.test.ts                # Pure-function tests for all three
└── bin/
    └── audit.ts                       # campaignAuctionInsights() (current window) +
                                        #   campaignPriorAuctionInsights() (prior window), both gated by
                                        #   --no-serving; merge auctionInsights + findings into
                                        #   ScoredServing and the JSON envelope
```

**Structure Decision**: Single existing project (`skills/adkit/scripts`), no
new top-level directories, no new module beyond the two sibling GAQL
builders and the pure functions in `scoring.ts` — everything follows the
existing builder/row/normalizer/scorer layering the `keywordCpc`/search-term-
waste features already established. `bin/audit.ts` remains the only IO shell
that touches the Ads API for this feature; there is no filesystem state.

## Complexity Tracking

*No violations — this feature adds zero persisted state and follows the exact
layering (GAQL builder → raw row → normalizer → pure scorer → envelope field)
every other serving-layer feature in this file already uses. Complexity
Tracking is not applicable.*

## Parse Boundaries

1. **Trust boundary — Auction Insights API rows**: the `auction_insight_domain`
   GAQL resource's response rows, for both the current window
   (`auction_insight_domain.domain`, `campaign.id`,
   `metrics.auction_insight_search_impression_share`,
   `metrics.auction_insight_search_overlap_rate`,
   `metrics.auction_insight_search_position_above_rate`,
   `metrics.auction_insight_search_top_impression_percentage`,
   `metrics.auction_insight_search_outranking_share`) and the prior window
   (`campaign.id`, `auction_insight_domain.domain` only — no share metrics
   needed for a pure domain-identity diff), as returned by
   `search<RawAuctionInsightRow>()` in `campaignAuctionInsights()` /
   `campaignPriorAuctionInsights()` (`skills/adkit/scripts/src/bin/audit.ts`).
   Kept as the SDK's raw row shape (`RawAuctionInsightRow`, fields typed
   `string | number` per the existing `RawServingRow` convention in
   `audit/rows.ts`) until it passes through the normalizer below — never read
   directly into a field typed as the domain type. (The prior-window fetch
   reduces each row to its `campaign.id`/`domain` pair inline in
   `campaignPriorAuctionInsights()`, since only domain identity is needed
   there — no separate normalizer for that narrower shape.)

2. **Domain type** (`skills/adkit/scripts/src/audit/types.ts`):
   `AuctionInsightRow` — `{ campaignId: number; domain: string;
   impressionShare: number; overlapRate: number; positionAboveRate: number;
   topOfPageRate: number; outrankingShare: number }`. No branding needed (a
   plain shape, like the existing `KeywordCpc`/`ScoredServing` types) — the
   failure mode being closed is "read an untyped/partial row," not a
   confusable-primitive mixup. The prior window's output
   (`Record<number, string[]>`, campaign id to domain list) doesn't need its
   own named type — it's consumed immediately by the pure diff function below.

3. **Parsers**:
   - `normalizeAuctionInsightRow(r: RawAuctionInsightRow): AuctionInsightRow`
     in `audit/rows.ts`, following the existing `normalizeServingRow`
     convention (numeric coercion, no re-validation downstream) — the single
     point a raw current-window row becomes an `AuctionInsightRow`.
   - `priorWindow(asOf: Date, days: number): [string, string]` in
     `gaql/builders.ts`, next to the existing `dateWindow()` — pure date math
     (no parsing per se, but the boundary that turns "now" + a day count into
     the explicit `BETWEEN` bounds `auctionInsightDomainPriorWindowQuery()`
     needs, since GAQL's `LAST_N_DAYS` relative literal has no "N days before
     that" equivalent).

4. **Library choice**: no schema library needed — the only external data
   crossing a boundary in this feature is the Auction Insights API response,
   already covered by `normalizeAuctionInsightRow`'s hand-rolled numeric
   coercion (the established convention for every other GAQL row in this
   file, e.g. `normalizeServingRow`). Removing the local-cache design (see
   spec/issue discussion) also removes the one place a schema library
   (Zod, as used elsewhere in this codebase for `DifferentiationProfileSchema`)
   would have been needed.
