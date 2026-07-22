# Tasks: Encode headline & description best practices into `/adkit gtm` ad-copy authoring

**Feature**: `031-adcopy-best-practices` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Scope**: Documentation-only edit of two reference files —
`skills/adkit/reference/google/4-ad-copy.md` and `skills/adkit/reference/gtm.md`.
No source, config, or test files change. "Tests" here are documentation review
checks, not automated suites.

## Phase 1: Setup

- [ ] T001 Confirm the two target files and their current anchors: the end of `skills/adkit/reference/google/4-ad-copy.md` (after "B2B SaaS Quick Reference") and the `### Ad Copy — Eight Principles (binding)` block in `skills/adkit/reference/gtm.md` (~line 275).

## Phase 2: Foundational

- [ ] T002 Record the exact set of pre-existing hard constraints in the `gtm.md` Ad Copy Phase Output Contract + Eight Principles + self-check (15 headlines / 4 descriptions, ≤30-char headlines, ≤90-char descriptions, ≥2 numbers, ≥1 CTA verb, keyword-in-≥3, no shared opening-3-words, no pins) as the invariant baseline for the US3 no-regression check. (depends on T001)

## Phase 3: User Story 1 — Copy authored with named persuasion angles (P1)

**Goal**: `4-ad-copy.md` gains "Persuasion Angles" + "Quality-Score Alignment"
sections, and `gtm.md`'s Ad Copy Phase references them so generated RSAs
distribute across the three angles and satisfy the relevance rules.

**Independent test**: Read both docs; confirm the three angles (with formulas) and
the quality-score rules are present and cited from `gtm.md`.

- [ ] T003 [US1] Add a `## Persuasion Angles` section to `skills/adkit/reference/google/4-ad-copy.md` documenting the three offer/temperature-matched frames — cost-of-inaction (`[Pain Point] + [Financial/Time Loss] + [Solution]`), FOMO/scarcity-urgency (`[Scarcity/Limit] + [Benefit] + [Urgency]`), risk-reversal (`[Trust Signal] + [Risk Reversal] + [Solution]`) — each with a short example and a note tying angle choice to the theme's resolved temperature (FOMO/hard-CTA only on hot/scalding). (depends on T001)
- [ ] T004 [US1] Add a `## Quality-Score Alignment` section to `skills/adkit/reference/google/4-ad-copy.md` covering: landing-page match, ad-group keywords in headlines (incl. long-tail, no stuffing), keyword insertion `{KeyWord:<fallback>}` where the theme has many close variants, explicit instructive CTA, USP-led over generic features, emotion+logic mix across the set, avoid near-duplicate phrasing (cross-referencing the existing no-shared-opening-3-words rule), and purposeful use of the full char limit. (depends on T003)
- [ ] T005 [P] [US1] Add one concise binding principle to the `### Ad Copy — Eight Principles (binding)` area of `skills/adkit/reference/gtm.md` that cites `4-ad-copy.md`'s Persuasion Angles + Quality-Score Alignment as canonical, instructing the generator to distribute the 15 headlines across the three angles (as the offer allows) and satisfy the relevance rules — without restating the full list or adding a new required count. (depends on T002)

## Phase 4: User Story 2 — Fabrication guard explicit for scarcity & guarantees (P1)

**Goal**: The FOMO/scarcity and risk-reversal frames explicitly forbid inventing
scarcity/urgency/guarantees/proof; the angle is omitted when the source idea
doesn't back it.

**Independent test**: The Persuasion Angles section carries an explicit
"never invent — pull only from the source idea; omit if unsupported" clause.

- [ ] T006 [US2] In the `## Persuasion Angles` section of `skills/adkit/reference/google/4-ad-copy.md`, add an explicit honest-use gate on the FOMO/scarcity and risk-reversal frames: scarcity limits, urgency, guarantees, and proof numbers are used ONLY when the source idea backs them, and the angle is omitted otherwise — never fabricated (cross-reference the existing "never invent stats" rule). (depends on T003)
- [ ] T007 [US2] Add the emotion→logic handoff guidance to `skills/adkit/reference/google/4-ad-copy.md`: an emotional/loss-framed headline pairs with a description that follows through with the logical benefit/feature and a clear next step. (depends on T003)

## Phase 5: User Story 3 — Existing hard constraints stay intact (P2)

**Goal**: No pre-existing numeric constraint changes; no new required count added.

**Independent test**: `git diff` of `gtm.md` shows only additive qualitative text;
every numeric gate from T002 is byte-for-byte intact.

- [ ] T008 [US3] Diff `skills/adkit/reference/gtm.md` and confirm every baseline constraint from T002 is unchanged and no new mandatory count was introduced in the Output Contract or self-check (step A5); the only `gtm.md` change is the single additive principle from T005. (depends on T002, T005, T006, T007)

## Phase 6: Polish & Cross-Cutting

- [ ] T009 Cross-consistency check: confirm `gtm.md` cites `4-ad-copy.md` as the canonical source for the new guidance (no duplicated/contradictory rules) and both docs use consistent terminology (FR-009). (depends on T004, T005, T006, T007)
- [ ] T010 Final read-through of both edited files against issue #31's acceptance criteria (Persuasion Angles + Quality-Score Alignment present; gtm references them; hard constraints intact; explicit no-invent clause). (depends on T008, T009)

## Dependencies & Story Completion Order

- Setup (T001) → Foundational (T002) → US1 (T003–T005) → US2 (T006–T007) → US3 (T008) → Polish (T009–T010).
- US1 is the MVP: shipping just the two `4-ad-copy.md` sections + the `gtm.md` reference delivers the core value.
- US2 and US3 build on US1's `## Persuasion Angles` section.

## Execution Wave DAG

- **Wave 1**: T001
- **Wave 2**: T002
- **Wave 3**: T003, T005 (different files — parallelizable; T005 depends only on T002)
- **Wave 4**: T004, T006, T007 (all edit the same `4-ad-copy.md` after T003 — sequence to avoid edit conflicts)
- **Wave 5**: T008, T009
- **Wave 6**: T010

## Implementation Strategy

MVP = US1 (T001–T005): the persuasion + quality-score sections and the `gtm.md`
reference. Layer US2 (honest-use gate + emotion→logic), then verify US3
(no-regression) and polish. Because everything is additive documentation, each
wave is independently reviewable via `git diff`.
