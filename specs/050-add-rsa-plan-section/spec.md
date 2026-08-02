# Feature Specification: addRsa plan section (add a 2nd RSA to an existing ad group)

**Feature Branch**: `050-add-rsa-plan-section`

**Created**: 2026-08-02

**Status**: Draft

**Input**: GitHub issue #63 — "update: add addRsa plan section to fix rsa_count_mismatch (add a 2nd RSA to an existing ad group)"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Close an `rsa_count_mismatch` finding via a plan (Priority: P1)

An operator runs `/adkit audit` and gets a campaign-level `rsa_count_mismatch` finding: an ad group is live with only 1 RSA instead of the required 2 (e.g. a legacy ad group, or one that predates the `responsiveSearchAd` → `responsiveSearchAds` schema migration). Today `reference/audit.md` documents this as unfixable by `ads.sh update` — the operator's only option is to hand-author the second RSA in the Ads UI. The operator instead authors a second, distinct-angle RSA (15 headlines / 4 descriptions) in an `addRsa` block of an update plan YAML, keyed by the ad group's live `adGroupId`, and runs `ads.sh update --apply`.

**Why this priority**: This is the entire reason the feature exists — it closes the one documented gap in the update plan schema, and is the only way the `rsa_count_mismatch` finding can ever be resolved without manual UI work.

**Independent Test**: Starting from an ad group with exactly 1 live, non-REMOVED RSA, apply a plan with one `addRsa` block for that `adGroupId` carrying a valid 15H/4D RSA. Verify a second, distinct RSA is now live and PAUSED on the ad group, the first RSA is untouched, and a subsequent `/adkit audit` no longer reports `rsa_count_mismatch` for that ad group (once the new RSA is enabled and serving).

**Acceptance Scenarios**:

1. **Given** an ad group with exactly 1 live, non-REMOVED RSA, **When** an operator applies a plan containing an `addRsa` block for that `adGroupId` with 15 valid headlines and 4 valid descriptions, **Then** a new, second RSA is created live on that ad group in **PAUSED** state, the existing RSA is left unmodified, and the CLI reports the ad group as changed (not skipped).
2. **Given** an `addRsa` block that omits `finalUrl`, **When** the plan is applied, **Then** the new RSA's `finalUrl` defaults to the ad group's existing live RSA's `finalUrl`.
3. **Given** an `addRsa` block that supplies `path1`/`path2`, **When** the block is validated, **Then** they are checked against the same display-path rules `/adkit create` and `rewrites` already enforce.

---

### User Story 2 - Re-running an already-applied plan is a safe no-op (Priority: P1)

An operator re-runs the same update plan a second time (accidentally, or as part of a repeatable workflow) after an `addRsa` block was already applied and the ad group now carries 2 live RSAs. The plan must not create a 3rd RSA.

**Why this priority**: Idempotency is a load-bearing convention across every existing plan section (`adGroups`, `campaignStatus`, `bidding`, keyword adds, etc.) — a section that violates it would drift ad groups past the exactly-2 `RSAS_PER_AD_GROUP` invariant `BriefSchema` enforces, corrupting both live state and the local brief on every accidental re-run. This is inseparable from P1 shipping safely.

**Independent Test**: Apply the same plan twice in a row against an ad group starting with 1 live RSA. After the first apply the ad group has 2 live RSAs; after the second apply it still has exactly 2 (no 3rd created), and the second run reports that `addRsa` block as **skipped**.

**Acceptance Scenarios**:

1. **Given** an ad group that already has 2 (or more) live, non-REMOVED RSAs, **When** a plan's `addRsa` block targets that `adGroupId`, **Then** the block is reported **skipped** and no live mutation is attempted for it.
2. **Given** a dry-run (no `--apply`) of a plan with an `addRsa` block, **When** the ad group already has 2 live RSAs, **Then** the dry-run output shows the block would be skipped, with no live mutation performed either way (dry-run never mutates).

---

### User Story 3 - Invalid `addRsa` copy is rejected before any live mutation (Priority: P2)

An operator writes an `addRsa` block with copy that violates the RSA rules (wrong headline/description count, headline over 30 chars, description over 90 chars, duplicate headline/description text, or a bad display path). `ads.sh update` must reject the whole plan at validation (dry-run-safe), the same way a malformed `rewrites` or `adGroups` block is rejected today — never partially apply and never fail mid-mutation against the live API.

**Why this priority**: Consistent with every other plan section's contract ("a bad ad group is rejected at dry-run, not mid-apply") and prevents an ad group from being left in a bad or ambiguous live state. Lower priority than P1/P1 because it's a safety property layered on top of a feature that must already exist to be validated.

**Independent Test**: Validate (without `--apply`) a plan containing one well-formed `addRsa` block and one malformed `addRsa` block (e.g. 12 headlines instead of 15). Verify validation fails with a human-readable error identifying the offending block, and that no live mutation occurs for either block.

**Acceptance Scenarios**:

1. **Given** an `addRsa` block with a headline/description count other than 15/4, **When** the plan is validated, **Then** validation fails with an error naming the `adGroupId` and the actual vs. required count, and the mutation step never runs.
2. **Given** an `addRsa` block with a headline over 30 characters or a description over 90 characters, **When** the plan is validated, **Then** validation fails naming the offending text and its length.
3. **Given** an `addRsa` block with duplicate headline or description text, **When** the plan is validated, **Then** validation fails naming the duplication.
4. **Given** an `addRsa` block whose `adGroupId` is missing or non-numeric, **When** the plan is validated, **Then** validation fails naming the entry.
5. **Given** an `addRsa` block targeting an `adGroupId` that has no live ad group on the account (removed, wrong customer, typo), **When** the plan is applied, **Then** the failure is caught and reported per-block (mirroring the existing per-slug failure isolation other sections use), without aborting unrelated blocks in the same plan.

---

### User Story 4 - The local brief gains the new RSA (Priority: P2)

After a successful `addRsa` apply, the operator's local `adbriefs/<slug>.yaml` — the source of truth reviewed via the stage+diff step — reflects the new RSA in the targeted ad group's `responsiveSearchAds` array, so the brief stops failing `BriefSchema`'s exactly-2 RSA requirement and stays in sync with live state, the same way every other successful plan section stages its change into the brief before it's written.

**Why this priority**: Necessary for the brief to remain the accurate source of truth (per `reference/update.md`'s existing stage+diff review gate), but the live mutation (P1) is the change that actually resolves the audit finding — the brief update is bookkeeping on top of it.

**Independent Test**: Apply a plan with one `addRsa` block targeting an ad group resolvable to a known `adbriefs/<slug>.yaml` (via the existing state-index reverse lookup). After apply, the diff shown before writing includes the new RSA appended to that ad group's `responsiveSearchAds`, and the written brief now has exactly 2 entries there and re-parses successfully against `BriefSchema`.

**Acceptance Scenarios**:

1. **Given** an `addRsa` block whose `adGroupId` resolves to a known brief slug, **When** the plan is applied, **Then** the proposed brief diff (shown before any file write, per the existing stage+diff step) includes the new RSA added to that ad group, and the written brief parses against `BriefSchema`.
2. **Given** an `addRsa` block whose `adGroupId` does not resolve to any known brief slug (no matching state-index entry), **When** the plan is applied, **Then** the live mutation still proceeds (per US1) and the unresolved id is surfaced as a warning (mirroring how other sections handle an unresolved id today), with no brief file affected.

---

### Edge Cases

- An `addRsa` block targeting an ad group that already has **3 or more** live RSAs (a pre-existing over-count from manual UI edits) is also treated as already-satisfied and skipped — `addRsa` only ever *adds toward* 2, never removes, so an over-count is left exactly as `reference/audit.md` already documents (still requires manual UI cleanup).
- Two `addRsa` blocks in the same plan targeting the **same** `adGroupId`: since the first block's apply would bring the ad group to 2 (already-satisfied) before the second is evaluated, the second is treated as a skip against the *post-first-block* live/staged count, not a second creation — consistent with the "only ever reach 2" idempotency guarantee (P1/P2). Validated as errors are surfaced per-block, so a bad second block is still reported even though it will end up skipped.
- An `addRsa` block on an ad group with **0** live RSAs (fully empty, unusual but possible) is treated the same as the 1-RSA case: not yet at 2, so it creates — `addRsa` does not require exactly 1 existing RSA, only "fewer than 2."
- `finalUrl` omitted on an `addRsa` block for an ad group with **0** live RSAs to default from: since there is no existing RSA to source a `finalUrl` from, this is a validation error (missing required `finalUrl`), not a silent empty string.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The update plan schema MUST accept a new, optional top-level `addRsa` section: an array of blocks, each carrying `adGroupId` (required), `headlines` (array of 15 strings), `descriptions` (array of 4 strings), and optional `finalUrl`, `path1`, `path2` — mirroring the field ergonomics (bare-string headlines/descriptions, https `finalUrl`) `rewrites` and `adGroups`' embedded `responsiveSearchAds` already use.
- **FR-002**: Each `addRsa` block MUST be validated against the same RSA rules `/adkit create` and the existing `rewrites`/`adGroups` sections enforce — exactly 15 headlines (≤30 chars each), exactly 4 descriptions (≤90 chars each), no duplicate headline or description text, no asset pinning, and (when `path1`/`path2` are present) the same display-path rules `rewrites` already applies — with no new rule invented for this section.
- **FR-003**: A block with a missing or non-numeric `adGroupId` MUST fail validation, naming the offending entry, mirroring how `keywords`/`adGroups`/`negatives` blocks report a bad id.
- **FR-004**: Validation MUST fail the whole plan (not partially apply) when any `addRsa` block is invalid, before any live mutation is attempted for any block in the plan — same dry-run-safe contract every other section has.
- **FR-005**: An `addRsa` block whose target ad group already has 2 or more live, non-REMOVED RSAs MUST be treated as already-satisfied and reported **skipped** — never mutated, and never used to create a 3rd or later RSA. This is the idempotency guarantee that makes re-running a plan safe.
- **FR-006**: An `addRsa` block whose target ad group has fewer than 2 live, non-REMOVED RSAs MUST result in exactly one new, distinct RSA being created live on that ad group, published in **PAUSED** status — matching the existing convention that every RSA `/adkit create` and `adGroups` publish starts PAUSED (no unreviewed live spend).
- **FR-007**: When an `addRsa` block omits `finalUrl`, the system MUST default it to the target ad group's existing live RSA's `finalUrl` when one exists; when no live RSA exists to default from, a missing `finalUrl` MUST be a validation error rather than silently applying an empty URL.
- **FR-008**: A live-mutation failure for one `addRsa` block (e.g. the target `adGroupId` has no live ad group at all) MUST be caught and reported per-block, without aborting the processing of other, unrelated blocks in the same plan or other plan sections — matching the existing per-slug failure isolation (`recordFailure`) convention.
- **FR-009**: The dry-run (no `--apply`) path MUST report, for every `addRsa` block, whether it would create or skip, and MUST perform no live mutation regardless of `--apply`.
- **FR-010**: The JSON output envelope MUST include new keys reporting `addRsa` changes and skips (following the existing `campaignStatusChanges`/`campaignStatusSkipped`-style idempotency-reporting pattern already used by other sections), so a caller can distinguish "created a new RSA" from "already had 2, skipped" per block without parsing prose.
- **FR-011**: When an `addRsa` block's `adGroupId` resolves (via the existing state-index reverse lookup already used by `rewrites`/`appendHeadlines`/`keywords`) to a tracked `adbriefs/<slug>.yaml`, a successful apply MUST stage the new RSA into that ad group's `responsiveSearchAds` array in the proposed brief, shown in the pre-write diff, before the brief file is written — matching how every other successful plan section stages its change into the brief.
- **FR-012**: When an `addRsa` block's `adGroupId` does not resolve to any tracked brief, the live mutation (FR-006) MUST still proceed, and the unresolved id MUST be surfaced as a warning — matching how an unresolved id in any other section is handled today, not treated as a fatal error.
- **FR-013**: `reference/update.md` MUST document the `addRsa` section (fields, defaulting, idempotency, PAUSED convention) in the same style as the other plan-lever bullets, and `reference/audit.md`'s `rsa_count_mismatch` note MUST be updated to state that the under-2 case is now fixable via `ads.sh update`'s `addRsa` lever, while an over-2 (3+) count still requires manual UI cleanup (no remove-RSA operation exists).
- **FR-014**: `addRsa` MUST NOT change `RSAS_PER_AD_GROUP` (2) or `BriefSchema`'s exactly-2 RSA requirement — it only adds a way to *reach* 2 from below; it never lowers, removes, or changes the meaning of the existing invariant.

### Key Entities

- **`addRsa` plan block**: One operator-authored instruction: "this ad group should get a second, distinct RSA with this copy." Carries the ad group's live identifier (`adGroupId`), the new RSA's copy (15 headlines, 4 descriptions), and optional landing-page fields (`finalUrl`, `path1`, `path2`). Independently valid or invalid; independently resolves to create-or-skip against live state.
- **Live RSA count (per ad group)**: The number of live, non-REMOVED (ENABLED or PAUSED) Responsive Search Ads already on the target ad group — the value `addRsa`'s create-vs-skip decision and `rsa_count_mismatch` are both keyed on family with the same definition (both counts include PAUSED, exclude REMOVED, per the existing audit convention).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can author a valid `addRsa` plan entry (15 headlines / 4 descriptions) targeting an ad group with exactly 1 live RSA, apply it with `--apply`, and the ad group has 2 live RSAs immediately afterward — closing the exact gap `reference/audit.md` currently documents as unfixable.
- **SC-002**: Applying the same `addRsa` plan a second time against an ad group that already has 2 live RSAs never creates a 3rd — the ad group's live RSA count stays at exactly 2 across any number of re-runs of the same plan.
- **SC-003**: An `addRsa` block violating any RSA rule (wrong count, over-length text, duplicate text) is rejected at validation time (before `--apply` attempts any network mutation), with an error message that names the offending ad group and the specific rule violated.
- **SC-004**: After a successful apply whose `adGroupId` resolves to a tracked brief, the written `adbriefs/<slug>.yaml` for that ad group parses successfully against `BriefSchema` (exactly 2 `responsiveSearchAds`), with no manual edit required.
- **SC-005**: Following a successful `addRsa` apply and enabling the new RSA, a subsequent `/adkit audit` run no longer reports `rsa_count_mismatch` for that ad group.

## Assumptions

- This spec targets THIS repo's (`imosquera/adkit`) current codebase, not the possibly-divergent snapshot GitHub issue #63 was filed against (a downstream embed in `imosquera/lead-drop`). The issue's file list, function names (`addRsaErrors`, `addRsaPlan`, `applyAddRsaQuery`, `ApplyPlanComputed.addRsaCreates`), and doc wording are treated as a **shape hint**, not a required diff — the planning phase (`/speckit-plan`) is expected to name the actual functions/files needed against this repo's current `skills/adkit/scripts/src/fixes/plan.ts`, `gaql/builders.ts`, `bin/apply-fixes.ts`, and `adbriefs/apply-plan.ts`, which already have their own established per-section conventions (validation function + create/skip partition function in `plan.ts`; a `Query` builder in `builders.ts`; fetch → validate → mutate → envelope wiring in `apply-fixes.ts`; a `Resolved*Block` type plus `resolvePlanGroups`/`applyPlanToBrief` wiring in `apply-plan.ts`) that this feature is expected to follow, consistent with `appendHeadlines`'s and `adGroups`' existing patterns.
- "Live RSA count" for the create-vs-skip decision (FR-005/FR-006) uses the same definition `bin/audit.ts`'s `rsa_count_mismatch` finding already uses: ENABLED + PAUSED, excluding REMOVED — so `addRsa`'s notion of "already has 2" and the audit's notion of "already has 2" never disagree.
- The low-level Ads-API RSA-creation entity builder (`createResponsiveSearchAd` in `ads/entities.ts`, already used by both `/adkit create` and the `adGroups` section) is reused as-is for `addRsa`'s live mutation — no new low-level RSA-creation code path is introduced, only a new plan section that calls it once per create.
- There is no remove-RSA or replace-count operation in scope for this feature — an ad group with 3+ live RSAs (an over-count) is out of scope and continues to require manual UI cleanup, per FR-014 and the existing `reference/audit.md` note (only the under-2 half of the gap is closed).
- `addRsa` blocks are validated/applied independently per block (no batching across an ad group's multiple `addRsa` blocks beyond the same-plan double-target edge case already covered above) — consistent with how `rewrites`/`appendHeadlines`/`keywords` blocks are each independently validated today.

No `[NEEDS CLARIFICATION]` markers remain: every ambiguity surfaced during research (over-count handling, same-plan double-targeting, zero-RSA `finalUrl` default, brief-resolution-failure behavior, RSA count definition, reuse of the existing low-level RSA builder) was resolvable by direct analogy to an existing, already-shipped plan section's documented convention in this codebase (`adGroups`' skip-on-existing-name idempotency, `bin/audit.ts`'s RSA-count definition, `rewrites`'/`appendHeadlines`'s per-block validation and unresolved-id handling), so each was closed with a documented Assumption instead.
