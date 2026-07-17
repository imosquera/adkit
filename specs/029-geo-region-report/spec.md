# Feature Specification: Geo / region breakdown for /ads:report

**Feature Branch**: `029-geo-region-report`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Add geo / region breakdown to /ads:report — port the geo/region reporting behaviour from lead-drop PR #112 into the adkit source so the report gains a per-country and per-region performance breakdown."

## Clarifications

### Session 2026-07-17

- Q: How should `cost_per_conversion` be handled when aggregating a geo/region bucket? → A: Recompute from summed totals (cost ÷ conversions, 0 when conversions=0), same treatment as ctr/avg_cpc — summing a per-unit rate across buckets is meaningless. (lead-drop PR #112 summed it additively; adkit corrects this and the vendored copy should follow.)
- Q: Key each bucket by the raw geo-target id, or resolve to human-readable names? → A: Key by the raw identifier the API returns (numeric country criterion id for `geo`; region segment/resource name for `geo_regions`); no name-resolution lookups. Downstream analyze/visualize resolves names.
- Q: What happens to rows whose geographic key is null/absent? → A: Group them into a single deterministic sentinel bucket rather than dropping them, so aggregated totals still reconcile with the underlying rows.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See spend and performance by country (Priority: P1)

A marketer running `/ads:report` for a customer wants to know which countries their
ad spend is going to and how each country performs, so they can spot geographies that
waste budget or convert well. Today the report shows campaign, ad-group, ad, keyword
and search-term breakdowns but nothing geographic — the marketer has no way to answer
"where, geographically, is my money going?" from the report output.

**Why this priority**: This is the core of the request and delivers value on its own —
a country-level breakdown is the single most common geographic question and is a
complete, useful slice even without the finer region breakdown.

**Independent Test**: Run the report pull for a customer with geographic data and
confirm the output contains a `geo` collection with one row per country, each carrying
that country's aggregated cost, impressions, clicks, conversions, and correctly
recomputed ctr / avg_cpc, ordered by cost descending.

**Acceptance Scenarios**:

1. **Given** a customer whose campaigns served impressions in multiple countries,
   **When** the report is pulled, **Then** the output includes a `geo` list with one
   entry per country (identified by its geo target constant id), each entry holding the
   summed additive metrics for that country.
2. **Given** several campaigns that each served in the same country, **When** the
   report is pulled, **Then** that country appears exactly once in `geo` with the
   metrics summed across all of those campaigns.
3. **Given** the aggregated `geo` rows, **When** ctr and avg_cpc are presented, **Then**
   they are recomputed from the summed totals (not carried over or averaged from
   individual rows), and the list is ordered by cost descending.

---

### User Story 2 - Drill into US state / metro regions (Priority: P2)

The same marketer wants a finer breakdown below country level — US state / metro
regions — so they can see sub-national performance for their largest market.

**Why this priority**: Valuable but secondary; it refines the country view and reuses
the same aggregation machinery, so it is a natural second slice once the country
breakdown exists.

**Independent Test**: Run the report pull for a customer with regional data and confirm
the output contains a `geo_regions` collection keyed by region, aggregated and ordered
the same way as `geo`.

**Acceptance Scenarios**:

1. **Given** a customer with impressions across several regions, **When** the report is
   pulled, **Then** the output includes a `geo_regions` list with one entry per region,
   aggregated and cost-descending ordered like `geo`.
2. **Given** the region rows, **When** ctr and avg_cpc are presented, **Then** they are
   recomputed post-aggregation exactly as for the country rows.

---

### Edge Cases

- **No geographic data**: a customer with no geographic rows in the window yields an
  empty `geo` / `geo_regions` list (the key is still present), never a crash.
- **Zero impressions or zero clicks in a bucket**: ctr and avg_cpc for that bucket
  resolve to 0 rather than dividing by zero.
- **A single campaign serving one country**: that country appears once with that
  campaign's metrics unchanged (aggregation over one row is the identity).
- **Rows whose geographic key is absent/null**: grouped into a single deterministic
  sentinel bucket (never dropped, never thrown) so aggregated totals still reconcile
  with the underlying rows.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The report pull MUST issue a country-level geographic query that returns
  per-campaign rows carrying a country geo-target identifier plus the standard report
  metric set (cost, impressions, clicks, ctr, avg_cpc, conversions, cost_per_conversion)
  over the report's date window.
- **FR-002**: The report pull MUST issue a region-level geographic query that returns
  per-campaign rows carrying a region identifier plus the same standard metric set over
  the same date window.
- **FR-003**: Both geographic queries MUST honour the report's existing window and
  status conditions consistently with the other report queries (same date filter, same
  enabled-status filter), so geographic totals reconcile with the rest of the report.
- **FR-004**: The report MUST aggregate the country rows into a `geo` collection keyed
  by country identifier, summing the additive metrics (cost, impressions, clicks,
  conversions) across all campaigns for each country.
- **FR-005**: The report MUST aggregate the region rows into a `geo_regions` collection
  keyed by region identifier, summing the additive metrics the same way.
- **FR-006**: For each aggregated bucket, the report MUST recompute all derived rates
  (ctr, avg_cpc, and cost_per_conversion) from the summed totals after aggregation, and
  MUST NOT carry the per-row derived rates through unchanged. cost_per_conversion is
  cost ÷ conversions (0 when conversions is 0).
- **FR-007**: Divide-by-zero for the derived rates MUST resolve to 0 (zero impressions →
  ctr 0; zero clicks → avg_cpc 0), matching the existing report metric behaviour.
- **FR-008**: Both `geo` and `geo_regions` collections MUST be ordered by cost
  descending.
- **FR-009**: Both `geo` and `geo_regions` MUST be added to the report's pull output
  alongside the existing collections, present (as empty lists when there is no data) in
  every report so downstream consumers can rely on the keys.
- **FR-010**: The change MUST NOT alter the existing report collections, their ordering,
  their values, or the report's output file format beyond adding the two new keys.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A report pulled for a customer with geographic activity shows a per-country
  breakdown covering 100% of the countries that received impressions in the window, with
  no country listed more than once.
- **SC-002**: For every geographic bucket, the summed cost / impressions / clicks equal
  the totals of the underlying per-campaign rows for that bucket (exact reconciliation),
  and recomputed ctr / avg_cpc match those summed totals.
- **SC-003**: Running the report for a customer with no geographic data completes
  successfully and emits empty `geo` / `geo_regions` lists rather than erroring.
- **SC-004**: All existing report output (campaigns, daily, ad groups, ads, keywords,
  search terms, recommendations) is byte-for-byte unchanged aside from the two added
  collections.

