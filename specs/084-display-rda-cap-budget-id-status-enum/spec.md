# Feature Specification: Display RDA combined image cap, quoted plan ids, numeric live status

**Feature Branch**: `084-display-rda-cap-budget-id-status-enum`

**Created**: 2026-10-27

**Status**: Draft

**Input**: GitHub issue #84 — "Display: RDA image cap is combined, quoted campaignId breaks budgets, status skip misses numeric enums". Three defects found while publishing and changing a display campaign. None changed a live result, but each lets a bad plan through or prints a misleading message.

## Clarifications

### Session 2026-10-27

- Q: What are Google's actual RDA limits? → A: 15 marketing images combined across landscape + square, and 5 logos combined across landscape + square; per-shape minimums unchanged.
- Q: Which form do plan ids normalize to? → A: Number — the form unquoted ids already take and the live-state maps are keyed by.
- Q: Which fields, and where? → A: Top-level `campaignId`, `adGroupId`, `adId` on every block of every section, once, when the plan is loaded.
- Q: Non-canonical ids (`"0123"`, `"abc"`, beyond safe-integer range)? → A: Left untouched; only canonical digit strings within the safe-integer range are converted.
- Q: A live status that can't be decoded? → A: Decodes to `UNKNOWN`, which never matches a target, so it is treated as a change and still warns.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dry run rejects a display ad with too many images (Priority: P1)

An operator writes a display brief whose responsive display ad lists 10 landscape and 10 square marketing images. Today `ads.sh create --dry-run` accepts it; the real publish uploads every image, then Google rejects the ad (`collection_size_error: TOO_MANY`). The dry run must reject the brief up front, naming the combined limit, so nothing is uploaded.

**Why this priority**: The only one of the three that does partial, wasted live work (orphaned image assets) and fails a publish late.

**Independent Test**: Parse a display brief with 10 + 10 marketing images and confirm it fails with a message naming the combined cap of 15; parse 8 + 7 and confirm it passes.

**Acceptance Scenarios**:

1. **Given** a display ad with 10 landscape + 10 square marketing images, **When** the brief is parsed, **Then** it is rejected with a message that landscape + square marketing images together may not exceed 15.
2. **Given** a display ad with 8 landscape + 7 square marketing images (15 total), **When** the brief is parsed, **Then** it is accepted.
3. **Given** a display ad with 3 landscape + 3 square logos (6 total), **When** the brief is parsed, **Then** it is rejected with a message that landscape + square logos together may not exceed 5.

---

### User Story 2 - Update plans accept quoted ids in every section (Priority: P1)

An operator writes an `update` plan with `campaignId: "24362682893"` (quoted) under `budgets`. Today validation fails with "no current budget found", which blames the account when the cause is how the id was typed. The same plan with the id unquoted works, and other sections (`campaignStatus`, `adGroupStatus`) already take quoted ids. A quoted and an unquoted id must mean the same thing in every plan section.

**Why this priority**: It blocks a legitimate budget change with a misleading message, and quoting ids is already the documented style for status sections.

**Independent Test**: Load the same budgets plan with the id quoted and unquoted; both must find the campaign's current budget and produce identical validation results.

**Acceptance Scenarios**:

1. **Given** a plan with a `budgets` block whose `campaignId` is a quoted digit string, **When** the plan is validated against a live budget for that campaign, **Then** the current budget is found and the guardrail is applied exactly as for the unquoted id.
2. **Given** a plan with a quoted id in any id-keyed section (`bidding`, `negatives`, `keywords`, `sitelinks`, `callouts`, `searchPartners`, `geo`, `languages`, `adGroups`, status sections, ad edits), **When** the plan is loaded, **Then** it behaves identically to the same plan with the id unquoted.
3. **Given** a plan whose id is not a digit string (e.g. `"abc"`), **When** the plan is validated, **Then** it is still rejected exactly as it is today.

---

### User Story 3 - Already-enabled campaigns and ad groups are skipped, not re-enabled (Priority: P2)

An operator applies an enable plan to a campaign and ad group that are already ENABLED. Today the run prints `status 2 -> ENABLED`, warns "ENABLE starts live spend", and re-sends both mutations, because live status arrives as a raw enum number. Ads in the same plan are already skipped correctly. Campaigns and ad groups must be skipped the same way, and the live-spend warning must fire only for things that are not already live.

**Why this priority**: The re-mutation is harmless, but a spend warning that fires on already-live entities trains operators to ignore it.

**Independent Test**: Feed a numeric live status (`2`) for a campaign and an ad group into the status planner with a target of ENABLED; both must be reported as "already ENABLED, skipped" and neither may appear in the live-spend warning.

**Acceptance Scenarios**:

1. **Given** a campaign whose live status arrives as the number `2` (ENABLED), **When** a plan sets it to ENABLED, **Then** it is reported `status already ENABLED, skipped`, is not mutated, and is not listed in the "ENABLE starts live spend" warning.
2. **Given** an ad group whose live status arrives as `2`, **When** a plan sets it to ENABLED, **Then** the same skip applies.
3. **Given** a campaign whose live status arrives as `3` (PAUSED), **When** a plan sets it to ENABLED, **Then** the change line reads `status PAUSED -> ENABLED` (a name, never a bare number) and the live-spend warning fires.

### Edge Cases

- A live status that already arrives as its string name (`"ENABLED"`) still decodes to that name.
- A combined count of exactly 15 marketing images or exactly 5 logos is allowed; one more is rejected.
- Per-shape limits that already exist (at least one landscape and one square marketing image, at least one square logo) are unchanged.
- An id with leading zeros (`"0123"`), a non-digit id, or a digit string beyond the safe-integer range is left exactly as written; validation then treats it as it does today.
- A live status outside the known enum decodes to `UNKNOWN`; it never matches a target status, so it is reported as a change and still triggers the live-spend warning.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Brief parsing MUST reject a responsive display ad whose landscape + square marketing images total more than 15, with a message naming both fields and the combined limit.
- **FR-002**: Brief parsing MUST reject a responsive display ad whose landscape + square logos total more than 5, with a message naming both fields and the combined limit.
- **FR-003**: Loading an `update` plan MUST normalize every canonical digit-string id (no leading zero, within the safe-integer range) (`campaignId`, `adGroupId`, `adId`) in every section to a number (the form an unquoted id takes), once, before any validation or live lookup.
- **FR-004**: Validation MUST otherwise treat ids exactly as today: non-digit ids are still rejected.
- **FR-005**: Live campaign and ad-group statuses MUST be decoded to their enum names when fetched, whether they arrive as numbers or as names.
- **FR-006**: A status block whose target equals the decoded live status MUST be skipped and excluded from the live-spend warnings.
- **FR-007**: Regression tests MUST cover a 10 + 10 image ad, a quoted budgets `campaignId`, and a numeric live campaign/ad-group status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A brief that Google would reject for too many images or logos fails the dry run, with zero assets uploaded.
- **SC-002**: A quoted and an unquoted id produce identical plan output in 100% of id-keyed sections.
- **SC-003**: Re-applying an enable plan to already-enabled campaigns and ad groups prints only "skipped" lines and zero live-spend warnings.

