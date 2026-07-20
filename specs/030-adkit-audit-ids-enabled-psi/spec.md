# Feature Specification: `/adkit audit` closes the loop — surface keyword IDs, confirm the ENABLED filter, and diagnose low landing-page scores

**Feature Branch**: `030-adkit-audit-ids-enabled-psi`

**Created**: 2026-07-18

**Status**: Draft

**Input**: GitHub issue #22 — "[hindsight] /adkit audit: surface adGroupId/matchType, add ENABLED filter, auto-PSI on low LP score". A recurrence-gated finding (8 sessions over 7 days): `/adkit audit` reliably *names* problems but forces manual second passes to author fixes or diagnose them.

## Clarifications

### Session 2026-07-18

- Q: PSI credential model — operator-supplied vs auto-provisioned temp GCP key? → A: Operator-supplied API key via env `PAGESPEED_API_KEY` (or `--psi-key`); the audit never auto-provisions or deletes GCP keys. The issue's temp-key lifecycle is preserved as an operator runbook, not audit behavior.
- Q: Where does the PSI diagnosis surface — JSON, human table, or both? → A: Both — a `psi` block in the JSON on stdout keyed by distinct final URL, plus a human-readable summary folded into the landing-page/quality-score section on stderr.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author a keyword pause/update plan in one pass (Priority: P1)

An operator runs `/adkit audit` on a customer, sees an over-spending keyword flagged in a cluster split, and wants to author a keyword pause plan
(`{customerId, keywords:[{adGroupId, pause:[{text, matchType}]}]}`) directly from the audit output. Today the audit JSON names the keyword text and its CPC but omits the numeric `adGroupId` and the keyword `matchType`, so the operator has to fall back to `ads.sh report <customer> --days 30` and hand-grep the raw report YAML for those two fields before the pause plan can be written.

**Why this priority**: This is the most frequently hit gap (observed across the majority of the lead-drop sessions) and the cheapest to close — the two missing fields are already available on the same Google Ads resource the audit reads. Closing it removes a whole `report` round-trip from the routine keyword-hygiene loop.

**Independent Test**: Run the audit against a customer with ENABLED keywords and confirm every per-keyword row in the JSON carries a numeric `adGroupId` and a `matchType` (EXACT/PHRASE/BROAD), such that a keyword pause plan can be authored without opening any report artifact.

**Acceptance Scenarios**:

1. **Given** an ENABLED campaign with keywords, **When** the audit's keyword-CPC / cluster-split output is produced, **Then** each keyword row includes its `adGroupId` (numeric) and `matchType` alongside the existing `text` and CPC.
2. **Given** an audit result, **When** an operator assembles a keyword pause plan from it, **Then** no `report` command or raw YAML grep is required to obtain `adGroupId` or `matchType`.

---

### User Story 2 - Paused keywords never resurrect a cluster-split flag (Priority: P2)

An operator pauses an outlier keyword flagged by a cluster split, re-runs the audit within the trailing window, and expects the split flag to clear. This depends on the keyword-metrics query counting only ENABLED keywords, so a paused keyword's trailing spend stops feeding `keywordCpc` → `clusterSplits`.

**Why this priority**: The underlying `ENABLED` filter on `auditKeywordMetricsQuery` **already shipped** (PR #16, commit `55de470`) with a guard test. This story exists to (a) confirm the behavior is present and regression-guarded on this branch and (b) verify no sibling keyword read reintroduces paused-keyword spend into the same cluster math. It is scope-confirmation, not new build, unless a gap is found.

**Independent Test**: Assert `auditKeywordMetricsQuery` restricts to `ad_group_criterion.status = 'ENABLED'`, and that pausing a keyword removes it from the keyword-CPC feed on the next audit.

**Acceptance Scenarios**:

1. **Given** the keyword-metrics query, **When** it is built, **Then** its conditions contain `ad_group_criterion.status = 'ENABLED'` (guard test present and passing).
2. **Given** a keyword paused after being flagged, **When** the audit re-runs inside the trailing window, **Then** that keyword no longer contributes to the cluster-split computation.

---

### User Story 3 - Turn "your landing-page score is low" into "here's the exact fix" (Priority: P3)

When the audit reports `landing_page_experience ≤ 2` (below-average) for a keyword, the operator currently has to manually pivot to PageSpeed Insights: provision a temporary API key, run mobile PSI per final URL, and do JS-bundle forensics to find the real killer (e.g. an opacity fade on the LCP hero element). This is where nearly all the session's value came from. The audit should close that loop: when a final URL's landing-page experience is below-average, run PageSpeed Insights (mobile) on that URL and fold the diagnostic signal (LCP, render-blocking resources, unused JavaScript) into the audit report.

**Why this priority**: Highest analyst value but also the largest surface and the only part touching an external service and a credential. It is the last slice so US1/US2 can ship independently even if the PSI integration needs more review.

**Independent Test**: Given an audit run where at least one ad's final URL scores `landing_page_experience ≤ 2` and a PageSpeed Insights credential is available, confirm the report gains a per-URL diagnostic block with LCP, render-blocking, and unused-JS signals; given no credential available, confirm the audit completes unchanged with a clear "PSI skipped — no credential" note and a non-zero success.

**Acceptance Scenarios**:

1. **Given** a below-average landing-page score on a final URL and an available PSI credential, **When** the audit runs, **Then** the report includes that URL's mobile LCP, render-blocking resources, and unused-JS opportunities.
2. **Given** a below-average score but **no** PSI credential available, **When** the audit runs, **Then** the audit still completes successfully and clearly reports that PSI diagnosis was skipped for lack of a credential (no crash, no partial-write).
3. **Given** landing-page scores are all above-average, **When** the audit runs, **Then** no PSI calls are made.

### Edge Cases

- A keyword with no `matchType` populated (e.g. a non-keyword criterion that slips through): the row is still emitted with a null/absent `matchType` rather than crashing plan authoring.
- Multiple ads under one final URL, or one URL shared across ad groups: PSI runs at most once per distinct final URL (dedup) to avoid redundant external calls.
- PSI credential present but the API call fails, times out, or is rate-limited for a given URL: that URL's diagnostic is recorded as unavailable-with-reason; the rest of the audit is unaffected.
- A temporary credential created for the PSI pass MUST be cleaned up (deleted/revoked) on every exit path, including failure — a leaked credential is a security defect.
- `landing_page_experience` is exactly 2 (below-average) vs `> 2`: the threshold is inclusive (`≤ 2` triggers diagnosis).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The audit's per-keyword output rows (the keyword-CPC / cluster-split feed used to author keyword plans) MUST include the numeric `adGroupId` and the keyword `matchType` in addition to the existing keyword `text` and CPC.
- **FR-002**: The Google Ads read that backs those rows MUST select the ad-group id and keyword match-type fields, routing any id interpolation through the existing digits-only id guard, and continue to restrict to ENABLED keywords.
- **FR-003**: A keyword pause/update plan MUST be authorable purely from a single audit run's JSON output — no `report` subcommand or raw report-YAML grep required to obtain `adGroupId` or `matchType`.
- **FR-004**: `auditKeywordMetricsQuery` MUST restrict to `ad_group_criterion.status = 'ENABLED'`, and this MUST be covered by a guard test in the query builders' test suite (confirm existing coverage; add if absent).
- **FR-005**: When any ad's final-URL landing-page experience is below-average (`landing_page_experience ≤ 2`) AND a PageSpeed Insights credential is available, the audit MUST run PageSpeed Insights (mobile form factor) against each such distinct final URL and fold LCP, render-blocking resources, and unused-JavaScript signals into the report — surfaced in BOTH the JSON output on stdout (a `psi` block keyed by distinct final URL) and the human-readable landing-page/quality-score section on stderr.
- **FR-006**: PageSpeed Insights MUST run at most once per distinct final URL per audit run (deduplicated), and MUST NOT run at all when no landing-page score is below-average.
- **FR-007**: When no PageSpeed Insights credential is available, the audit MUST complete successfully with a clear, explicit "PSI diagnosis skipped — no credential" note and MUST NOT fail, crash, or partially write output.
- **FR-008**: A PageSpeed Insights call that fails, times out, or is rate-limited for one URL MUST be recorded as unavailable-with-reason for that URL only and MUST NOT abort the rest of the audit.
- **FR-009**: The PSI pass MUST obtain its PageSpeed Insights credential from operator-supplied configuration — the `PAGESPEED_API_KEY` environment variable or a `--psi-key` flag — and MUST NOT auto-provision, create, or delete any GCP API key. When the credential is absent, the audit degrades per FR-007. (The issue's temporary-key create/use/delete lifecycle is documented as an operator runbook, not implemented as audit behavior, to avoid holding `apikeys.admin` IAM and to eliminate the leaked-unrestricted-key risk on a crash.)
- **FR-010**: All new query-shaping and report-folding logic MUST be pure functions (input → output, no I/O), with the network/credential/filesystem side effects isolated to the IO shell, consistent with the repo's functional-style and parse-at-the-boundary conventions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of per-keyword rows in an audit run against a customer with ENABLED keywords carry a numeric `adGroupId` and a `matchType`.
- **SC-002**: An operator can author a keyword pause plan from one audit run with zero `report` invocations (previously required at least one `report` round-trip plus a manual YAML grep).
- **SC-003**: Pausing a flagged outlier keyword clears its cluster-split flag on the next audit within the trailing window in 100% of cases.
- **SC-004**: For an audit that surfaces a below-average landing-page score with a PSI credential available, the report includes an actionable per-URL diagnostic (LCP + render-blocking + unused-JS) that previously required a manual PageSpeed Insights session.
- **SC-005**: An audit run with no PSI credential, or with below-average scores absent, completes with the same exit status and no external PSI calls beyond what FR-006 permits.

## Functional Programming Constraints

- New logic (field selection, row shaping to carry `adGroupId`/`matchType`, PSI response → report-fragment mapping, dedup of final URLs) MUST be pure functions returning new values; no parameter mutation, no accumulation via in-loop push.
- All I/O — Google Ads reads, PageSpeed Insights HTTP calls, any credential create/delete, stdout/stderr — stays at the edges (the IO shell), never inside the pure transforms.
- Untrusted/loose inputs (PSI JSON responses, CLI/env credentials) are parsed once at the boundary into precise typed values; downstream code receives the parsed type and does not re-validate.

## Platform Constraints

- Runs in the existing `skills/adkit/scripts` TypeScript project under Node; new tests run under `npx vitest run`.
- Google Ads reads go through the existing `SearchArgs` builders and the reversible SDK / google-ads-mcp seam — no raw GAQL strings at call sites.
- The PSI pass depends on an external service (PageSpeed Insights) and possibly a cloud credential; both are optional at runtime and their absence degrades gracefully (FR-007) rather than blocking the core audit.
