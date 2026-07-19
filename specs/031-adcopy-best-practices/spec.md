# Feature Specification: Encode headline & description best practices into `/adkit gtm` ad-copy authoring

**Feature Branch**: `031-adcopy-best-practices`

**Created**: 2026-07-19

**Status**: Draft

**Input**: User description: "Encode Google Ads headline & description best practices into the /adkit gtm ad-copy authoring rules. See GitHub issue #31."

## Clarifications

### Session 2026-07-19

- Q: Is "distribute across the 3 persuasion angles" a new hard count or qualitative guidance? → A: Qualitative distribution — no new required count; the Ad Copy Phase self-check keeps exactly its current numeric gates.
- Q: In `gtm.md`, expand the binding "Eight Principles" into more numbered principles, or add one cross-referencing principle pointing at `4-ad-copy.md`? → A: Add a concise binding principle that cites `4-ad-copy.md` as the canonical source (with light inline reinforcement); do not duplicate all the items into `gtm.md`.
- Q: Scope of the keyword-insertion (`{KeyWord:<fallback>}`) "extend guidance" item? → A: Document the "use where the theme has many close variants" guidance in `4-ad-copy.md`'s Quality-Score section only; leave the existing `gtm.md` hot/scalding hard rule unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Copy authored with named persuasion angles (Priority: P1)

An operator runs `/adkit gtm` on a processed idea. For each non-spend-trap theme, the generated RSA headline/description set no longer reads as a flat list of feature restatements: it deliberately distributes across proven persuasion angles — cost-of-inaction, FOMO/scarcity-urgency, and risk-reversal — matched to the theme's resolved temperature, so the copy is built to convert rather than merely satisfy structural counts.

**Why this priority**: This is the core of the request — the authoring rules today enumerate structural constraints (15 headlines, char caps, keyword inclusion) but are thin on the *persuasion patterns* that make copy convert. Without this, generated copy passes the counts but underperforms.

**Independent Test**: Read the authoring rules (`gtm.md` Ad Copy Phase + `4-ad-copy.md`) and confirm they instruct the generator to cover the three named persuasion angles with their frame formulas; generate an RSA set for a sample idea and confirm the headlines visibly span those angles rather than restating one benefit 15 ways.

**Acceptance Scenarios**:

1. **Given** a theme with a hot/scalding resolved offer, **When** the Ad Copy Phase authors its RSA set, **Then** the set includes headlines drawn from the cost-of-inaction, FOMO/scarcity, and risk-reversal frames (as fits the offer) alongside the existing value/feature/proof angles.
2. **Given** a theme resolved cold or warm, **When** the RSA set is authored, **Then** FOMO/scarcity and hard-CTA framing are softened or omitted (curiosity/value instead), consistent with the existing temperature gradient.
3. **Given** the reference doc `4-ad-copy.md`, **When** an operator or the generator reads it, **Then** it contains a "Persuasion Angles" section (the three frames, each with its formula and honest-use gate) and a "Quality-Score Alignment" section (landing-page match, keyword-in-headline, keyword insertion, explicit CTA, USP-led, emotion+logic mix, no repetition, purposeful char usage).

---

### User Story 2 - Fabrication guard is explicit for scarcity and guarantees (Priority: P1)

An operator relies on the generated copy being safe to publish. The FOMO/scarcity and risk-reversal angles are exactly the ones that tempt invented limits and guarantees ("Only 3 Spots Left", "100% Risk-Free", "Trusted by 10,000 Teams"). The rules must state explicitly that scarcity, guarantees, and proof numbers may only be used when the source idea backs them.

**Why this priority**: A wrong guess here is a real-world harm — fabricated scarcity/guarantees are misleading and can breach ad policy. The existing rules already forbid invented stats generally; this makes the guard explicit at the two new angles that most invite it.

**Independent Test**: Confirm the new persuasion-angle rules carry an explicit "never invent scarcity/guarantees/proof — pull only from the source idea; omit the angle if unsupported" clause; generate copy for an idea with no stated scarcity and confirm no invented limits or guarantees appear.

**Acceptance Scenarios**:

1. **Given** a source idea that states no scarcity or guarantee, **When** the FOMO or risk-reversal angle would apply, **Then** the generator omits that angle rather than inventing a limit or guarantee.
2. **Given** a source idea that states a real number (price, capacity, trial length, customer count), **When** it supports a scarcity, risk-reversal, or proof headline, **Then** that number may be used verbatim.

---

### User Story 3 - Existing hard constraints stay intact (Priority: P2)

An operator (and the downstream `/adkit create` "Excellent"-strength check) depends on the current structural contract: exactly 15 headlines and 4 descriptions per theme, character limits, no pinning, no fabricated stats. The new qualitative guidance must not silently change any of these counts or introduce a new numeric gate.

**Why this priority**: Regressing the structural contract would break `/adkit create`'s publish-ready requirement and the phase's self-check. The additions are qualitative reinforcement, not new counts.

**Independent Test**: Diff the Output Contract and Eight Principles before/after; confirm every existing numeric constraint (15/4, ≤30-char headlines, ≤90-char descriptions, ≥2 numbers, ≥1 CTA verb, keyword-in-≥3, no shared opening-3-words, no pins) is unchanged and no new required count was added.

**Acceptance Scenarios**:

1. **Given** the updated Ad Copy Phase, **When** the self-check (step A5) runs, **Then** it still enforces exactly the pre-existing numeric minimums plus, at most, qualitative angle-coverage guidance — no new mandatory count.
2. **Given** the updated `4-ad-copy.md`, **When** it is read end-to-end, **Then** the pre-existing Headline Pools, Pinning Strategy, Supporting Assets, and Checklist sections remain intact.

---

### Edge Cases

- **Idea with no scarcity or guarantee material**: the FOMO and risk-reversal angles are simply not used for that theme; the rules must make omission the default, never invention.
- **Cold/warm theme**: scarcity-urgency and hard CTAs are inappropriate; angle guidance must defer to the existing temperature gradient so a cold theme is not pushed into FOMO framing.
- **Only 15 headline slots**: the three persuasion angles compete with the existing required angles (value, feature, proof, CTA, keyword-echo). Guidance must frame the angles as a distribution to draw from, not as additional mandatory slots that would over-subscribe the 15.
- **Keyword insertion `{KeyWord:<fallback>}`**: already required on hot/scalding themes; the new guidance must extend, not contradict, that rule.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `skills/adkit/reference/google/4-ad-copy.md` MUST gain a "Persuasion Angles" section documenting three offer/temperature-matched frames: cost-of-inaction (`[Pain Point] + [Financial/Time Loss] + [Solution]`), FOMO/scarcity-urgency (`[Scarcity/Limit] + [Benefit] + [Urgency]`), and risk-reversal (`[Trust Signal] + [Risk Reversal] + [Solution]`), each with a short example and an honest-use gate.
- **FR-002**: `4-ad-copy.md` MUST gain a "Quality-Score Alignment" section covering: align copy with the landing page (same promise/claim), use ad-group keywords (incl. long-tail) in headlines without stuffing, keyword insertion `{KeyWord:<fallback>}` where the theme has many close variants, explicit instructive CTA, lead with USPs over generic features, mix emotional and rational tonality across the set, avoid near-duplicate phrasing, and use the full character limit purposefully (descriptive, not padded).
- **FR-003**: The FOMO/scarcity and risk-reversal frames in `4-ad-copy.md` MUST state explicitly that scarcity, urgency limits, guarantees, and proof numbers are used ONLY when the source idea backs them, and the angle is omitted otherwise — never invented.
- **FR-004**: The `4-ad-copy.md` guidance MUST describe an emotion→logic handoff: an emotional/loss-framed headline pairs with a description that follows through with the logical benefit/feature and a clear next step.
- **FR-005**: The `/adkit gtm` Ad Copy Phase in `skills/adkit/reference/gtm.md` MUST reference the new `4-ad-copy.md` best practices so generated RSAs distribute across the three persuasion angles and satisfy the quality-score/relevance rules at generation time. Per clarification, this is done by adding a concise binding principle that cites `4-ad-copy.md` as the canonical source (with light inline reinforcement) — NOT by duplicating the full persuasion/quality-score list into `gtm.md`. The keyword-insertion "many close variants" guidance lives in `4-ad-copy.md` only; the existing `gtm.md` hot/scalding `{KeyWord:<fallback>}` hard rule is left unchanged.
- **FR-006**: The Ad Copy Phase MUST tie persuasion-angle selection to each theme's already-resolved temperature (cold/warm/hot/scalding) so FOMO/scarcity and hard CTAs appear only on hot/scalding themes, consistent with the existing temperature gradient — introducing no conflicting rule.
- **FR-007**: All pre-existing hard constraints in the Ad Copy Phase MUST remain intact and unchanged: exactly 15 headlines and 4 descriptions per theme, ≤30-char headlines, ≤90-char descriptions, ≥2 verifiable numbers, ≥1 explicit CTA verb, keyword concept in ≥3 headlines, no two headlines sharing the opening 3 words, and no pinning. The additions are qualitative and MUST NOT introduce a new required count; the self-check (step A5) keeps exactly its current numeric gates (per clarification).
- **FR-008**: The updated rules MUST reinforce (not duplicate or contradict) the existing "vary word choice / no two headlines share opening 3 words" anti-repetition rule and the existing "never fabricate stats — pull from the source idea" rule; the new text cross-references rather than restates conflicting numbers.
- **FR-009**: The two documents MUST stay mutually consistent: `gtm.md`'s Ad Copy Phase cites `4-ad-copy.md` as the source of the persuasion/quality-score guidance (as it already does for headline pools/pinning), so a reader following either entry point reaches the same rules.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reader of `4-ad-copy.md` can name all three persuasion angles, their frame formulas, and the honest-use gate for scarcity/guarantees without consulting any other document.
- **SC-002**: For a sample processed idea with real pricing/proof, a generated RSA set visibly spans at least the three persuasion angles (where the offer supports them) in addition to the existing value/feature/proof/CTA angles, with zero invented scarcity or guarantees.
- **SC-003**: For a sample idea that states no scarcity or guarantee, the generated copy contains no scarcity claim and no guarantee — the angle is omitted, not fabricated.
- **SC-004**: A before/after diff shows every pre-existing numeric constraint (15/4 counts, char caps, ≥2 numbers, ≥1 CTA, keyword-in-≥3, no-shared-opening-3, no pins) unchanged, and no new mandatory count added.
- **SC-005**: 100% of the acceptance-criteria items listed in issue #31 are satisfied by the edited docs.

