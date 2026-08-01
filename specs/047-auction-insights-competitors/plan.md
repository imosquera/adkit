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
already-`rank_constrained` campaign) and `new_competitor` (a domain absent from
a locally cached prior run). The cache is a small git-ignored JSON file
following the existing `.adkit.yaml` local-file convention, parsed through a
Zod schema following the existing `DifferentiationProfileSchema` convention in
`src/lib/brand.ts`.

## Technical Context

**Language/Version**: TypeScript (Node, ESM), per `skills/adkit/scripts/package.json`

**Primary Dependencies**: `google-ads-api` (already a dependency; adds one new
GAQL resource, `auction_insight_domain`, to the existing query-builder module);
`zod` (already a dependency, used for the new cache-file parser following the
`DifferentiationProfileSchema` convention)

**Storage**: A new local, git-ignored JSON cache file (one per project, same
convention as `.adkit.yaml`) holding the prior run's per-customer,
per-campaign competing-domain sets — the only state this feature persists.

**Testing**: `vitest`, per existing `*.test.ts` files in
`skills/adkit/scripts/src` (builder golden-string parity tests, row-normalizer
tests, pure-scorer tests, cache-diff tests, envelope wiring tests)

**Target Platform**: CLI (`/adkit audit`), Node.js

**Project Type**: CLI tool (single project, `skills/adkit/scripts`)

**Performance Goals**: N/A — one additional GAQL query per audit run, same
`--days` window and campaign-id batching the existing serving/keyword-CPC
queries already use; no new hot path

**Constraints**: Must stay silent (no `auctionInsights` entry, no finding) for
a campaign with zero Auction Insights rows (spec Edge Cases); must not emit
`new_competitor` on a campaign's first-ever run (spec FR-007); must never emit
`losing_to_competitor` for a campaign that isn't already `rank_constrained`
(spec FR-005); must not fetch or analyze competitor ad copy/landing pages
(spec FR-010, Non-goals)

**Scale/Scope**: One new GAQL builder + resource, one new row type + normalizer,
one new pure grouping/sort function, one new pure cache-diff module (+ its Zod
schema and IO shell), two new flags layered onto the existing `ScoredServing`
type, one new envelope field (`auctionInsights`) — no new CLI subcommand, no
new top-level module beyond the cache

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
are honored via the `## Parse Boundaries` section below: both new trust
boundaries (the Auction Insights GAQL rows and the local cache file) are
parsed once into strong domain types at the edge, and every pure function in
this feature (row normalizer, grouping/sort, cache diff, finding computation)
takes and returns immutable values with no mutation or class state.

## Project Structure

### Documentation (this feature)

```text
specs/047-auction-insights-competitors/
├── spec.md               # Feature specification
├── plan.md               # This file (/speckit-plan command output)
├── tasks.md              # Phase 2 output (/speckit-tasks command)
└── checklists/
    └── requirements.md   # Spec quality checklist
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── gaql/
│   ├── builders.ts                    # Add auctionInsightDomainQuery() next to auditServingQuery()
│   └── builders.test.ts               # Golden-string parity test for the new builder
├── audit/
│   ├── types.ts                       # Add AuctionInsightRow; extend ScoredServing.flags' known values
│   ├── rows.ts                        # Add RawAuctionInsightRow + normalizeAuctionInsightRow()
│   ├── rows.test.ts                   # Normalizer tests
│   ├── scoring.ts                     # Add auctionInsightsByCampaign() (group+sort) and
│   │                                  #   losingToCompetitorFinding()/newCompetitorFinding() (pure, cache-diff already resolved)
│   ├── scoring.test.ts                # Pure-function tests for both findings + grouping
│   ├── auction-insights-cache.ts      # NEW: AuctionInsightsCacheSchema (Zod), parseAuctionInsightsCache(),
│   │                                  #   pure diffNewCompetitors() / updateCache()
│   └── auction-insights-cache.test.ts # NEW: parser + pure diff/update tests
└── bin/
    └── audit.ts                       # campaignServing(): fetch auction_insight_domain rows (gated by
                                        #   --no-serving, same as keywordCpc), load/save the cache (IO shell),
                                        #   merge auctionInsights + findings into ScoredServing and the
                                        #   JSON envelope
```

**Structure Decision**: Single existing project (`skills/adkit/scripts`), no
new top-level directories. One new module, `audit/auction-insights-cache.ts`
(+ its test file), holds every impure/parse concern specific to the local
cache file (Zod schema, parser, IO-free diff/update functions); everything
else extends existing modules in place, following the same
builder/row/normalizer/scorer layering the `keywordCpc`/search-term-waste
features already established. `bin/audit.ts` remains the only IO shell that
touches the filesystem or the Ads API for this feature.

## Complexity Tracking

*No violations — this feature adds one new local-state concern (the cache
file), isolated in its own small module with a Zod-parsed domain type, and
otherwise follows the exact layering (GAQL builder → raw row → normalizer →
pure scorer → envelope field) every other serving-layer feature in this file
already uses. Complexity Tracking is not applicable.*

## Parse Boundaries

1. **Trust boundary — Auction Insights API rows**: the `auction_insight_domain`
   GAQL resource's response rows (`auction_insight_domain.domain`,
   `campaign.id`, `metrics.auction_insight_search_impression_share`,
   `metrics.auction_insight_search_overlap_rate`,
   `metrics.auction_insight_search_position_above_rate`,
   `metrics.auction_insight_search_top_impression_percentage`,
   `metrics.auction_insight_search_outranking_share`), as returned by
   `search<RawAuctionInsightRow>()` in `campaignServing()`
   (`skills/adkit/scripts/src/bin/audit.ts`). Kept as the SDK's raw row shape
   (`RawAuctionInsightRow`, fields typed `string | number` per the existing
   `RawServingRow` convention in `audit/rows.ts`) until it passes through the
   normalizer below — never read directly into a field typed as the domain
   type.

2. **Trust boundary — local cache file**: the JSON contents of the git-ignored
   `.adkit-auction-insights-cache.json` (path resolved the same way
   `configPath()` resolves `.adkit.yaml` in `src/lib/config.ts` — env-override
   aware, defaulting to `process.cwd()`), read via `readFileSync` +
   `JSON.parse`, producing `unknown` — never assigned a cache-shaped type or
   accessed as `any` before `parseAuctionInsightsCache()` runs. A missing file
   is treated as an empty cache at the same IO boundary (first-ever run per
   spec FR-007), not downstream — this is a deliberate resilience choice for a
   best-effort local file (not user-authored input the operator hand-edits),
   documented here rather than left as an implicit fallback.

3. **Domain types** (`skills/adkit/scripts/src/audit/types.ts` and
   `audit/auction-insights-cache.ts`):
   - `AuctionInsightRow` — `{ campaignId: number; domain: string;
     impressionShare: number; overlapRate: number; positionAboveRate: number;
     topOfPageRate: number; outrankingShare: number }`. No branding needed
     (a plain shape, like the existing `KeywordCpc`/`ScoredServing` types) —
     the failure mode being closed is "read an untyped/partial row," not a
     confusable-primitive mixup.
   - `AuctionInsightsCache` — `{ [customerId: string]: { [campaignId: string]:
     string[] } }` (domains only; share metrics aren't diffed run-over-run),
     inferred from a Zod schema so a customer id and a campaign id are never
     silently swapped — the schema's key shape enforces the nesting order.

4. **Parsers**:
   - `normalizeAuctionInsightRow(r: RawAuctionInsightRow): AuctionInsightRow`
     in `audit/rows.ts`, following the existing `normalizeServingRow`
     convention (numeric coercion, no re-validation downstream) — the single
     point a raw row becomes an `AuctionInsightRow`.
   - `parseAuctionInsightsCache(data: unknown): AuctionInsightsCache` in the
     new `audit/auction-insights-cache.ts`, via `AuctionInsightsCacheSchema.parse()`
     (Zod, throws `ZodError` on malformed shape) — mirrors
     `parseDifferentiationProfile()` in `src/lib/brand.ts` exactly. The IO
     shell in `bin/audit.ts` catches a missing-file or parse failure and
     substitutes `{}` (empty cache), per boundary #2 above; every other caller
     receives the already-parsed `AuctionInsightsCache` and never re-checks
     its shape.

5. **Library choice**: Zod, already a project dependency and the established
   convention for this exact kind of "small local JSON, once per run" parse
   (`DifferentiationProfileSchema`). No hand-rolled cache parser — reusing the
   existing library keeps the new boundary consistent with the one boundary
   in this codebase it most resembles.
