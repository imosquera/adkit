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

**Goal**: A domain present in the current `--days` window but absent from the immediately-preceding `--days`-day window triggers a `new_competitor` finding — computed entirely within a single run, no cross-run state.

**Independent Test**: Run the audit once against an account where a campaign's current window shows a domain not present in the immediately-preceding window; confirm `new_competitor` fires naming that domain, in that one run.

> **Redesigned 2026-08-02** (post-implementation, pre-merge): the original design used a local git-ignored cache file (`.adkit-auction-insights-cache.json`) diffed across separate CLI invocations. Replaced with a stateless two-window design — both the current and the immediately-preceding `--days`-day window are queried via Auction Insights in the *same* run, and diffed directly. This removes all local/cross-run state: no cache file, no `.gitignore` wiring, no "first run never fires" special case (a campaign with no prior-window data simply has every current domain read as new — spec FR-008), and the result is identical regardless of which machine or CI runs the audit. Tasks below reflect the design actually shipped.

- [x] T019 [P] [US3] Add `priorWindow(asOf: Date, days: number): [string, string]` to `src/gaql/builders.ts` next to `dateWindow()` — pure date math for the `--days`-day window immediately before `dateWindow(asOf, days)`'s window (no gap, no overlap)
- [x] T020 [US3] Add `auctionInsightDomainPriorWindowQuery(start: string, end: string, campaignIds): SearchArgs` to `src/gaql/builders.ts` — domain identity only (`campaign.id`, `auction_insight_domain.domain`; no share metrics needed for a pure diff), `segments.date BETWEEN start AND end` (depends on T019 for the date bounds it's called with, though the builder itself takes explicit strings)
- [x] T021 [US3] Add pure `newCompetitorDomains(currentDomains: readonly string[], priorDomains: readonly string[]): string[]` to `src/audit/scoring.ts` — set difference; an empty `priorDomains` (no prior-window data) simply returns every current domain, no special case
- [x] T022 [US3] In `src/bin/audit.ts`, add `campaignPriorAuctionInsights(client, customerId, asOf, days, campaignIds): Promise<Record<number, string[]>>` — fetches `auctionInsightDomainPriorWindowQuery()` rows and groups domains by campaign id (depends on T019, T020)
- [x] T023 [US3] In `src/bin/audit.ts`'s `runAudit()`, wire the current-window (`campaignAuctionInsights()`) and prior-window (`campaignPriorAuctionInsights()`) fetches together: for each scored campaign, compute `newCompetitorDomains()` and merge into `flags`/`impressionShareRecs` via `withAuctionInsightFindings()` (depends on T010, T021, T022)
- [x] T024 [US3] Tests in `src/gaql/builders.test.ts`: `priorWindow()` produces a gapless, non-overlapping window immediately before `dateWindow()`'s; `auctionInsightDomainPriorWindowQuery()` selects only domain identity over the explicit range (depends on T019, T020)
- [x] T025 [US3] Tests in `src/audit/scoring.test.ts`: `newCompetitorDomains()` returns the correct set difference, returns nothing when everything overlaps, and returns every current domain when the prior window is empty (spec Acceptance Scenarios + FR-008) (depends on T021)
- [x] T026 [US3] Tests in `src/bin/audit.test.ts`: `campaignPriorAuctionInsights()` groups domains by campaign from fake rows; a composition test confirms the current-window and prior-window queries are distinguishable (two separate fetches in one run) and drive `new_competitor` via `withAuctionInsightFindings()` (depends on T022, T023)

**Checkpoint**: US3 is independently complete and testable — all three user stories now ship together.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final gate checks, per the issue's Pointers and CLAUDE.md conventions.

- [x] T027 [P] Update `reference/audit.md` to document the `auctionInsights` envelope field and the `losing_to_competitor`/`new_competitor` findings, next to the existing `budget_constrained`/`rank_constrained` section — explicitly note domain + share metrics only, no competitor ad-copy/landing-page scraping (spec FR-010), and that `new_competitor` is a same-run two-window diff with no local state (depends on T010, T016, T023)
- [x] T028 Run `cd skills/adkit/scripts && npm run typecheck && npx vitest run` and fix any failures before calling the feature complete

## Execution Wave DAG

```text
Wave 1 (parallel): T001, T002, T003
Wave 2 (parallel): T004 (needs T002), T005 (needs T002)
Wave 3 (parallel): T006 (needs T003), T007 (needs T004), T008 (needs T005)
Wave 4: T009 (needs T003, T004)
Wave 5: T010 (needs T005, T009)
Wave 6 (parallel): T011, T012, T013 (all need T010); T014 (no deps, can run any time after Wave 1); T019 (no deps, can run any time after Wave 1)
Wave 7: T015 (needs T002, T005) — can actually start as early as Wave 2, listed here for readability
Wave 8: T016 (needs T010, T015)
Wave 9 (parallel): T017 (needs T015), T018 (needs T016)
Wave 10: T020 (needs T019), T021 (no deps, can run any time after Wave 1)
Wave 11: T022 (needs T019, T020)
Wave 12: T023 (needs T010, T021, T022)
Wave 13 (parallel): T024 (needs T019, T020), T025 (needs T021), T026 (needs T022, T023)
Wave 14: T027 (needs T010, T016, T023)
Wave 15: T028 (needs everything)
```

## Dependencies

- **Phase 2 (Foundational)** blocks all user story phases — every story reads `AuctionInsightRow`/`auctionInsightsByCampaign`.
- **US2** (envelope wiring, T009-T013) is built before US1 and US3's audit.ts wiring because both later stories merge findings into the same `campaignServing()` call site US2 establishes — but US2 is still independently testable and shippable on its own (spec Independent Test).
- **US1** (T014-T018) depends on US2's envelope wiring (T010) but not on US3.
- **US3** (T019-T026) depends on US2's envelope wiring (T010) but not on US1 — the prior-window builder/diff (T019-T021) has no dependency on either.
- **Polish** (T027-T028) depends on all three stories being wired in.

## Implementation Strategy

**MVP = US2 + US1** (both P1): the raw per-domain table plus the rank-loss tie-in are the core ask from issue #56. US3 (new-competitor alerting, P2) is valuable but can ship in a follow-up if time-boxed — the prior-window builder and diff function (T019-T021) are fully isolated and don't block US1/US2's envelope or finding.

Suggested order: Phase 1 → Phase 2 → Phase 3 (US2) → Phase 4 (US1) → Phase 5 (US3) → Phase 6. Within Phase 2 and within each story phase, `[P]`-marked tasks can run concurrently.
