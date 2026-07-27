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

### User Story 3 - The PSI API key is sourceable from `.adkit.yaml` / Secret Manager, not just an env var (Priority: P2)

*Added mid-flight — the user, after the enum-mismatch fix above, explicitly asked to fold in a second, related PSI-not-running gap into this same feature rather than opening a separate one: "add it to the init" / "combine that fix into this."*

Today `audit.ts` resolves the PSI key from only two tiers: the `--psi-key` flag, then the `PAGESPEED_API_KEY` env var. If neither is set, the audit reports "no credential" and skips PSI — even after User Story 1's enum fix makes the trigger logic correct. An operator who has already run `ads.sh init` / `bootstrap-secrets` / `render-yaml` to source their Google Ads credentials from GCP Secret Manager should be able to source the PSI key the same way, rather than being forced to export a raw env var every session.

**Why this priority**: This is a second, independent way PSI can still fail to run after Story 1 ships — same underlying "PSI never actually runs" problem the issue is about, just a different missing tier. Not the originally reported defect, so it sits at P2 alongside Story 2.

**Independent Test**: With no `--psi-key` flag and no `PAGESPEED_API_KEY` env var set, but `.adkit.yaml` carrying a `psi_api_key` value, confirm the audit's PSI key resolution returns that config value rather than `null`.

**Acceptance Scenarios**:

1. **Given** `ads.sh init` is run, **When** the operator is prompted through the credential fields, **Then** they are also (optionally, skippable with a blank answer) prompted for a PSI API key.
2. **Given** `ads.sh bootstrap-secrets` is run, **When** the operator answers the PSI key prompt, **Then** the value is seeded into GCP Secret Manager under a dedicated secret name, the same way the Ads credentials are.
3. **Given** that secret exists in Secret Manager, **When** `ads.sh render-yaml` runs, **Then** it pulls the PSI key back into `.adkit.yaml`'s `psi_api_key` field, alongside the Ads credentials, without disturbing other fields.
4. **Given** `.adkit.yaml` carries `psi_api_key` and no `--psi-key` flag or `PAGESPEED_API_KEY` env var is set, **When** `/adkit audit` resolves the PSI key, **Then** it uses the config value.
5. **Given** both a `--psi-key` flag/env value and a config value are present, **When** the audit resolves the PSI key, **Then** the flag wins over env, which wins over the config value (unchanged precedence, just with a new lowest tier instead of `null`).
6. **Given** no flag, no env var, and no config value, **When** the audit resolves the PSI key, **Then** it is `null` and PSI skips with the existing graceful-degrade message (updated to also mention the config/Secret Manager path).

---

## Clarifications

### Session 2026-07-27

Auto-answered by autopilot from the issue text + repo code (`scripts/src/bin/audit.ts`, `scripts/src/audit/rows.ts`, `scripts/src/lib/psi.ts`, `scripts/src/audit/render.ts`, `scripts/src/bin/audit-psi.test.ts`). No user-facing ambiguity; these are implementation-adjacent decisions grounded in existing conventions and the issue's own explicit guidance.

- Q: What is the canonical integer → string mapping table? → A: Google Ads API's `QualityScoreBucket` enum in its documented numeric order: `0`=UNSPECIFIED, `1`=UNKNOWN, `2`=BELOW_AVERAGE, `3`=AVERAGE, `4`=ABOVE_AVERAGE. This is a fixed, publicly documented Google Ads enum, not a project-specific choice.
- Q: Where should the normalization live — the `qualityScore()` mapping point in `audit.ts`, or the existing `normalizeQualityScoreRow` boundary parser in `rows.ts`? → A: `audit.ts`, per the issue's explicit instruction ("at the mapping point in audit.ts, via a small pure enum→string helper"). `rows.ts`'s own file-level doc asserts "Enum fields arrive as their STRING name already" for every other enum on the wire; this one field group is the sole, confirmed exception, so keeping the special-case conversion local to the one call site that needs it (rather than rewriting the general boundary-parsing convention) is the smaller, more reversible change.
- Q: What happens to an out-of-range/unrecognized integer (e.g. a future enum value)? → A: Map to `"UNKNOWN"` rather than throwing or emitting a bare number — matches the enum's own semantics (index `1` is literally `UNKNOWN`) and keeps the audit non-fatal on an unexpected wire value, consistent with this codebase's "degrade gracefully, don't throw on partial/unexpected input" pattern used throughout `rows.ts`.
- Q: What happens to a missing/absent field (row has no `quality_info`, or the sub-field is undefined)? → A: Unchanged — still normalizes to `""`, exactly as `normalizeQualityScoreRow` does today. This spec fixes the int-vs-string mismatch only; changing the missing-field default is a separate, unrequested behavior change and risks new call sites comparing against `""` unexpectedly.
- Q: Should the raw row types (`QualityScoreRow`/`RawQualityScoreRow` in `rows.ts`) be widened to `string | number`, or left as `string` with an unsound cast? → A: Widened to `string | number`. The type already lied about the runtime shape (this bug is proof); the type-driven-design convention in this repo ("parse, don't validate") calls for the type to reflect what the wire actually sends, with the narrowing done once, explicitly, at the point that produces the trusted `QualityScoreEntry.landingPageExp`/`.adRelevance`/`.expectedCtr` strings.

### Session 2026-07-27 (addition — PSI key sourcing)

Auto-answered by autopilot from the coordinator's relayed user request + repo code (`scripts/src/lib/config.ts`, `scripts/src/bin/init.ts`, `scripts/src/bin/bootstrap-secrets.ts`, `scripts/src/bin/render-yaml.ts`). Posted to issue #40 as an addendum comment per the same auto-answer convention as the session above.

- Q: Is the PSI key field required or skippable at `init` time? → A: Skippable — `init.ts`'s existing prompt loop already treats every field as "type a value or press enter to leave it out of the yaml" (a blank answer with no default is simply omitted), so `psi_api_key` needs no special-cased optionality; it follows the same pattern as every other credential field, including the already-optional `target_customer_id`.
- Q: What is the exact Secret Manager secret name? → A: `google-pagespeed-api-key`, matching the existing `google-ads-*` naming convention for the other secrets in `bootstrap-secrets.ts`/`render-yaml.ts`'s `SECRETS` arrays.
- Q: Is the new `render-yaml.ts` `SecretSpec` entry `required: true` or `required: false`? → A: `required: false`, mirroring `target_customer_id`'s precedent exactly — not every operator has PSI access, and the audit already degrades gracefully (skips with a reason) when no key is present, so a missing secret must not abort `render-yaml`.
- Q: Should `.adkit.yaml`'s `psi_api_key` sit in `CREDENTIAL_FIELDS` or `PREFERENCE_FIELDS` in `config.ts`? → A: `CREDENTIAL_FIELDS` (as a secret, not a preference) — it is fetched from Secret Manager like the Ads credentials, not a locally-scoped default like `reports_dir`, and its comment already states "the ones `render-yaml` fetches from Secret Manager."
- Q: Is the PSI key prompt read with echo (like an id) or muted (like a token)? → A: Muted (`sensitive: true`) — an API key is a credential, not an identifier; matches `developer_token`/`client_secret`/`refresh_token`'s treatment, not `client_id`/`login_customer_id`/`target_customer_id`'s.
- Q: Does adding the new lowest tier change the flag→env precedence order operators already rely on? → A: No — `resolveTier`'s existing flag→env→config→fallback order is reused unchanged; only the `config` tier, which previously always evaluated to `undefined` for this field (the config schema had no `psi_api_key` key), now can carry a real value.

### Edge Cases

- A component field already arriving as its canonical string (as today's tests exercise) continues to pass through unchanged — no regression on the already-working path.
- A component field missing entirely (row has no `quality_info`, or the sub-field is absent) continues to degrade the same way it does today (empty string), not a new "UNKNOWN" value that downstream code doesn't expect to compare against.
- An unrecognized raw integer outside the known 0-4 QualityScoreBucket range maps to `"UNKNOWN"` rather than throwing or producing a nonsensical string, so a future/undocumented enum value degrades gracefully instead of crashing the audit.
- The PSI trigger logic itself (the `===` comparison and URL-selection flow in `belowAverageFinalUrls`) is unchanged — only the value it compares against is fixed at its source.
- An operator who leaves the PSI key blank at both `init` and `bootstrap-secrets` time still gets a (possibly empty-valued) Secret Manager secret created — an accepted, pre-existing quirk of `bootstrap-secrets.ts`'s uniform prompt-then-seed loop (it already behaves this way for a blank `target_customer_id` today); `render-yaml` and `resolveTier` both treat a blank/whitespace value as absent regardless, so no bogus non-null key ever reaches the audit.
- A blank `psi_api_key` in `.adkit.yaml` (or the field simply absent) must not appear in the rendered yaml body at all — `buildConfigYamlBody` already skips blank field values for every field, so this needs no special handling.

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
- **FR-009** *(User Story 3, added mid-flight)*: `.adkit.yaml`'s config schema (`AdkitConfig` in `scripts/src/lib/config.ts`) MUST gain an optional `psi_api_key` field, added to `CREDENTIAL_FIELDS` so `ads.sh init` prompts for it (as a skippable, muted/sensitive prompt) alongside the Ads credentials.
- **FR-010** *(User Story 3)*: `ads.sh bootstrap-secrets` MUST seed the PSI key into GCP Secret Manager under a new secret name (`google-pagespeed-api-key`), following the existing `gcloud`-shell-out pattern — no new SDK dependency.
- **FR-011** *(User Story 3)*: `ads.sh render-yaml` MUST pull that secret back into `.adkit.yaml`'s `psi_api_key` field, as an optional (`required: false`) `SecretSpec` entry — a missing secret must not abort the render, mirroring `target_customer_id`.
- **FR-012** *(User Story 3)*: The audit's PSI key resolution (`parseAudarArgs` in `scripts/src/bin/audit.ts`) MUST become a three-tier `resolveTier`-based resolution — `--psi-key` flag → `PAGESPEED_API_KEY` env → `.adkit.yaml`'s `psi_api_key` — replacing the current two-tier flag-or-env resolution, implemented as a small pure exported function so it is independently unit-testable.
- **FR-013** *(User Story 3)*: The "no credential" skip message in `runPsi` MUST be updated to mention the config-file/Secret Manager path, not only the flag and env var, so the message stays accurate once a third tier exists.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Given a Quality Score row with a below-average component arriving as a raw integer, the audit's PSI step is no longer a silent no-op — it performs at least one diagnosis attempt for the associated final URL.
- **SC-002**: All existing PSI and audit unit tests continue to pass unchanged (the already-string-typed test fixtures in `audit-psi.test.ts` still exercise a valid path).
- **SC-003**: A new unit test covering the integer-enum path exists and passes, demonstrating the fix without requiring live Google Ads or PSI credentials.
- **SC-004**: `landingPageExp`, `adRelevance`, and `expectedCtr` in the audit's emitted JSON are always one of the canonical string buckets, never a bare number, for any input the mapping is exercised with in tests.
- **SC-005** *(User Story 3)*: An operator who has run `init` → `bootstrap-secrets` → `render-yaml` for their PSI key, and exports no env var and passes no flag, gets PSI diagnosis on a below-average audit — the config tier alone is sufficient to enable the feature end-to-end.
- **SC-006** *(User Story 3)*: The flag → env → config precedence is covered by unit tests for all four presence combinations (all present picks flag; flag absent picks env; flag+env absent picks config; all absent yields `null`).

## Assumptions

- The Google Ads API's `google-ads-api` client library returns these three `quality_info` sub-fields as the raw `QualityScoreBucket` enum integer (`0`=UNSPECIFIED, `1`=UNKNOWN, `2`=BELOW_AVERAGE, `3`=AVERAGE, `4`=ABOVE_AVERAGE) despite most other enums on the same client resolving to their string name — this is the confirmed root cause from a live run cited in issue #40, not a hypothesis to re-verify.
- No live Google Ads or PageSpeed Insights credentials are available in this environment; verification is via the existing and new unit/vitest suites only, per the issue's own verification note.
- This is a pure bug fix with no user-facing behavior change beyond "PSI now actually runs when it should have all along" for User Stories 1-2 — no new CLI flags, no new configuration, no schema/versioning concerns for the enum-mismatch fix itself.
- User Story 3 (added mid-flight, same underlying "PSI never runs" problem, different missing tier) does add one new optional config field (`psi_api_key`) and one new optional Secret Manager secret (`google-pagespeed-api-key`) — this is additive/backward-compatible: existing `.adkit.yaml` files and existing flag/env-based PSI usage are unaffected, since the new tier only activates when the higher-precedence flag and env tiers are both absent.
- No `@google-cloud/secret-manager` SDK dependency is added — the PSI key follows the repo's existing `gcloud` CLI shell-out convention for Secret Manager, matching the Ads-credential precedent exactly.
