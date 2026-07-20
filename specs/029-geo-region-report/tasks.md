---
description: "Task list for geo/region breakdown for /ads:report"
---

# Tasks: Geo / region breakdown for /ads:report

**Input**: Design documents from `/specs/029-geo-region-report/`

**Prerequisites**: plan.md (required), spec.md (required)

**Tests**: Included — the report layer is fully unit-tested (`report.test.ts`,
`builders.test.ts`, `builders-parity.test.ts`) and the spec's Success Criteria
(exact reconciliation, empty-list behaviour) are only verifiable with tests.

**Organization**: Grouped by user story. US1 (country breakdown) is the MVP and is
independently shippable without US2 (region breakdown).

## Path Conventions

All source lives under `skills/adkit/scripts/` (paths below are relative to it).

---

## Phase 1: Setup

No setup required — the package, dependencies, vitest, and eslint configs already exist
and no new dependency is introduced.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The pure aggregation helper shared by both user stories.

- [ ] T001 Add a pure geo-rollup helper to `src/bin/report.ts` that groups
  `{ key: string } & MetricDict` rows by `key`, sums the additive metrics
  (cost, impressions, clicks, conversions), recomputes ctr / avg_cpc /
  cost_per_conversion from the summed totals via `safeRatio` (imported from
  `../lib/report.js`), and returns the buckets sorted by cost descending — no
  parameter mutation (reduce/map/sort only, mirroring the existing `byCampaign` style).

---

## Phase 3: User Story 1 — Country breakdown (Priority: P1) 🎯 MVP

**Goal**: `/ads:report` output gains a `geo` collection: one aggregated row per country
(keyed by `country_criterion_id`), summed and cost-descending ordered.

**Independent Test**: Pull a report for a customer with multi-country data and confirm
`geo` holds one entry per country with summed metrics and recomputed rates, ordered by
cost desc; a no-geo-data customer yields an empty `geo` list.

- [ ] T002 [P] [US1] Add `geoQuery(start, end)` to `src/gaql/builders.ts` in the report
  family: `reportQuery("geographic_view", ["campaign.id", "geographic_view.country_criterion_id"], start, end)`.
- [ ] T003 [US1] In `src/bin/report.ts` add the `GeoRow` SDK row interface
  (`campaign.id`, `geographic_view.country_criterion_id`, `metrics`), the
  `GeoRecord = { country_criterion_id: string } & MetricDict` shaped type, and the
  `geo: GeoRecord[]` field on `ReportData` (depends on T001)
- [ ] T004 [US1] In `src/bin/report.ts` wire `geoQuery` into `pull()`'s `Promise.all`
  and aggregate the rows in `shapeRows()` into `geo` via the T001 helper (nullish geo key
  → single deterministic sentinel bucket, never dropped) (depends on T001, T002, T003)
- [ ] T005 [P] [US1] Add a `geoQuery` unit test to `src/gaql/builders.test.ts`
  (resource `geographic_view`, fields contain the country dim + metrics, conditions have
  ENABLED + date-between) (depends on T002)
- [ ] T006 [P] [US1] Add the `geoQuery` golden `toGaql()` parity string to
  `src/gaql/builders-parity.test.ts` (depends on T002)
- [ ] T007 [US1] Add `shapeRows` geo-aggregation tests to `src/bin/report.test.ts` (sum
  across campaigns, recomputed ctr/avg_cpc/cost_per_conversion, cost-desc order, empty
  input → empty list) and extend the `main` fakeClient to return `geographic_view` rows,
  distinguishing the country query by its `country_criterion_id` field (depends on T004)

**Checkpoint**: US1 is a complete, shippable MVP — `geo` breakdown works end-to-end.

---

## Phase 4: User Story 2 — Region breakdown (Priority: P2)

**Goal**: `/ads:report` output gains a `geo_regions` collection keyed by
`segments.geo_target_region`, aggregated and ordered like `geo`.

**Independent Test**: Pull a report for a customer with regional data and confirm
`geo_regions` holds one aggregated entry per region, cost-descending; no-data → empty list.

- [ ] T008 [US2] Add `geoRegionQuery(start, end)` to `src/gaql/builders.ts`:
  `reportQuery("geographic_view", ["campaign.id", "segments.geo_target_region"], start, end)`
  (depends on T002 — same file, report family)
- [ ] T009 [US2] In `src/bin/report.ts` add the `GeoRegionRow` interface
  (`campaign.id`, `segments.geo_target_region`, `metrics`), the
  `GeoRegionRecord = { region: string } & MetricDict` type, the
  `geo_regions: GeoRegionRecord[]` field on `ReportData`, and wire `geoRegionQuery` into
  `pull()` + aggregate into `geo_regions` in `shapeRows()` via the T001 helper
  (depends on T004)
- [ ] T010 [P] [US2] Add `geoRegionQuery` builder + golden parity tests to
  `src/gaql/builders.test.ts` and `src/gaql/builders-parity.test.ts` (depends on T008)
- [ ] T011 [US2] Add `geo_regions` aggregation tests to `src/bin/report.test.ts` and
  extend the `main` fakeClient to return region rows for the `geographic_view` query
  carrying `geo_target_region` (depends on T009)

**Checkpoint**: both breakdowns present; report unchanged aside from the two new keys.

---

## Phase 5: Polish & Gates

- [ ] T012 Run all gates from `skills/adkit/scripts/`: `npm run typecheck`, `npm run lint`,
  `npx vitest run`, the constitution audit, and the parse-dont-validate scanner; fix to
  green (depends on T007, T011)

---

## Execution Wave DAG

- **Wave 1** (foundational): T001
- **Wave 2** (builders + US1 types, parallel): T002, T003
- **Wave 3**: T004 (report wiring) ‖ T005, T006 (US1 builder tests) ‖ T008 (US2 builder)
- **Wave 4**: T007 (US1 report tests) ‖ T009 (US2 report wiring) ‖ T010 (US2 builder tests)
- **Wave 5**: T011 (US2 report tests)
- **Wave 6**: T012 (gates)

## Dependencies

- US1 depends only on the foundational helper (T001) and is independently shippable.
- US2 depends on US1's report wiring (T004/T009 both edit `shapeRows`/`pull`, serialized by file).
- All builder tasks touching `builders.ts` (T002, T008) serialize on that file.
- All `report.ts` tasks (T003, T004, T009) serialize on that file.

## Implementation Strategy

MVP = Phase 3 (US1). Ship the country breakdown first; add the region breakdown (US2) as
a second increment. Gates (T012) run once both are in to keep the tree green.
