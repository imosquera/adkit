# Feature Specification: Fix false path-to-EXCELLENT recommendations from raw enum comparison

**Feature Branch**: `046-ad-strength-enum-fix`

**Created**: 2026-07-30

**Status**: Draft

**Input**: User description: "Fix false \"path to EXCELLENT\" recommendations on every ad audit. Two sites compare ad strength against the string literal \"EXCELLENT\", but AdReport.strength carries the raw Google Ads enum ordinal (7 for EXCELLENT). Both comparisons are therefore always true, so every ad — including ones already EXCELLENT — gets bogus improvement steps appended. Map the enum to its name at the parse boundary and narrow AdReport.strength from bare string to the union of valid strength names so the comparison sites can't drift again."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Audit output stops lying about EXCELLENT ads (Priority: P1)

A user running `/adkit audit` reviews the CLI report for a campaign where an ad
already has EXCELLENT strength. Today the report still appends a "path to
EXCELLENT" recommendation to that ad, telling the user to add more headline
diversity and keyword coverage — advice that doesn't apply and that the user must
learn to ignore across every audit run.

**Why this priority**: This is the entire content of the bug report — the noise
appears on every single ad in every audit run, so it's the only user-visible
behavior in scope.

**Independent Test**: Run the audit against a fixture where an ad's `ad_strength`
is the numeric value Google's API actually returns for EXCELLENT (`7`), and
confirm the rendered report contains no `pathToExcellent` step lines and no
fallback recommendation for that ad.

**Acceptance Scenarios**:

1. **Given** an ad whose `ad_strength` row value is the numeric EXCELLENT enum
   (`7`), **When** the audit renders its report, **Then** no "path to EXCELLENT"
   step lines are printed for that ad and no fallback diversity recommendation is
   appended.
2. **Given** an ad whose `ad_strength` row value is a non-EXCELLENT numeric enum
   (e.g. `6` for GOOD), **When** the audit renders its report, **Then** the
   existing "path to EXCELLENT" guidance still appears for that ad, unchanged from
   today's behavior for genuinely non-EXCELLENT ads.

---

### Edge Cases

- What happens when the API returns an already-decoded string name (e.g.
  `"EXCELLENT"`) instead of the numeric ordinal? The decode must pass it through
  unchanged rather than fail, since `google-ads-api`'s enum maps are bidirectional
  and some fields arrive pre-decoded.
- What happens when the API returns an out-of-range or unrecognized strength
  value? The system should not crash; the resulting name should be treated as a
  non-EXCELLENT value so guidance is still offered rather than silently dropped.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST decode the raw `ad_strength` enum value returned by
  the Google Ads API into its string name (e.g. `EXCELLENT`, `GOOD`, `AVERAGE`,
  `POOR`, `NO_ADS`, `PENDING`, `UNKNOWN`, `UNSPECIFIED`) at the point the row is
  parsed into an `AdReport`, before any downstream comparison happens.
- **FR-002**: The system MUST type `AdReport.strength` as the closed union of
  valid Google Ads strength names rather than a bare `string`, so a comparison
  against a string literal outside that union is caught statically instead of
  silently always matching or never matching.
- **FR-003**: The CLI report renderer MUST only print "path to EXCELLENT" step
  lines for an ad whose decoded strength name is not `EXCELLENT`.
  (see User Story 1)
- **FR-004**: The scoring module's fallback diversity recommendation MUST only be
  appended for an ad whose decoded strength name is not `EXCELLENT`.
  (see User Story 1)
- **FR-005**: The enum decode MUST pass through a value that is already a string
  name unchanged, matching the existing `matchTypeName` decode convention used
  elsewhere in the codebase for other Google Ads enums.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Running an audit against an ad whose live API strength is EXCELLENT
  produces zero "path to EXCELLENT" lines and zero fallback recommendations for
  that ad, where today it always produces at least one.
- **SC-002**: Running an audit against an ad whose live API strength is anything
  other than EXCELLENT continues to produce the same improvement guidance as
  before this fix, with no regression in coverage or content.
- **SC-003**: A strength value compared against an invalid or misspelled name is
  caught at type-check time rather than surfacing as silently-wrong runtime
  behavior.
