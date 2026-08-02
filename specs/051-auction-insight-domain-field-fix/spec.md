# Feature Specification: Fix Auction Insights query rejection on v24 and surface real fetch errors

**Feature Branch**: `051-auction-insight-domain-field-fix`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "audit: auction_insight_domain query rejects 'auction_insight_domain.domain' field (v24), error swallowed as undefined (GitHub issue #67)"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Auction Insights data actually comes back (Priority: P1)

An operator runs `/adkit audit` against a live account. Today the Auction Insights
fetch is rejected outright by the Google Ads API (query_error 32, "Unrecognized
field in the query: 'auction_insight_domain.domain'") on every single run, so the
audit report always reads "no competitors found" even when competitors are, in
fact, winning share. The operator needs the underlying query fixed so the audit
returns real domain rows and the `losing_to_competitor` / `new_competitor`
findings are populated from real data again.

**Why this priority**: This is the core defect — without a working query, no
downstream behavior in this feature area can be evidence-based at all.

**Independent Test**: Run `ads.sh audit --customer <id> --days 30` against a live
account and confirm the Auction Insights section returns real domain rows instead
of an empty `{}`, with no `query_error(32)` in the process.

**Acceptance Scenarios**:

1. **Given** a live Google Ads account on API v24 with active auction competition,
   **When** `/adkit audit` fetches Auction Insights for a campaign, **Then** the
   query succeeds and returns rows with a competing domain and its associated
   share metrics (impression share, overlap rate, position-above rate,
   top-impression percentage, outranking share).
2. **Given** the same account, **When** the audit runs at both `--days 14` and
   `--days 30`, **Then** both windows succeed identically (matching the two
   windows reported broken in the original bug).
3. **Given** a fixed query, **When** `campaignAuctionInsights` computes the
   `new_competitor` check, **Then** it still diffs the current window's domains
   against the prior window's domains fetched via the sibling prior-window query,
   with no other change to that comparison logic.

---

### User Story 2 - A future rejection is visible, not hidden (Priority: P2)

Today, when the Auction Insights fetch fails, the catch block prints
`WARNING: auction insights unavailable, skipping (undefined)` because Google Ads
API errors carry their message in a structured `errors[]` array, not in
`.message`. An operator (or a future maintainer) needs the real reason to show up
in that warning so a future regression is diagnosable from the log line alone,
instead of requiring someone to bypass the catch and inspect the raw error object
by hand (as was done to produce this bug's repro).

**Why this priority**: Secondary to the data fix itself, but this is what let the
original defect go unnoticed for every run — fixing only the query without
hardening the error surface leaves the same blind spot for the next regression.

**Independent Test**: Force a query rejection (e.g. temporarily pass an invalid
field) and confirm the printed warning includes the Google Ads API's structured
error message text, not the literal string `(undefined)`.

**Acceptance Scenarios**:

1. **Given** `campaignAuctionInsights` throws a Google Ads API error carrying a
   populated `errors[]` array, **When** the catch in `audit.ts` handles it,
   **Then** the printed warning includes the joined `errors[].message` text from
   that array.
2. **Given** `campaignAuctionInsights` throws a plain JS `Error` with no
   `errors[]` array (a non-Ads error, e.g. a network failure), **When** the catch
   handles it, **Then** the printed warning falls back to `.message` rather than
   printing `undefined`.

---

### Edge Cases

- What happens when the account has no auction competition at all in the window
  (a genuinely empty result, not a rejected query)? The audit must still report
  "no competitors found" in that case — the fix must not turn a legitimately empty
  result into a false warning.
- How does the system handle an account that's ineligible for Auction Insights
  reporting entirely (e.g. too little traffic for Google to disclose competitor
  identity, a known and separate Google-side restriction)? This must continue to
  degrade gracefully (empty result, no crash) rather than being treated as the
  same failure mode as the v24 field-name break.
- How does the fixed catch handle an error object whose `errors[]` array exists
  but is empty or whose entries lack a `message` field? The fallback to
  `.message` (or a generic description) must still avoid printing `undefined`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Auction Insights query builder MUST request the competing
  domain via a field name and query shape that the pinned Google Ads API version
  (v24) actually recognizes, replacing the rejected
  `auction_insight_domain.domain` / `FROM auction_insight_domain` shape.
- **FR-002**: Both the current-window query (`auctionInsightDomainQuery`) and the
  prior-window query (`auctionInsightDomainPriorWindowQuery`) MUST be updated
  consistently, since the `new_competitor` check depends on comparing their
  outputs against each other.
- **FR-003**: The fixed query MUST continue to return, per competing domain, all
  five share metrics currently requested (impression share, overlap rate,
  position-above rate, top-impression percentage, outranking share) for the
  current-window query; the prior-window query MUST continue to return only the
  domain (no share metrics), unchanged from today's scope.
- **FR-004**: `campaignAuctionInsights` MUST continue to be guarded by a
  try/catch that degrades to an empty result rather than crashing the whole
  audit, for both genuinely-empty results and any future rejection.
- **FR-005**: The catch in `audit.ts` MUST log the Google Ads API's structured
  error detail (the `errors[].message` values) when the thrown error carries an
  `errors[]` array, instead of the current `(err as Error).message`-only logging
  that prints `(undefined)` for this class of error.
- **FR-006**: When the thrown error does NOT carry a structured `errors[]` array
  (e.g. a plain JS error), the catch MUST fall back to `(err as Error).message`
  so non-Ads errors remain diagnosable exactly as they are today.
- **FR-007**: After the fix, running `/adkit audit` against a live account MUST
  populate `auctionInsights` with real domain rows (not `{}`) so the
  `losing_to_competitor` / `new_competitor` findings can be evidence-based again.

