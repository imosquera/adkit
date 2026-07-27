# Feature Specification: PSI auto-diagnosis never triggers because Quality Score enum fields arrive as integers, not strings

**Feature Branch**: `044-psi-enum-string-mismatch`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "`/adkit audit` — PageSpeed Insights auto-diagnosis never runs even with a valid PAGESPEED_API_KEY and below-average landing-page-experience keywords, because `landingPageExp` is mapped straight from the Google Ads API's raw enum integer (e.g. `2`) while the PSI URL selector compares against the string `\"BELOW_AVERAGE\"`. Source: GitHub issue #40."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - PSI runs automatically when landing-page experience is below average (Priority: P1)

An operator with `PAGESPEED_API_KEY` set runs `/adkit audit` against a campaign whose keywords include a below-average landing-page-experience Quality Score component. Today the audit silently emits `psi: { skipped: null, results: [] }` — as if every page were fine — because the Quality Score value it compares is an integer while the selector expects a string. The operator should get real PSI diagnoses for the affected final URLs, the entire point of the feature this bug silently disables.

**Why this priority**: This is the reported defect. Every audit run today behaves as if PSI never has anything to check, defeating the loop-closer the feature exists for.

**Independent Test**: Feed the audit's quality-score mapping a raw Google Ads row whose `post_click_quality_score` arrives as the integer `2` and confirm the resulting `QualityScoreEntry.landingPageExp` is the string `"BELOW_AVERAGE"`, that the PSI URL selector picks up the associated final URL, and that `runPsi` is no longer a no-op for it.

**Acceptance Scenarios**:

1. **Given** a Quality Score row whose `post_click_quality_score` is the raw enum integer `2`, **When** the audit maps it into a `QualityScoreEntry`, **Then** `landingPageExp` is the string `"BELOW_AVERAGE"`.
2. **Given** that mapped entry and a campaign report with a matching final URL, **When** `belowAverageFinalUrls` runs, **Then** the URL is selected.
3. **Given** that selection and a valid PSI API key, **When** `runPsi` runs, **Then** it performs a real diagnosis (`results` is non-empty) instead of the current silent no-op.

---

### User Story 2 - Ad Relevance and Expected CTR "below average" render lines also see string buckets (Priority: P2)

The same integer-vs-string mismatch affects `adRelevance` (`creative_quality_score`) and `expectedCtr` (`search_predicted_ctr`), which feed the audit's "QUALITY SCORE — AD RELEVANCE BELOW AVERAGE" and "QUALITY SCORE — EXPECTED CTR BELOW AVERAGE" render sections. Today those sections can silently omit rows that are genuinely below average.

**Why this priority**: Same root cause, same fix, but a rendering/reporting concern rather than the primary automation the issue is about — it doesn't block the primary flow but should not ship half-fixed.

**Independent Test**: Feed the mapping a row whose `creative_quality_score` and `search_predicted_ctr` arrive as raw integers and confirm both `adRelevance` and `expectedCtr` on the resulting `QualityScoreEntry` are canonical strings, and that the corresponding render sections include the row when it is below average.

**Acceptance Scenarios**:

1. **Given** a row whose `creative_quality_score` is the raw integer `2`, **When** mapped, **Then** `adRelevance` is `"BELOW_AVERAGE"` and the row appears in the "AD RELEVANCE BELOW AVERAGE" render section.
2. **Given** a row whose `search_predicted_ctr` is the raw integer `2`, **When** mapped, **Then** `expectedCtr` is `"BELOW_AVERAGE"` and the row appears in the "EXPECTED CTR BELOW AVERAGE" render section.

---

## Clarifications

### Session 2026-07-27

Auto-answered by autopilot from the issue text + repo code (`scripts/src/bin/audit.ts`, `scripts/src/audit/rows.ts`, `scripts/src/lib/psi.ts`, `scripts/src/audit/render.ts`, `scripts/src/bin/audit-psi.test.ts`). No user-facing ambiguity; these are implementation-adjacent decisions grounded in existing conventions and the issue's own explicit guidance.

- Q: What is the canonical integer → string mapping table? → A: Google Ads API's `QualityScoreBucket` enum in its documented numeric order: `0`=UNSPECIFIED, `1`=UNKNOWN, `2`=BELOW_AVERAGE, `3`=AVERAGE, `4`=ABOVE_AVERAGE. This is a fixed, publicly documented Google Ads enum, not a project-specific choice.
- Q: Where should the normalization live — the `qualityScore()` mapping point in `audit.ts`, or the existing `normalizeQualityScoreRow` boundary parser in `rows.ts`? → A: `audit.ts`, per the issue's explicit instruction ("at the mapping point in audit.ts, via a small pure enum→string helper"). `rows.ts`'s own file-level doc asserts "Enum fields arrive as their STRING name already" for every other enum on the wire; this one field group is the sole, confirmed exception, so keeping the special-case conversion local to the one call site that needs it (rather than rewriting the general boundary-parsing convention) is the smaller, more reversible change.
- Q: What happens to an out-of-range/unrecognized integer (e.g. a future enum value)? → A: Map to `"UNKNOWN"` rather than throwing or emitting a bare number — matches the enum's own semantics (index `1` is literally `UNKNOWN`) and keeps the audit non-fatal on an unexpected wire value, consistent with this codebase's "degrade gracefully, don't throw on partial/unexpected input" pattern used throughout `rows.ts`.
- Q: What happens to a missing/absent field (row has no `quality_info`, or the sub-field is undefined)? → A: Unchanged — still normalizes to `""`, exactly as `normalizeQualityScoreRow` does today. This spec fixes the int-vs-string mismatch only; changing the missing-field default is a separate, unrequested behavior change and risks new call sites comparing against `""` unexpectedly.
- Q: Should the raw row types (`QualityScoreRow`/`RawQualityScoreRow` in `rows.ts`) be widened to `string | number`, or left as `string` with an unsound cast? → A: Widened to `string | number`. The type already lied about the runtime shape (this bug is proof); the type-driven-design convention in this repo ("parse, don't validate") calls for the type to reflect what the wire actually sends, with the narrowing done once, explicitly, at the point that produces the trusted `QualityScoreEntry.landingPageExp`/`.adRelevance`/`.expectedCtr` strings.

### Edge Cases

- A component field already arriving as its canonical string (as today's tests exercise) continues to pass through unchanged — no regression on the already-working path.
- A component field missing entirely (row has no `quality_info`, or the sub-field is absent) continues to degrade the same way it does today (empty string), not a new "UNKNOWN" value that downstream code doesn't expect to compare against.
- An unrecognized raw integer outside the known 0-4 QualityScoreBucket range maps to `"UNKNOWN"` rather than throwing or producing a nonsensical string, so a future/undocumented enum value degrades gracefully instead of crashing the audit.
- The PSI trigger logic itself (the `===` comparison and URL-selection flow in `belowAverageFinalUrls`) is unchanged — only the value it compares against is fixed at its source.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The audit's Quality Score mapping (`qualityScore()` in `scripts/src/bin/audit.ts`) MUST normalize `post_click_quality_score`, `creative_quality_score`, and `search_predicted_ctr` to the canonical string bucket names (`"BELOW_AVERAGE"`, `"AVERAGE"`, `"ABOVE_AVERAGE"`, `"UNKNOWN"`, `"UNSPECIFIED"`) regardless of whether the underlying Google Ads API value arrives as a raw enum integer or as an already-resolved string.
- **FR-002**: The normalization MUST be implemented as a small, pure, unit-testable function (no network, no SDK types) colocated at the mapping point in `audit.ts`.
- **FR-003**: A field that already arrives as a canonical string MUST pass through unchanged (no double-mapping, no accidental stringification bugs).
- **FR-004**: A field that is absent (row has no `quality_info`, or the sub-field is missing) MUST continue to normalize to the same empty-string default the mapping produces today — this spec does not change that degrade path.
- **FR-005**: `QualityScoreEntry.landingPageExp`, `.adRelevance`, and `.expectedCtr` MUST remain typed as `string` (the type already declares this; the bug is a runtime/value mismatch, not a type-level gap) and the JSON the audit emits MUST carry these fields as strings, never as raw numbers.
- **FR-006**: The raw row type(s) feeding the mapping (`QualityScoreRow` / `RawQualityScoreRow` in `scripts/src/audit/rows.ts`) MUST be widened to admit `string | number` for these three fields, so the type system reflects the value shape the API actually sends instead of asserting a `string` that was never enforced at a parse boundary.
- **FR-007**: The PSI URL selector (`belowAverageFinalUrls` in `scripts/src/lib/psi.ts`) and the Quality Score render sections (`renderQualityScoreSection` in `scripts/src/audit/render.ts`) MUST NOT be changed — they already compare against the correct string form; only the value reaching them is fixed.
- **FR-008**: A regression test MUST prove that a Quality Score row arriving with `post_click_quality_score` as the raw integer `2` results in a `QualityScoreEntry` selected by `belowAverageFinalUrls` and triggers a non-no-op `runPsi` call.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Given a Quality Score row with a below-average component arriving as a raw integer, the audit's PSI step is no longer a silent no-op — it performs at least one diagnosis attempt for the associated final URL.
- **SC-002**: All existing PSI and audit unit tests continue to pass unchanged (the already-string-typed test fixtures in `audit-psi.test.ts` still exercise a valid path).
- **SC-003**: A new unit test covering the integer-enum path exists and passes, demonstrating the fix without requiring live Google Ads or PSI credentials.
- **SC-004**: `landingPageExp`, `adRelevance`, and `expectedCtr` in the audit's emitted JSON are always one of the canonical string buckets, never a bare number, for any input the mapping is exercised with in tests.

## Assumptions

- The Google Ads API's `google-ads-api` client library returns these three `quality_info` sub-fields as the raw `QualityScoreBucket` enum integer (`0`=UNSPECIFIED, `1`=UNKNOWN, `2`=BELOW_AVERAGE, `3`=AVERAGE, `4`=ABOVE_AVERAGE) despite most other enums on the same client resolving to their string name — this is the confirmed root cause from a live run cited in issue #40, not a hypothesis to re-verify.
- No live Google Ads or PageSpeed Insights credentials are available in this environment; verification is via the existing and new unit/vitest suites only, per the issue's own verification note.
- This is a pure bug fix with no user-facing behavior change beyond "PSI now actually runs when it should have all along" — no new CLI flags, no new configuration, no schema/versioning concerns.
