# Tasks: Auction Insights competitor visibility

**Input**: Design documents from `/specs/047-auction-insights-competitors/`

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Included — every existing module in this codebase (`skills/adkit/scripts/src`) ships a co-located `*.test.ts`, and the autopilot implementation gate requires `vitest` green, so test tasks are in scope for each user story.

**Organization**: Tasks are grouped by user story (US1/US2/US3, per spec.md priorities) to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- All paths are relative to `skills/adkit/scripts/`

## Phase 1: Setup

**Purpose**: No new scaffolding needed — this feature extends existing modules (`gaql/builders.ts`, `audit/types.ts`, `audit/rows.ts`, `audit/scoring.ts`, `bin/audit.ts`) plus one new module pair. Nothing to initialize.

- [x] T001 Confirm `zod` and `google-ads-api` are already resolved in `skills/adkit/scripts/node_modules` (`cd skills/adkit/scripts && npm ls zod google-ads-api`) — both are existing dependencies per plan.md; no `npm install` expected.

## Phase 2: Foundational (blocking prerequisites for all user stories)

**Purpose**: The raw-row plumbing (GAQL builder, types, normalizer) that every user story's findings and envelope data depend on. Must complete before any US phase.

- [x] T002 [P] Add `AuctionInsightRow` type to `src/audit/types.ts`: `{ campaignId: number; domain: string; impressionShare: number; overlapRate: number; positionAboveRate: number; topOfPageRate: number; outrankingShare: number }` (per plan.md Parse Boundaries #3)
- [x] T003 [P] Add `auctionInsightDomainQuery(days: number, campaignIds: ReadonlyArray<string | number>): SearchArgs` to `src/gaql/builders.ts`, next to `auditServingQuery()`, querying the `auction_insight_domain` resource with fields `auction_insight_domain.domain`, `campaign.id`, `metrics.auction_insight_search_impression_share`, `metrics.auction_insight_search_overlap_rate`, `metrics.auction_insight_search_position_above_rate`, `metrics.auction_insight_search_top_impression_percentage`, `metrics.auction_insight_search_outranking_share`, using the existing `inListQuery` factory with `lastNDays(days)` (mirror `auditSearchTermsQuery`'s shape)
- [x] T004 [P] Add `RawAuctionInsightRow` type + `normalizeAuctionInsightRow(r: RawAuctionInsightRow): AuctionInsightRow` to `src/audit/rows.ts`, following the existing `normalizeServingRow` convention (numeric coercion at the boundary, no downstream re-validation) (depends on T002)
- [x] T005 [US-shared] Add `auctionInsightsByCampaign(rows: AuctionInsightRow[]): Record<number, AuctionInsightRow[]>` to `src/audit/scoring.ts` — pure grouping by `campaignId`, each group sorted by `impressionShare` descending (depends on T002)
- [x] T006 [P] Golden-string parity test for `auctionInsightDomainQuery()` in `src/gaql/builders.test.ts` (depends on T003)
- [x] T007 [P] Normalizer test for `normalizeAuctionInsightRow()` in `src/audit/rows.test.ts` — numeric coercion, all six fields (depends on T004)
- [x] T008 [P] Grouping/sort test for `auctionInsightsByCampaign()` in `src/audit/scoring.test.ts` — multiple domains per campaign, descending impression-share order, empty input → empty map (depends on T005)

**Checkpoint**: Raw Auction Insights data can be queried, parsed, and grouped per campaign — the shared substrate every user story builds on.

---

## Phase 3: User Story 2 - Get the raw per-domain share data for every serving campaign (Priority: P1)

**Goal**: The full Auction Insights table lands in the audit's JSON envelope for every serving campaign, gated by `--no-serving` like every other serving-layer output.

**Independent Test**: Run the audit against an account with a serving campaign; confirm `auctionInsights[campaignId]` is present and sorted by impression share descending, and confirm it's absent entirely when `--no-serving` is passed.

> Built first (ahead of US1) because US1's `losing_to_competitor` finding reads from the same envelope wiring this phase establishes in `campaignServing()`.

- [x] T009 [US2] In `src/bin/audit.ts`, extend `campaignServing()` to fetch `auction_insight_domain` rows via `search<RawAuctionInsightRow>()` + `auctionInsightDomainQuery()`, gated by the same `!args.noServing` condition already guarding `keywordCpc`/search-term-waste fetches (depends on T003, T004)
- [x] T010 [US2] In `src/bin/audit.ts`, map the fetched rows through `normalizeAuctionInsightRow` + `auctionInsightsByCampaign()` and add the result to the JSON envelope as `auctionInsights` (via `stringKeyed`, matching the existing `keywordCpc`/`clusterSplits` envelope fields) (depends on T005, T009)
- [x] T011 [US2] Add a text-output render section for `auctionInsights` in `src/audit/render.ts`, following the existing `renderKeywordCpc` pattern (depends on T010)
- [x] T012 [US2] Envelope-wiring test in `src/bin/audit.test.ts`: a serving campaign with multiple competing domains produces a correctly sorted `auctionInsights[campaignId]` entry; `--no-serving` produces no `auctionInsights` key at all (depends on T010)
- [x] T013 [US2] Edge-case test in `src/bin/audit.test.ts`: a campaign with zero Auction Insights rows produces no `auctionInsights` entry for that campaign (spec Edge Cases) (depends on T010)

**Checkpoint**: US2 is independently complete and testable — the raw table is in the envelope and rendered.

---

## Phase 4: User Story 1 - See who you're losing impression share to (Priority: P1)

**Goal**: A campaign already flagged `rank_constrained` gets a `losing_to_competitor` finding naming the dominant outranking domain.

**Independent Test**: Run the audit against a `rank_constrained` campaign with a domain above 60% outranking share; confirm a `losing_to_competitor` finding names that domain. Confirm no finding fires when the campaign isn't `rank_constrained`, regardless of outranking share (spec FR-005).

- [x] T014 [P] [US1] Add `OUTRANKING_LOSING_THRESHOLD = 0.6` constant to `src/bin/audit.ts` next to the existing `LOST_HI`/`IS_OPPORTUNITY` constants
- [x] T015 [US1] Add pure `losingToCompetitorFlag(rankConstrained: boolean, domains: AuctionInsightRow[]): { flag: string; rec: string; domain: string } | null` to `src/audit/scoring.ts` — returns non-null only when `rankConstrained` is true AND the top domain's `outrankingShare` exceeds `OUTRANKING_LOSING_THRESHOLD`; returns null otherwise (including when not rank-constrained, per spec FR-005) (depends on T002, T005)
- [x] T016 [US1] In `src/bin/audit.ts`, after `scoreServing()` computes its base `ScoredServing` (with `rank_constrained` already in `flags`), merge in `losingToCompetitorFlag()`'s result: append `"losing_to_competitor"` to `flags` and its `rec` string to `impressionShareRecs` when non-null (depends on T010, T015)
- [x] T017 [US1] Pure-function tests for `losingToCompetitorFlag()` in `src/audit/scoring.test.ts`: fires when rank-constrained + >60% outranking; silent when rank-constrained but <=60%; silent when not rank-constrained regardless of outranking share (spec Acceptance Scenarios + FR-005) (depends on T015)
- [x] T018 [US1] Integration test in `src/bin/audit.test.ts`: a `rank_constrained` campaign with a >60%-outranking domain produces a `losing_to_competitor` flag naming that domain in the campaign's `ScoredServing` (depends on T016)

**Checkpoint**: US1 is independently complete and testable — MVP scope (US1 + US2) is now shippable.

---

## Phase 5: User Story 3 - Get alerted when a new competitor shows up (Priority: P2)

**Goal**: A domain that wasn't in a campaign's prior cached Auction Insights snapshot triggers a `new_competitor` finding; the very first run for a campaign never fires one and instead seeds the cache.

**Independent Test**: Run the audit twice against the same account/campaign with the cache file persisted between runs, where the second run's data includes a domain absent from the first; confirm `new_competitor` fires only on the second run for that domain.

- [x] T019 [P] [US3] Create `src/audit/auction-insights-cache.ts`: `AuctionInsightsCacheSchema` (Zod, `z.record(z.string(), z.record(z.string(), z.array(z.string())))`, customerId → campaignId → domain list), `AuctionInsightsCache` type, `EMPTY_CACHE = {}`, and `parseAuctionInsightsCache(data: unknown): AuctionInsightsCache` (throws on malformed shape) — following the `DifferentiationProfileSchema`/`parseDifferentiationProfile` convention in `src/lib/brand.ts` (per plan.md Parse Boundaries #3–5)
- [x] T020 [US3] In `src/audit/auction-insights-cache.ts`, add pure `diffNewCompetitors(cache: AuctionInsightsCache, customerId: string, campaignId: number, currentDomains: readonly string[]): { isFirstRun: boolean; newDomains: string[] }` — `isFirstRun: true` (and `newDomains: []`) when `cache[customerId]?.[campaignId]` is absent (spec FR-007); otherwise `newDomains` is the set difference (depends on T019)
- [x] T021 [US3] In `src/audit/auction-insights-cache.ts`, add pure `updateCache(cache: AuctionInsightsCache, customerId: string, campaignId: number, currentDomains: readonly string[]): AuctionInsightsCache` — returns a new object (no mutation) with that campaign's domain list replaced by `currentDomains` (depends on T019)
- [x] T022 [P] [US3] Add `auctionInsightsCachePath()` to `src/lib/config.ts` next to `configPath()`, resolving `.adkit-auction-insights-cache.json` the same env-override-aware way, plus its `/.adkit-auction-insights-cache.json` `.gitignore` entry constant alongside the existing `GITIGNORE_ENTRY`
- [x] T023 [US3] In `src/bin/audit.ts`, add IO shell functions `loadAuctionInsightsCache()` / `saveAuctionInsightsCache(cache)` — `readFileSync`/`JSON.parse` + `parseAuctionInsightsCache()`, catching a missing file or parse failure and substituting `EMPTY_CACHE` (per plan.md Parse Boundaries #2); `writeFileSync` with `JSON.stringify(cache, null, 2)` (depends on T019, T022)
- [x] T024 [US3] In `src/bin/audit.ts`, wire `campaignServing()`: load the cache once per run, call `diffNewCompetitors()` per campaign against that campaign's `auctionInsightsByCampaign()` domains, append `"new_competitor"` to `flags` (with a rec naming the domain(s)) when `newDomains` is non-empty and not `isFirstRun`, then call `updateCache()` per campaign and `saveAuctionInsightsCache()` once at the end of the run (depends on T010, T020, T021, T023)
- [x] T025 [US3] Tests in `src/audit/auction-insights-cache.test.ts`: `parseAuctionInsightsCache()` round-trips valid shapes and throws on malformed input; `diffNewCompetitors()` returns `isFirstRun: true` with no prior entry, returns the correct new-domain set with a prior entry, returns no new domains when all overlap (spec Acceptance Scenarios); `updateCache()` doesn't mutate its input (depends on T020, T021)
- [x] T026 [US3] Integration test in `src/bin/audit.test.ts`: two sequential audit runs sharing a cache — first run seeds the cache and emits no `new_competitor` finding even with domains present; second run with an added domain emits `new_competitor` naming only that domain (depends on T024)

**Checkpoint**: US3 is independently complete and testable — all three user stories now ship together.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final gate checks, per the issue's Pointers and CLAUDE.md conventions.

- [x] T027 [P] Update `reference/audit.md` to document the `auctionInsights` envelope field and the `losing_to_competitor`/`new_competitor` findings, next to the existing `budget_constrained`/`rank_constrained` section — explicitly note domain + share metrics only, no competitor ad-copy/landing-page scraping (spec FR-010) (depends on T010, T016, T024)
- [x] T028 Run `cd skills/adkit/scripts && npm run typecheck && npx vitest run` and fix any failures before calling the feature complete

## Execution Wave DAG

```text
Wave 1 (parallel): T001, T002, T003
Wave 2 (parallel): T004 (needs T002), T005 (needs T002)
Wave 3 (parallel): T006 (needs T003), T007 (needs T004), T008 (needs T005)
Wave 4: T009 (needs T003, T004)
Wave 5: T010 (needs T005, T009)
Wave 6 (parallel): T011, T012, T013 (all need T010); T014 (no deps, can run any time after Wave 1); T019 (no deps, can run any time after Wave 1); T022 (no deps, can run any time)
Wave 7: T015 (needs T002, T005) — can actually start as early as Wave 2, listed here for readability
Wave 8: T016 (needs T010, T015)
Wave 9 (parallel): T017 (needs T015), T018 (needs T016)
Wave 10 (parallel): T020, T021 (both need T019)
Wave 11: T023 (needs T019, T022)
Wave 12: T024 (needs T010, T020, T021, T023)
Wave 13 (parallel): T025 (needs T020, T021), T026 (needs T024)
Wave 14: T027 (needs T010, T016, T024)
Wave 15: T028 (needs everything)
```

## Dependencies

- **Phase 2 (Foundational)** blocks all user story phases — every story reads `AuctionInsightRow`/`auctionInsightsByCampaign`.
- **US2** (envelope wiring, T009-T013) is built before US1 and US3's audit.ts wiring because both later stories merge findings into the same `campaignServing()` call site US2 establishes — but US2 is still independently testable and shippable on its own (spec Independent Test).
- **US1** (T014-T018) depends on US2's envelope wiring (T010) but not on US3.
- **US3** (T019-T026) depends on US2's envelope wiring (T010) but not on US1 — the cache module (T019-T023) has no dependency on either.
- **Polish** (T027-T028) depends on all three stories being wired in.

## Implementation Strategy

**MVP = US2 + US1** (both P1): the raw per-domain table plus the rank-loss tie-in are the core ask from issue #56. US3 (new-competitor alerting, P2) is valuable but can ship in a follow-up if time-boxed — the cache module is fully isolated (T019-T023) and doesn't block US1/US2's envelope or finding.

Suggested order: Phase 1 → Phase 2 → Phase 3 (US2) → Phase 4 (US1) → Phase 5 (US3) → Phase 6. Within Phase 2 and within each story phase, `[P]`-marked tasks can run concurrently.
