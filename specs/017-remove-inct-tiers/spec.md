# Feature Specification: Remove hardcoded I/N/C/T tiers, use only LLM-generated Keyword Themes

**Feature Branch**: `017-remove-inct-tiers`

**Created**: 2026-07-15

**Status**: Draft

**Input**: User description: "adkit: remove hardcoded I/N/C/T tiers, use only LLM-generated Keyword Themes from gtm.md — gtm.md currently produces two parallel theme structures: the LLM-generated Keyword Themes (free-form semantic clusters, 3-6 per run) and a separate, hardcoded four-tier Informational/Navigational/Commercial/Transactional (I/N/C/T) classification used to resolve each keyword's `> Offer:` line. Remove every trace of I/N/C/T and key ad-group naming, offer resolution, and negative-keyword categorization off the single LLM-generated theme set instead."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author runs gtm.md and gets a single theme system (Priority: P1)

A campaign strategist running the `gtm.md` skill workflow produces one set of Keyword Themes (LLM-generated semantic clusters) and uses those same themes to resolve each keyword's `> Offer:` line. There is no second, hardcoded four-tier classification competing for that role.

**Why this priority**: This is the core purpose of the change — collapsing two parallel, redundant theme systems into one removes the confusion and duplication the issue exists to fix.

**Independent Test**: Read `skills/adkit/reference/gtm.md` end to end; confirm the `#### Informational` / `#### Navigational` / `#### Commercial` / `#### Transactional` subsection mandate and the I/N/C/T precedence-order language for resolving `> Offer:` are gone, and that Offer resolution guidance instead references the LLM-generated Keyword Themes.

**Acceptance Scenarios**:

1. **Given** `skills/adkit/reference/gtm.md`, **When** a strategist looks for how to structure keyword themes, **Then** the only theme structure described is the LLM-generated Keyword Themes (free-form semantic clusters).
2. **Given** `skills/adkit/reference/gtm.md`, **When** a strategist looks for how an `> Offer:` line is resolved for a keyword, **Then** the guidance derives the offer from the keyword's Keyword Theme, not from an I/N/C/T precedence order.

---

### User Story 2 - Downstream reference docs no longer reference I/N/C/T (Priority: P1)

A strategist or engineer reading any other reference doc in `skills/adkit/reference/` (create.md, google/2-keyword-mining.md, google/5-negative-keywords.md, google/3-account-structure.md) no longer encounters the I/N/C/T taxonomy as a decision input — those docs instead reason in terms of the LLM-generated Keyword Themes where relevant.

**Why this priority**: The issue explicitly calls out five docs beyond gtm.md; leaving stale I/N/C/T references in any of them re-introduces the duplicate taxonomy the change is meant to eliminate.

**Independent Test**: Grep `skills/adkit/reference/` for Informational/Navigational/Commercial/Transactional as a taxonomy; confirm no remaining hits describe I/N/C/T as a theme/tier classification (a plain-English use of e.g. "commercial intent" describing a Keyword Theme, not the fixed taxonomy, is acceptable).

**Acceptance Scenarios**:

1. **Given** `skills/adkit/reference/create.md`, **When** a reader looks for how a theme's RSA temperature is resolved, **Then** no I/N/C/T precedence order is referenced.
2. **Given** `skills/adkit/reference/google/2-keyword-mining.md`, **When** a reader looks for keyword bucket/routing guidance, **Then** the Transactional/Commercial/Informational/Navigational bucket table is removed or replaced with theme-based guidance.
3. **Given** `skills/adkit/reference/google/5-negative-keywords.md`, **When** a reader looks for negative-keyword categories, **Then** "Non-Commercial"/"Informational" no longer appear as fixed categories; relevance is instead framed against the keyword's theme.
4. **Given** `skills/adkit/reference/google/3-account-structure.md`, **When** a reader reviews account-structure guidance, **Then** the Transactional/commercial mention is removed.

---

### User Story 3 - Audit scoring code and its tests no longer depend on I/N/C/T tier names (Priority: P2)

An engineer running the audit skill's scoring logic (`skills/adkit/scripts/src/audit/scoring.ts`) gets ad-group concept words computed without any special-casing of generic tier labels (`informational`/`navigational`/`commercial`/`transactional`) as ad-group names, and the full test suite (audit, scoring, create, ideas/parse) passes using fixtures that no longer rely on the old taxonomy for ad-group/heading names.

**Why this priority**: Without this, the code and its tests still encode the retired taxonomy even after the docs are cleaned up, leaving a latent inconsistency and risking silent behavior differences if `conceptWords()` keeps special-casing tier names.

**Independent Test**: Run `skills/adkit/scripts` test suite; confirm it passes with no fixture depending on I/N/C/T tier names as ad-group/heading names, and confirm `scoring.ts` no longer exports/uses `TIER_NAMES`.

**Acceptance Scenarios**:

1. **Given** `skills/adkit/scripts/src/audit/scoring.ts`, **When** `conceptWords()` is called with an ad-group name that previously matched a tier label (e.g. "Commercial"), **Then** it treats that name like any other ad-group name (no generic-tier-label special case remains).
2. **Given** the full `skills/adkit/scripts` test suite, **When** it is run, **Then** all tests pass using fixtures that use theme-style names instead of I/N/C/T tier names.

### Edge Cases

- What happens to existing campaigns/data (spreadsheets, prior gtm.md outputs) that already used I/N/C/T labels? Out of scope — this change only affects the reference docs and code that generate *future* guidance/output; no migration of historical artifacts is implied.
- How does offer resolution behave when the LLM produces overlapping or ambiguous Keyword Themes? Existing Keyword Themes guidance in `gtm.md` (semantic clustering, 3-6 themes per run) already governs this; this change does not alter how themes are generated, only what resolves the `> Offer:` line and ad-group/negative-keyword categorization.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `skills/adkit/reference/gtm.md` MUST NOT mandate `#### Informational` / `#### Navigational` / `#### Commercial` / `#### Transactional` subsections, MUST NOT define the four I/N/C/T tiers, and MUST NOT use I/N/C/T precedence order (Transactional > Commercial > Navigational > Informational) to resolve a keyword's `> Offer:` line.
- **FR-002**: `skills/adkit/reference/gtm.md` MUST describe the LLM-generated Keyword Themes as the single theme structure, and MUST describe `> Offer:` resolution as derived from a keyword's Keyword Theme.
- **FR-003**: `skills/adkit/reference/create.md` MUST NOT reference I/N/C/T precedence order for resolving a theme's RSA temperature.
- **FR-004**: `skills/adkit/reference/google/2-keyword-mining.md` MUST NOT present a Transactional/Commercial/Informational/Navigational bucket table or paid-vs-SEO routing tied to that taxonomy.
- **FR-005**: `skills/adkit/reference/google/5-negative-keywords.md` MUST NOT present "Non-Commercial"/"Informational" as fixed negative-keyword categories; negative-keyword relevance guidance MUST instead be framed in terms of Keyword Theme relevance.
- **FR-006**: `skills/adkit/reference/google/3-account-structure.md` MUST NOT mention Transactional/commercial as an account-structure taxonomy input.
- **FR-007**: `skills/adkit/scripts/src/audit/scoring.ts` MUST NOT define or export `TIER_NAMES`, and `conceptWords()` MUST NOT special-case generic tier labels as ad-group names.
- **FR-008**: Test fixtures in `skills/adkit/scripts/src/bin/audit.test.ts`, `skills/adkit/scripts/src/audit/scoring.test.ts`, `skills/adkit/scripts/src/bin/create.test.ts`, and `skills/adkit/scripts/src/ideas/parse.test.ts` MUST use ad-group/heading names that do not depend on the I/N/C/T taxonomy.
- **FR-009**: No file under `skills/adkit/` may mention Informational/Navigational/Commercial/Transactional (or I/N/C/T) as a fixed theme/tier taxonomy after this change.
- **FR-010**: The full `skills/adkit/scripts` automated test suite MUST pass after fixtures and source are updated.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A repository-wide search for Informational/Navigational/Commercial/Transactional as a fixed taxonomy under `skills/adkit/` returns zero matches (incidental plain-English usage describing a Keyword Theme is not a match).
- **SC-002**: `gtm.md`'s Keyword Themes output is the only theme structure referenced anywhere in `skills/adkit/reference/` for ad-group naming and offer resolution.
- **SC-003**: 100% of the `skills/adkit/scripts` test suite passes after the change, with zero test relying on an I/N/C/T literal.
