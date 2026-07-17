# Tasks: Migrate read commands to the official google-ads-mcp server

**Input**: Design documents from `specs/011-migrate-reads-google-ads-mcp/` (plan.md, spec.md)

**Tests**: Existing builder/client tests are *updated* for the structured-args
refactor (FR-009); new unit tests are added for `toGaql` and the backend selector.
Fixture-style fakes gain a one-line `searchStructured` that delegates through
`toGaql`, so their existing GAQL-substring assertions keep passing unchanged.

**Organization**: Grouped by user story to enable independent verification.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Phase 1: Setup

No new package or scaffolding — this feature edits the existing
`skills/adkit/scripts` package and adds two source files within it.

## Phase 2: Foundational (blocks all stories)

- [ ] T001 [US1] Create `skills/adkit/scripts/src/gaql/search-args.ts`: export the `SearchArgs` type (`{ resource: string; fields: readonly string[]; conditions: readonly string[]; orderings?: readonly string[]; limit?: number }`) and a pure `toGaql(args: SearchArgs): string` that assembles `SELECT {fields join ", "} FROM {resource}`, appends ` WHERE {conditions join " AND "}` only when non-empty, ` ORDER BY {orderings join ", "}` only when non-empty, and ` LIMIT {n}` only when `limit` is set — matching today's builder strings exactly.

---

## Phase 3: User Story 1 - Structured builders + toGaql (Priority: P1) 🎯 MVP

**Goal**: every read builder in `gaql/builders.ts` returns a `SearchArgs`; `toGaql`
reproduces the prior GAQL strings; id guarding preserved.

**Independent Test**: `vitest run` in `skills/adkit/scripts` passes with new
assertions that `toGaql(builder(...))` equals the pre-change GAQL string for each
builder and that non-digit ids still throw.

### Implementation for User Story 1

- [ ] T002 [US1] In `skills/adkit/scripts/src/gaql/builders.ts`, convert every read builder (report: `campaignTotalsQuery`, `campaignDailyQuery`, `adGroupQuery`, `adQuery`, `keywordQuery`, `searchTermQuery`; audit: `auditKeywordsQuery`, `auditKeywordMetricsQuery`, `auditSearchTermsQuery`, `auditCampaignsQuery`, `auditExtCountQuery`, `auditQualityScoreQuery`, `auditAdGroupAdQuery`, `auditLandingPageMobileQuery`, `auditPolicyTopicsQuery`, `auditServingQuery`; apply-fixes reads: `applyNegativesQuery`, `applyBudgetsQuery`, `applyCampaignStatusesQuery`, `applySearchPartnersQuery`, `applyAdGroupStatusesQuery`, `applyAdGroupNamesQuery`, `applyLanguagesQuery`, `applyHeadlinesQuery`, `applyPositiveKeywordsQuery`) to return `SearchArgs` instead of `string`, keeping `gaqlId()` guarding inside `conditions` and preserving `_METRICS`/`_where` fragment reuse (depends on T001)
- [ ] T003 [US1] In `skills/adkit/scripts/src/gaql/builders.test.ts`, update existing assertions to read from `SearchArgs` and/or `toGaql(...)`, add a `toGaql`-equivalence assertion per representative builder, and keep the digits-only throw tests (depends on T002)
- [ ] T004 [P] [US1] Add `skills/adkit/scripts/src/gaql/search-args.test.ts`: unit-test `toGaql` clause assembly and omission (empty conditions/orderings/limit) (depends on T001)

**Checkpoint**: builders + toGaql fully self-consistent and unit-tested.

---

## Phase 4: User Story 2 - Reversible backend seam defaulting to SDK (Priority: P1)

**Goal**: `AdsClient.searchStructured(SearchArgs)` exists, SDK client satisfies it via
`toGaql`, and a selector parses one env flag into a backend defaulting to SDK.

**Independent Test**: `vitest run` passes; the SDK client's `searchStructured` returns
the same rows as `search(toGaql(args))`; the selector returns SDK by default.

### Implementation for User Story 2

- [ ] T005 [US2] In `skills/adkit/scripts/src/lib/auth.ts`, extend the `AdsClient` interface with `searchStructured<Row>(customerId: string, args: SearchArgs): Promise<Row[]>` (keep `search(string)` for the raw/inline `ads/entities.ts` path), and implement it in `loadClient` as `search(customerId, toGaql(args))` (depends on T001)
- [ ] T006 [US2] In `skills/adkit/scripts/src/lib/auth.ts`, add `type ReadBackend = "sdk" | "mcp"`, a pure `parseReadBackend(raw: string | undefined): ReadBackend` (default `"sdk"` for absent/unrecognized), and a `readBackend()` selector reading `ADKIT_READ_BACKEND` once (depends on T005)
- [ ] T007 [US2] Update the builder-driven read call-sites to use `searchStructured`: `skills/adkit/scripts/src/lib/report.ts` + `src/bin/report.ts` (`runQuery`), `src/bin/audit.ts` (query helper), `src/bin/apply-fixes.ts` (all `appl*Query` reads) — passing the builder's `SearchArgs` directly (depends on T005)
- [ ] T008 [US2] Update fakes to implement `searchStructured` by delegating through `toGaql` to their existing substring `pick(query)`: `src/bin/audit.test.ts`, `src/bin/report.test.ts`, `src/lib/report.test.ts`, `src/bin/apply-fixes.test.ts` (depends on T007)
- [ ] T009 [P] [US2] In `skills/adkit/scripts/src/lib/auth.test.ts`, add tests: SDK `searchStructured(args)` == `search(toGaql(args))` (via a stub), and `parseReadBackend` defaults + recognized values (depends on T006)

**Checkpoint**: all reads flow through the structured seam; suite green under default SDK backend.

---

## Phase 5: User Story 3 - MCP seam + docs (Priority: P2)

**Goal**: `McpAdsClient` seam consuming `SearchArgs` exists (live wiring gated), and
docs record the integration path, runtime/auth prerequisites, and SDK-only carve-outs.

**Independent Test**: type-check passes with the seam present; reference docs state
the path, prerequisites, and that `keyword-ideas` + mutations stay on the SDK.

### Implementation for User Story 3

- [ ] T010 [US3] Add `skills/adkit/scripts/src/lib/mcp-client.ts`: an `McpAdsClient` factory returning an `AdsClient`-shaped read client whose `searchStructured` maps `SearchArgs` → the MCP `search` tool call shape, with the live transport (spawn google-ads-mcp over stdio) clearly gated/marked TODO and throwing a descriptive "MCP runtime not configured" error until wired — never breaking the default SDK path or the test suite (depends on T005)
- [ ] T011 [P] [US3] Update `skills/adkit/reference/` setup docs: document the embedded-stdio integration path, the `pipx` + MCP-server + env prerequisites, `google-ads.yaml`-reuse (ADC noted as alternative), that SDK remains the default read backend, and that `keyword-ideas` + `research` (both KeywordPlanIdeaService) + all mutations remain SDK-only. Add a short SDK-only note to `skills/adkit/reference/research.md`. (depends on T006)

**Checkpoint**: seam + docs in place; live cutover deferred to a human with a test account.

---

## Phase 6: Gates

- [ ] T012 Run typecheck, `vitest run`, eslint, and the parse-dont-validate scanner in `skills/adkit/scripts`; drive all to green (depends on T003, T004, T008, T009, T010, T011)

## Dependencies summary

- T001 blocks T002, T004, T005.
- T002 blocks T003. T005 blocks T006, T007, T010. T007 blocks T008.
- T012 is the final gate over everything.
