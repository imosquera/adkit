# Tasks: Fix Auction Insights query rejection on v24 and surface real fetch errors

**Input**: Design documents from `specs/051-auction-insight-domain-field-fix/` (`spec.md`, `plan.md`)

**Tests**: The source issue's own repro and fix checklist explicitly call for
regression coverage (both the query-shape fix and the error-surfacing fix), so
test tasks are included.

**Organization**: Tasks are grouped by user story to enable independent
implementation and testing.

## Phase 1: Setup

- [ ] T001 Confirm the working tree builds/tests cleanly before changes: run
  `npm --prefix skills/adkit/scripts run typecheck` and
  `npm --prefix skills/adkit/scripts test` to capture the pre-fix baseline.

## Phase 2: Foundational

*No blocking prerequisites — this is a same-module bug fix with no shared
scaffolding to stand up first. Both user stories touch the same query builders
and row type, so their foundational work is captured directly in Phase 3 (US1
is the base the fix depends on; US2 only adds a guard around US1's call site).*

---

## Phase 3: User Story 1 - Auction Insights data actually comes back (Priority: P1) 🎯 MVP

**Goal**: `auctionInsightDomainQuery` / `auctionInsightDomainPriorWindowQuery`
select `segments.auction_insight_domain` `FROM campaign` instead of the v24-rejected
`auction_insight_domain.domain` `FROM auction_insight_domain`, and every reader of
that row shape (`normalizeAuctionInsightRow`, `campaignPriorAuctionInsights`) is
updated in lockstep so the query succeeds and real domain rows flow through to
`auctionInsights` in the audit report.

**Independent Test**: `toGaql(auctionInsightDomainQuery(...))` produces
`FROM campaign` + `segments.auction_insight_domain` (not the old resource/field);
`normalizeAuctionInsightRow` maps a `{ segments: { auction_insight_domain: "x.com" } }`
fixture row to `domain: "x.com"`; `campaignAuctionInsights` end-to-end (fake
client) returns non-empty grouped rows.

### Implementation for User Story 1

- [ ] T002 [US1] In `skills/adkit/scripts/src/gaql/builders.ts`, change
  `auctionInsightDomainQuery` (~line 326) from
  `inListQuery("auction_insight_domain", ["campaign.id", "auction_insight_domain.domain", ...metrics], "campaign.id", campaignIds, [lastNDays(days)])`
  to `inListQuery("campaign", ["campaign.id", "segments.auction_insight_domain", ...metrics], "campaign.id", campaignIds, [lastNDays(days)])`
  — resource becomes `"campaign"`, the domain field becomes
  `"segments.auction_insight_domain"`; the five `metrics.auction_insight_search_*`
  fields are unchanged.
- [ ] T003 [US1] In the same file, change `auctionInsightDomainPriorWindowQuery`
  (~line 354) the same way: resource `"campaign"`, fields
  `["campaign.id", "segments.auction_insight_domain"]` (depends on T002 for
  consistency, though independently editable).
- [ ] T004 [US1] In `skills/adkit/scripts/src/audit/rows.ts`, change
  `RawAuctionInsightRow` (~line 216) from
  `auction_insight_domain: { domain: string }` to
  `segments: { auction_insight_domain: string }`, and update
  `normalizeAuctionInsightRow` (~line 232) from
  `domain: r.auction_insight_domain.domain` to
  `domain: r.segments.auction_insight_domain` (depends on T002).
- [ ] T005 [US1] In `skills/adkit/scripts/src/bin/audit.ts`,
  `campaignPriorAuctionInsights`'s row reducer (~line 601) — change
  `const domain = r.auction_insight_domain.domain;` to
  `const domain = r.segments.auction_insight_domain;` (depends on T004, since it
  reads the same `RawAuctionInsightRow` type).
- [ ] T006 [P] [US1] Update the golden-GAQL-string assertions in
  `skills/adkit/scripts/src/gaql/builders.test.ts`'s `auctionInsightDomainQuery`
  and `auctionInsightDomainPriorWindowQuery` describe blocks (~lines 37-70): the
  expected `toGaql(...)` string changes to
  `"... FROM campaign WHERE campaign.id IN (...) AND segments.date DURING LAST_14_DAYS"`
  with `segments.auction_insight_domain` in the SELECT list, and the
  `q.fields` assertion in the prior-window test becomes
  `["campaign.id", "segments.auction_insight_domain"]` (depends on T002, T003).
- [ ] T007 [P] [US1] Update the fixture rows in
  `skills/adkit/scripts/src/audit/rows.test.ts` (`normalizeAuctionInsightRow`
  cases, ~lines 13, 37) from `auction_insight_domain: { domain: "..." }` to
  `segments: { auction_insight_domain: "..." }` (depends on T004).
- [ ] T008 [P] [US1] Update the fixture rows in
  `skills/adkit/scripts/src/bin/audit.test.ts` (`campaignAuctionInsights` /
  `campaignPriorAuctionInsights` cases, ~lines 389, 400, 728-730, 764, 774) from
  `auction_insight_domain: { domain: "..." }` to
  `segments: { auction_insight_domain: "..." }` (depends on T004, T005).

**Checkpoint**: User Story 1 is independently functional — the primary reported
defect (hard query rejection on v24) is fixed, and every existing test that
exercises the old row shape has been updated to the new one and passes.

---

## Phase 4: User Story 2 - A future rejection is visible, not hidden (Priority: P2)

**Goal**: The two Auction Insights fetches in `runAudit` are guarded by a
try/catch that degrades to empty maps and logs the real Google Ads API error
(via the existing `formatGoogleAdsError` helper) instead of letting a rejection
propagate uncaught or print `(undefined)`.

**Independent Test**: Force `campaignAuctionInsights` (or its underlying
`search` call) to throw a `GoogleAdsFailure`-shaped error with a populated
`errors[]` array and confirm the printed warning line contains that array's
`message` text, not `undefined`; separately, force a plain `Error` and confirm
the warning falls back to a description built from it (never `undefined`).

### Implementation for User Story 2

- [ ] T009 [US2] In `skills/adkit/scripts/src/bin/audit.ts`'s `runAudit`
  (~lines 1262-1275), wrap the `auctionInsightsMap = await campaignAuctionInsights(...)`
  and `const priorDomainsMap = await campaignPriorAuctionInsights(...)` calls in
  a single try/catch: on error, set both `auctionInsightsMap = {}` and
  `priorDomainsMap = {}`, and call
  `emitLines([\`WARNING: auction insights unavailable, skipping (${formatGoogleAdsError(err)})\`])`
  (`formatGoogleAdsError` and `emitLines` are already imported in this file)
  (depends on T002, T003 so the guarded call reflects the fixed query).
- [ ] T010 [P] [US2] Add a regression test to
  `skills/adkit/scripts/src/bin/audit.test.ts`'s `campaignAuctionInsights` /
  `runAudit`-adjacent coverage: a fake client that throws a
  `{ errors: [{ error_code: { query_error: 32 }, message: "Unrecognized field..." }] }`-shaped
  error for the auction-insights query asserts the run does not throw, both
  maps degrade to empty, and the emitted warning line contains
  `"Unrecognized field..."` (not `"undefined"`) (depends on T009).
- [ ] T011 [P] [US2] Add a second case to the same test file: a fake client that
  throws a plain `new Error("network blip")` (no `errors[]`) for the same call
  asserts the warning line still contains a non-`undefined`, non-empty
  description derived from that error (depends on T009).

**Checkpoint**: Both user stories pass — the query itself is fixed (US1) and,
independently, any future rejection of this or a similar query is diagnosable
from the audit's own output (US2) rather than silently swallowed.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T012 Run the full gate suite from `skills/adkit/scripts/`:
  `npm run typecheck`, `npm test` (vitest), and any configured lint command; fix
  any findings (depends on T006, T007, T008, T010, T011).
- [ ] T013 Re-read the `campaignAuctionInsights` / `campaignPriorAuctionInsights`
  JSDoc comments in `skills/adkit/scripts/src/bin/audit.ts` and the
  `auctionInsightDomainQuery` / `auctionInsightDomainPriorWindowQuery` doc
  comments in `builders.ts` for any stale reference to the old resource/field
  name, updating to match the new shape (depends on T002, T003, T004, T005).

## Dependencies & Execution Order

- **Setup (Phase 1)**: T001 — no dependencies, run first to capture the baseline.
- **Foundational (Phase 2)**: none — folded into Phase 3.
- **User Story 1 (Phase 3)**: T002, T003 (independent of each other) → T004
  (needs T002) → T005 (needs T004) → T006 (needs T002, T003), T007 (needs T004),
  T008 (needs T004, T005). US1 has no dependency on US2.
- **User Story 2 (Phase 4)**: T009 (needs T002, T003) → T010, T011 (need T009).
  Depends on US1's query fix landing first so the guarded call exercises the
  corrected query, but is otherwise a separate concern (error handling, not
  query shape).
- **Polish (Phase 5)**: T012 depends on all test tasks (T006, T007, T008, T010,
  T011); T013 depends on T002, T003, T004, T005.

## Execution Wave DAG

- **Wave 1** (parallel): T001, T002, T003.
- **Wave 2** (parallel, after Wave 1): T004 (needs T002), T006 (needs T002, T003).
- **Wave 3** (parallel, after Wave 2): T005 (needs T004), T007 (needs T004),
  T009 (needs T002, T003).
- **Wave 4** (parallel, after Wave 3): T008 (needs T004, T005), T010 (needs T009),
  T011 (needs T009), T013 (needs T002-T005).
- **Wave 5** (after Wave 4): T012 — full gate run, needs every test task green.

## Implementation Strategy

**MVP = User Story 1** (T001-T008): fixes the primary reported defect — the
hard query rejection that makes every audit run read "no competitors found."
**User Story 2** (T009-T011) is the secondary fix the issue itself calls for
(hardening the swallowed-error catch) and ships in the same PR/branch — it is
explicitly listed as part of the issue's own fix checklist (item 3: "Harden the
catch... so a future rejection surfaces instead of printing `(undefined)`"),
not a separately-scoped addition, so there is no reason to split it into a
second PR.
