# Feature Specification: Auction Insights competitor visibility

**Feature Branch**: `047-auction-insights-competitors`

**Created**: 2026-08-01

**Status**: Draft

**Input**: GitHub issue #56 — "audit: pull Auction Insights and surface which competitors are winning share"

## Clarifications

### Session 2026-08-01

- Q: What outranking-share threshold triggers a `losing_to_competitor` finding? → A: 60% — matches the issue's suggested default and the audit's existing convention of an explicit round-number share-loss threshold (`rank_constrained`'s own `>10%` lost-IS threshold).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See who you're losing impression share to (Priority: P1)

An account operator runs `ads.sh audit` on a campaign that is already flagged `rank_constrained` (losing impression share to Ad Rank). Today the audit tells them *that* they're losing share but not *to whom*. They want the same audit run to name the competitor domain(s) beating them on that campaign, so they know who they're actually up against before they touch bids or quality score.

**Why this priority**: This is the core ask — Auction Insights data is worthless to an operator unless it's connected back to a campaign they already know is underperforming. Without this, the feature is just an unused data dump.

**Independent Test**: Run `ads.sh audit` with `--differentiation-profile` unset (irrelevant to this flow) against an account with a `rank_constrained` campaign; confirm the JSON envelope's `auctionInsights` block lists per-domain share metrics for that campaign, and a `losing_to_competitor` finding names the dominant domain.

**Acceptance Scenarios**:

1. **Given** a campaign flagged `rank_constrained` with a competitor domain holding `outrankingShare` above the threshold, **When** the audit runs with serving checks on (the default), **Then** the JSON output contains a `losing_to_competitor` finding for that campaign naming the domain and its outranking share.
2. **Given** a campaign with no competitor domain above the outranking threshold, **When** the audit runs, **Then** no `losing_to_competitor` finding is emitted for that campaign (silent, per the audit's existing "silent unless flagged" convention).

---

### User Story 2 - Get the raw per-domain share data for every serving campaign (Priority: P1)

An operator wants the full Auction Insights table (impression share, overlap rate, position-above rate, top-of-page rate, outranking share) for every domain competing on each of their serving campaigns, not just the ones that trip a finding — so they can review trends themselves or feed the data into `/adkit report`.

**Why this priority**: The findings in User Story 1 and 3 are derived from this raw data; without it being present in the envelope, an operator auditing manually (the current documented workflow in `reference/google/6-analyze.md`) has nothing to inspect.

**Independent Test**: Run the audit against an account with at least one serving campaign; confirm the JSON envelope's `auctionInsights[campaignId]` array is present, sorted by impression share descending, for every campaign the existing impression-share layer already reports on.

**Acceptance Scenarios**:

1. **Given** a serving campaign with three competing domains, **When** the audit runs, **Then** `auctionInsights[campaignId]` contains one row per domain with `domain`, `impressionShare`, `overlapRate`, `positionAboveRate`, `topOfPageRate`, and `outrankingShare`, ordered highest impression share first.
2. **Given** `--no-serving` is passed, **When** the audit runs, **Then** no `auctionInsights` block is present, consistent with every other serving-layer output (`keywordCpc`, `addNegatives`, `promoteKeywords`).

---

### User Story 3 - Get alerted when a new competitor shows up (Priority: P2)

An operator running the audit on a recurring cadence (weekly, per the existing "Weekly for 60 days, then monthly" convention) wants to be told when a domain starts competing on their terms that wasn't there in a prior run, without having to diff the raw table by hand.

**Why this priority**: This is the "review monthly" manual step from `reference/google/6-analyze.md` ("New competitors entering your terms") turned into an automatic signal — valuable, but secondary to simply having the data (User Story 2) and the rank-loss tie-in (User Story 1) land first.

**Independent Test**: Run the audit twice against the same account on different (real or simulated) days where the second run's Auction Insights data includes a domain absent from the first run's cached snapshot; confirm a `new_competitor` finding names that domain and campaign on the second run only.

**Acceptance Scenarios**:

1. **Given** a prior audit run's cached Auction Insights snapshot for a campaign, **When** the current run sees a domain not present in that snapshot, **Then** a `new_competitor` finding is emitted naming the domain and campaign.
2. **Given** no prior cached snapshot exists for a campaign (first-ever run), **When** the audit runs, **Then** no `new_competitor` finding is emitted for that campaign (nothing to diff against) and the current run's data is cached for next time.
3. **Given** a domain present in both the prior snapshot and the current run, **When** the audit runs, **Then** no `new_competitor` finding is emitted for that domain.

---

### Edge Cases

- What happens when a campaign has zero Auction Insights rows (no auction overlap data returned, e.g. brand-new or very low-volume campaign)? No `auctionInsights` entry for that campaign, no findings — same "no evidence, no flag" convention the audit already applies to landing-page alignment.
- What happens on the very first run ever (no cache file exists)? `new_competitor` is suppressed for that run (no prior baseline to diff against) and the run's data seeds the cache.
- What happens when `--no-serving` is passed? Auction Insights is skipped entirely, same as `keywordCpc`, `addNegatives`, `promoteKeywords`.
- What happens when a domain crosses the `losing_to_competitor` outranking threshold but the campaign is not currently `rank_constrained`? No finding — per the issue's ask, this finding is explicitly cross-referenced with an existing `rank_constrained` flag so it reads as "you're rank-constrained, and here's who's beating you," not a standalone alert.
- What happens to the local cache across different accounts/customer IDs? The cache is keyed so that snapshots for one Google Ads customer never diff against another's.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The audit MUST pull Auction Insights domain-level data (impression share, overlap rate, position-above rate, top-of-page rate, outranking share) for every serving campaign already covered by the existing impression-share layer, over the same `--days` window.
- **FR-002**: The audit MUST include this data in the JSON output envelope as `auctionInsights`, keyed by campaign id, with one row per competing domain, sorted by impression share descending.
- **FR-003**: The Auction Insights pull MUST be on by default and MUST be skipped when `--no-serving` is passed, consistent with the audit's other serving-layer outputs.
- **FR-004**: The audit MUST emit a `losing_to_competitor` finding for a campaign when a competing domain's outranking share exceeds 60% AND that campaign is already flagged `rank_constrained`; the finding MUST name the domain and its outranking share.
- **FR-005**: The audit MUST NOT emit a `losing_to_competitor` finding for a campaign that is not flagged `rank_constrained`, regardless of any domain's outranking share.
- **FR-006**: The audit MUST emit a `new_competitor` finding naming a domain and campaign when that domain appears in the current run's Auction Insights data but was absent from a prior run's cached snapshot for that campaign.
- **FR-007**: The audit MUST NOT emit a `new_competitor` finding on a campaign's first-ever audited run (no prior cached snapshot to diff against), and MUST seed the cache from that run instead.
- **FR-008**: The audit MUST persist each run's Auction Insights snapshot locally, keyed so that snapshots never diff across different Google Ads customer accounts.
- **FR-009**: A campaign with no Auction Insights rows returned MUST produce no `auctionInsights` entry and no related findings for that campaign (no evidence, no flag).
- **FR-010**: The feature MUST NOT fetch, scrape, or analyze a competitor's ad copy or landing pages — only the domain and share metrics Auction Insights itself returns.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator running `ads.sh audit` on a `rank_constrained` campaign can identify the specific competitor domain outranking them without leaving the audit's own output.
- **SC-002**: An operator can see the full competing-domain share table for every serving campaign in one audit run, replacing the manual monthly "review Auction Insights in the Ads UI" step.
- **SC-003**: An operator running the audit on a recurring cadence is notified of a new competitor entering their terms within the same run that competitor first appears, without manually comparing runs.
