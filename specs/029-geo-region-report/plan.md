# Implementation Plan: Geo / region breakdown for /ads:report

**Branch**: `029-geo-region-report` | **Spec**: [spec.md](./spec.md) | **Issue**: #6

## Summary

Add a per-country (`geo`) and per-region (`geo_regions`) performance breakdown to the
`/ads:report` data pull, porting the behaviour of lead-drop PR #112 onto adkit's
TypeScript source. Two new pure GAQL builders read `geographic_view` (keyed by
`geographic_view.country_criterion_id` and by `segments.geo_target_region`); the report
shell pulls both alongside the existing six queries and a pure aggregation step rolls the
per-campaign rows up per geo key — summing additive metrics and recomputing ctr / avg_cpc /
cost_per_conversion from the summed totals — ordered by cost descending. No existing report
collection changes.

## Technical Context

**Language/Version**: TypeScript (ESM, `node:` built-ins), run via the `ads.sh` dispatcher.
**Primary Dependencies**: none new — reuses `SearchArgs`, the `reportQuery` factory, `metricDict`, `safeRatio`, the `AdsClient.searchStructured` seam, and `yaml`.
**Storage**: writes YAML to `ads/output/reports/<date>-<customer>-raw.yaml` (unchanged path/format, two added keys).
**Testing**: vitest (`skills/adkit/scripts/vitest.config.ts`, `include: src/**/*.test.ts`); colocated `*.test.ts`.
**Target Platform**: Node CLI.
**Project Type**: single project (CLI tool under `skills/adkit/scripts/`).
**Performance Goals**: two extra reads added to the existing `Promise.all` fan-out — no added latency beyond the slower of the two new queries.
**Constraints**: functional style (pure core, IO at edges); parse-don't-validate at the `SearchArgs` boundary; existing report output must stay byte-identical aside from the two new keys.
**Scale/Scope**: ~2 builders + 2 row shapes + 1 pure rollup helper + `ReportData`/`pull`/`shapeRows` wiring, plus tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution at `.specify/memory/constitution.md` is the **unpopulated stub
template** (all `[PRINCIPLE_N_NAME]` placeholders); `constitution_audit.py list` matches no
principles and `validate` treats the section as a no-op. In its absence the binding
engineering conventions are the repo's `CLAUDE.md`. This feature is evaluated against those:

- **Functional style** (`CLAUDE.md` §1): the two builders are pure functions returning
  `SearchArgs`, and the geo rollup is a pure `reduce`/`map`/`sort` over records with no
  parameter mutation — IO stays in `pull`/`main`. Verdict: **PASS**
- **Parse, don't validate** (`CLAUDE.md` §2): raw SDK rows enter typed as narrow row
  interfaces and are normalised once through the existing `metricDict` parser; no
  downstream re-checks are added. See the Parse Boundaries section below. Verdict: **PASS**
- **No classes for logic** (`CLAUDE.md` §1): no classes introduced; only functions and
  interfaces. Verdict: **PASS**

## Project Structure

### Documentation (this feature)

```
specs/029-geo-region-report/
├── spec.md
├── plan.md
├── tasks.md
└── requirements.md
```

### Source Code (repository root)

```
skills/adkit/scripts/src/
├── gaql/
│   ├── builders.ts              # + geoQuery(), geoRegionQuery() (report family)
│   ├── builders.test.ts         # + assertions for the two new builders
│   └── builders-parity.test.ts  # + golden toGaql() parity strings
└── bin/
    ├── report.ts                # + GeoRow/GeoRegionRow, Geo/GeoRegion records,
    │                            #   ReportData.geo/geo_regions, rollup helper,
    │                            #   pull + shapeRows wiring
    └── report.test.ts           # + shapeRows aggregation + main fakeClient geo rows
```

**Structure Decision**: single project; all changes live under `skills/adkit/scripts/src/`
in the two existing modules (`gaql/builders.ts`, `bin/report.ts`) and their colocated tests.
`lib/report.ts` is **not** touched: unlike lead-drop's `lib/report.py` (which re-exports the
builders), adkit imports builders directly from `gaql/builders` in `bin/report.ts`, so the
Python import-shuffle in PR #112 has no adkit equivalent.

## Parse Boundaries

TypeScript feature. The boundary discipline reuses the existing report machinery — this
feature adds no new untyped surface.

1. **Trust boundaries** — the untrusted input is the Google Ads API response rows for the
   two new `geographic_view` reads, arriving via `AdsClient.searchStructured<Row>()`. Each
   row is received under a narrow, explicit row interface (`GeoRow`, `GeoRegionRow`) that
   names only the fields read (`campaign.id`, the geo key, and the shared `metrics` block) —
   never `any`. This matches how the existing six report reads are typed (`CampaignTotalsRow`
   et al.).
2. **Domain types** — the earned type is `MetricDict` (`src/lib/report.ts`): the normalised
   `{ cost, impressions, clicks, ctr, avg_cpc, conversions, cost_per_conversion }` shape.
   The two shaped records `GeoRecord = { country_criterion_id: string } & MetricDict` and
   `GeoRegionRecord = { region: string } & MetricDict` carry it. Geo keys are stringified at
   the shaping step (`String(...)`) so a numeric criterion id can never be confused with the
   campaign id it was grouped away from. `SearchArgs` (`src/gaql/search-args.ts`) is the
   parsed-proof type on the query side — its doc already states "A parsed value is a proof".
3. **Parsers** — `metricDict(options)` in `src/lib/report.ts` is the single parser that maps
   a raw `RowMetrics` blob to the `MetricDict` domain type (micros→currency, guarded ctr,
   counts coerced). The new geo rows go through the existing `metricsOf()` wrapper in
   `bin/report.ts`, which calls `metricDict` — no new parser, no re-validation. The pure
   rollup helper consumes already-parsed `MetricDict` values and never re-parses raw rows.
4. **Library choice** — hand-rolled row interfaces + the existing `metricDict` parser, not a
   schema library. Rationale: the report layer deliberately uses no zod (see `lib/report.ts`
   header and the codebase's zod-only-on-the-write-side split); adding a schema dependency
   here would break that consistency for zero benefit, since the SDK already returns typed
   nested records and `metricDict` is the established normalisation boundary.

## Complexity Tracking

No constitution violations and no added complexity to justify — the feature is a thin,
additive extension of the existing report family. This table is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| (none)    | —          | —                                    |
