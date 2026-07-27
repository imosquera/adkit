# Feature Specification: Fix GAQL SELECT/WHERE field mismatch in report queries

**Feature Branch**: `045-report-gaql-select-clause-fix`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "report: GAQL rejected — 'campaign.status' referenced but missing from SELECT clause"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Daily campaign report succeeds end to end (Priority: P1)

An operator runs `ads.sh report <customer> --days N` to see per-day, per-campaign
performance for a live account. Today this fails outright because the Google Ads
API rejects one of the underlying queries as malformed.

**Why this priority**: This is a total failure of the `report` command's core
purpose — no report is produced at all, for any account that has a manager
resolved correctly. It blocks every downstream use of report data.

**Independent Test**: Run `ads.sh report <customer> --days 7` against a real
account with enabled, serving campaigns and confirm it completes without a GAQL
error and returns non-empty daily rows.

**Acceptance Scenarios**:

1. **Given** a customer account with at least one ENABLED campaign serving in the
   last N days, **When** an operator runs `ads.sh report <customer> --days N`,
   **Then** the command completes successfully and prints per-day, per-campaign
   metrics (impressions, clicks, cost, conversions) with no
   "must be present in SELECT clause" error.
2. **Given** a customer account with zero ENABLED campaigns in the window,
   **When** an operator runs `ads.sh report <customer> --days N`, **Then** the
   command completes successfully and reports an empty daily series (not an
   error).

### Edge Cases

- What happens when a report query's WHERE/ORDER BY/segments condition
  references a field also needed for correctness (e.g. campaign status) but the
  query's SELECT list doesn't include it? The query construction must guarantee
  this can't happen, rather than relying on each call site remembering to add it.
- How does the fix behave for every other existing report query (campaign
  totals, ad group, ad, keyword, search term, geo, geo region) — none of these
  should regress even though only the daily campaign query is currently broken.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The report command MUST successfully query per-day, per-campaign
  performance data without the Google Ads API rejecting the query for a
  SELECT/WHERE field mismatch.
- **FR-002**: Every report query the system constructs MUST include, in its
  SELECT fields, every field that query also references in a WHERE, ORDER BY, or
  segmenting condition.
- **FR-003**: The guarantee in FR-002 MUST be enforced at the shared query-
  construction layer (not by patching one hand-written query string), so that
  adding a new report query or WHERE condition later cannot reintroduce this
  class of bug.
- **FR-004**: Existing report queries whose SELECT clause already contains every
  field they filter/order/segment on MUST continue to produce the same output
  fields as before (no behavior change for already-correct queries).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `ads.sh report <customer> --days 7` run against a live, serving
  account returns per-day/per-campaign metrics with zero
  "must be present in SELECT clause" errors.
- **SC-002**: 100% of report queries constructed by the system have a SELECT
  clause that is a superset of the fields referenced in their own WHERE, ORDER
  BY, and segmenting conditions, verified by an automated test that inspects
  every generated query.
