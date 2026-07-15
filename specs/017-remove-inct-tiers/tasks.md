# Tasks: Remove hardcoded I/N/C/T tiers, use only LLM-generated Keyword Themes

**Input**: Design documents from `specs/017-remove-inct-tiers/` (plan.md, spec.md)

**Tests**: No new test tasks are generated — the feature spec's FR-008/FR-010 require
*updating existing* test fixtures so the current suite keeps passing under the new
theme-only structure, not adding new test coverage. Fixture updates are folded into
each user story's tasks below.

**Organization**: Tasks are grouped by user story (spec.md) to enable independent
implementation and verification of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Phase 1: Setup

No project-initialization work is required — this feature edits existing files only,
no new package, dependency, or scaffolding is introduced.

## Phase 2: Foundational

No blocking shared infrastructure — each user story below touches disjoint files and
can proceed independently once Phase 3 (US1, the primary doc) establishes the new
offer-resolution language other docs cross-reference.

---

## Phase 3: User Story 1 - Author runs gtm.md and gets a single theme system (Priority: P1) 🎯 MVP

**Goal**: `gtm.md` authors only the LLM-generated `### Keyword Themes` structure;
`> Offer:` resolution derives from each theme's member keywords directly, with no
I/N/C/T tier system.

**Independent Test**: Read `skills/adkit/reference/gtm.md` end to end; confirm no
`#### Informational` / `#### Navigational` / `#### Commercial` / `#### Transactional`
subsection mandate, no I/N/C/T tier definitions, and no Transactional > Commercial >
Navigational > Informational precedence-order language remain; confirm `> Offer:`
resolution reads from Keyword Themes' member keywords.

### Implementation for User Story 1

- [x] T001 [US1] In `skills/adkit/reference/gtm.md`, remove the `#### Informational` / `#### Navigational` / `#### Commercial` / `#### Transactional` subsection mandate from the Output Contract (current ~lines 48-52), the per-tier `> Default offer:` requirement, and the "four I/N/C/T intent tiers" framing from the Role section (~line 22) and Output Contract intro (~line 45); `### Keywords` keeps its keyword list + volume/competition/CPC decoration, `#### Dropped (off-topic)`, and `#### Negative Keywords` subsections
- [x] T002 [US1] In `skills/adkit/reference/gtm.md`, remove the `## Intent Definitions` section (current ~lines 98-122) and fold any still-needed buyer-intent signal language (free/DIY modifiers, comparison language, ready-to-act phrasing) into the Keyword Themes Contract's offer-resolution guidance instead (depends on T001)
- [x] T003 [US1] In `skills/adkit/reference/gtm.md`, rewrite the Keyword Themes Contract's `> Offer:` resolution rule (current ~line 83, "the theme's resolved offer = the Default offer of the theme's highest-actionable represented intent tier (Transactional > Commercial > Navigational > Informational)") to derive the offer directly from the theme's member keywords per Design Decision D1 in plan.md (depends on T002)
- [x] T004 [US1] In `skills/adkit/reference/gtm.md`, update step 10 (current ~line 187, tier assignment as "the buyer-intent + offer-matching annotation") and step 15c's `> Offer:` resolution bullet (current ~line 198, "Transactional > Commercial > Navigational > Informational") to match the new theme-only offer resolution from T003 (depends on T003)
- [x] T005 [US1] In `skills/adkit/reference/gtm.md`, update the Output Contract's verification checklist (current ~line 229, tier canonical-order bullet) and the final status-line format (current ~line 307, `<informational_count>/<navigational_count>/<commercial_count>/<transactional_count> keywords (I/N/C/T)`) to drop I/N/C/T-specific counts/ordering language (depends on T001)
- [x] T006 [US1] Re-read `skills/adkit/reference/gtm.md` end to end and confirm zero remaining references to Informational/Navigational/Commercial/Transactional as a fixed taxonomy (a plain-English mention of "commercial intent" describing a Keyword Theme's temperature is fine) (depends on T001, T002, T003, T004, T005)

**Checkpoint**: `gtm.md` is fully self-consistent with a single Keyword-Themes-only theme system.

---

## Phase 4: User Story 2 - Downstream reference docs no longer reference I/N/C/T (Priority: P1)

**Goal**: `create.md`, `google/2-keyword-mining.md`, `google/5-negative-keywords.md`,
and `google/3-account-structure.md` no longer treat I/N/C/T as a decision input.

**Independent Test**: Grep `skills/adkit/reference/` for Informational / Navigational
/ Commercial / Transactional as a taxonomy; confirm no remaining hits describe I/N/C/T
as a theme/tier classification.

### Implementation for User Story 2

- [x] T007 [P] [US2] In `skills/adkit/reference/create.md:37` ("Transactional > Commercial > Navigational > Informational"), remove the I/N/C/T precedence-order reference for resolving a theme's RSA temperature — the theme's own `> Offer:` line (already written by `gtm.md` per T003) already carries the resolved temperature, so this line should instead point at reading `> Offer:` directly
- [x] T008 [P] [US2] In `skills/adkit/reference/google/2-keyword-mining.md:28-39` ("Classify by Intent" table), replace the Transactional/Commercial/Informational/Navigational bucket table and its paid-vs-SEO routing with guidance that routes on Keyword Theme membership and on-theme/off-theme relevance per Design Decision D2 in plan.md; update the "Quick Reference" bullet (~line 64, "Intent → paid: transactional / commercial first...") to match
- [x] T009 [P] [US2] In `skills/adkit/reference/google/5-negative-keywords.md`, reframe the "Non-Commercial" category (current ~lines 10-93, esp. the three-list structure's Category 2 header and Category 1/6 framing around "informational intent") around theme relevance per Design Decision D3 in plan.md — keep the literal negative-keyword word lists, change only the categorical justification language
- [x] T010 [P] [US2] In `skills/adkit/reference/google/3-account-structure.md:25`, drop the "Transactional + commercial keywords" mention in the Solution campaign row of the Campaign Types table and rephrase without the I/N/C/T taxonomy
- [x] T011 [US2] Grep `skills/adkit/reference/` for `Informational|Navigational|Transactional|Commercial` and confirm every remaining hit is plain-English usage (e.g. describing a Keyword Theme's temperature), not a reference to the retired fixed taxonomy (depends on T007, T008, T009, T010)

**Checkpoint**: No reference doc outside `gtm.md` treats I/N/C/T as a taxonomy; `gtm.md` and these docs are consistent with each other.

---

## Phase 5: User Story 3 - Audit scoring code and its tests no longer depend on I/N/C/T tier names (Priority: P2)

**Goal**: `scoring.ts` drops `TIER_NAMES` and its generic-tier-label heuristic in
`conceptWords()`; all fixtures/tests use theme-style names and the full test suite
passes.

**Independent Test**: Run the `skills/adkit/scripts` test suite; confirm it passes
with no fixture depending on I/N/C/T tier names as ad-group/heading names, and that
`scoring.ts` no longer exports/uses `TIER_NAMES`.

### Implementation for User Story 3

- [x] T012 [US3] In `skills/adkit/scripts/src/audit/scoring.ts`, remove the `TIER_NAMES` constant (current lines 33-38) and simplify `conceptWords()` (current lines 51-53) per Design Decision D4 in plan.md so the ad-group-name fallback is unconditional (no generic-tier-label special case)
- [x] T013 [P] [US3] Update fixtures in `skills/adkit/scripts/src/audit/scoring.test.ts` (lines 61, 74) that use literal tier names (e.g. `"Commercial"`) as ad-group names, replacing them with theme-style names (e.g. `"Salon Software"`), and add/adjust assertions so the removed `TIER_NAMES` special case (T012) is exercised correctly by the new fixture (depends on T012)
- [x] T014 [P] [US3] Update fixtures in `skills/adkit/scripts/src/bin/audit.test.ts` (lines 103, 138, 156, 173, 191, 201, 220 — `"Commercial"`) to use theme-style ad-group names instead of I/N/C/T tier names (depends on T012)
- [x] T015 [P] [US3] Update fixtures in `skills/adkit/scripts/src/bin/create.test.ts` (lines 57, 61 — `#### Informational`, `#### Commercial` headings) to use theme-style `####` headings consistent with the new `### Keyword Themes` shape from T001-T005 (depends on T012)
- [x] T016 [P] [US3] Update fixtures in `skills/adkit/scripts/src/ideas/parse.test.ts` (lines 139, 155, 173 — same I/N/C/T headings) to use theme-style `####` headings (depends on T012)
- [x] T017 [US3] Run the full `skills/adkit/scripts` test suite and confirm 100% pass with zero remaining I/N/C/T literal in any fixture (depends on T013, T014, T015, T016)

**Checkpoint**: Code and tests are fully consistent with the theme-only structure; full suite green.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T018 Repository-wide grep for `Informational|Navigational|Transactional|Commercial` under `skills/adkit/` (docs + code + tests) and confirm zero taxonomy-style matches remain (SC-001) (depends on T006, T011, T017)
- [x] T019 Confirm `gtm.md`'s Keyword Themes output is the only theme structure referenced anywhere in `skills/adkit/reference/` for ad-group naming and offer resolution (SC-002) (depends on T018)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup / Foundational**: none — no blocking prerequisites.
- **US1 (Phase 3)**: No dependency on other stories; establishes the new offer-resolution language other stories/docs reference.
- **US2 (Phase 4)**: Independent of US1's file edits (different files) but conceptually consistent with T003's offer-resolution rewrite — recommended after US1 for consistency, not strictly blocked by it.
- **US3 (Phase 5)**: Fully independent of US1/US2 (different files: TypeScript source + tests, no markdown).
- **Polish (Phase 6)**: Depends on all three user stories being complete.

### Parallel Opportunities

- T007, T008, T009, T010 (US2, four different doc files) can run in parallel.
- T013, T014, T015, T016 (US3, four different test files) can run in parallel once T012 lands.
- US1, US2, and US3 as a whole can be worked in parallel by different contributors since they touch disjoint file sets (docs vs. docs vs. TypeScript).

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 3 (US1): `gtm.md` is internally consistent with the new theme-only offer resolution.
2. **STOP and VALIDATE**: Re-read `gtm.md`; confirm T006's checkpoint.

### Incremental Delivery

1. US1 → `gtm.md` consistent (MVP).
2. US2 → downstream docs consistent with `gtm.md` and each other.
3. US3 → code + tests consistent; full suite green.
4. Polish → repo-wide verification (SC-001, SC-002); SC-003 (100% test pass) is verified inside US3's T017.

## Notes

- [P] tasks touch different files with no shared-file conflicts.
- Every task names concrete files/line ranges from the source issue and plan.md's Design Decisions (D1-D4) so no additional context lookup should be needed to execute it.
- Commit after each user-story phase (or per task, per project convention).
