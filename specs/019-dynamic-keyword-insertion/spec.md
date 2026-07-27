# Feature Specification: Dynamic Keyword Insertion (DKI) in ad text

**Feature Branch**: `019-dynamic-keyword-insertion`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Support dynamic keyword insertion (DKI) in ad text" (GitHub issue #19)

## Clarifications

### Session 2026-07-18

- Q: How is DKI represented in the input? → A: Inline within the existing string fields (`headline.text`, `description.text`, `path1`/`path2`), parsed at the schema boundary — no new structured input field.
- Q: How is worst-case length computed for a field mixing literal text and DKI codes? → A: Replace every DKI code with its default text, then measure the resulting string against the field limit.
- Q: Is default-text whitespace trimmed or preserved? → A: Preserved verbatim (no trim), so the code round-trips byte-for-byte; length is measured on the exact default as written.
- Q: Does v1 render a substituted keyword preview (the all-caps preservation of FR-004)? → A: Casing mode is captured and a pure display-render helper is provided (small hardcoded all-caps token list), but the rendered preview is not persisted or emitted — emission stays verbatim.
- Q: How are lint warnings delivered? → A: A separate pure lint function returns structured advisory findings (category + message), non-blocking, distinct from the blocking parse.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author a DKI code that round-trips and respects field limits (Priority: P1)

An advertiser authoring an ad wants a headline, description line, or Display-path
segment to substitute the searcher's triggering keyword at serve time, falling back
to a supplied default when the keyword can't be inserted. They write the DKI code
`{keyword:default text}` into the field. The system accepts the field, guarantees the
code round-trips unchanged through parse and emit, and rejects the field up front if
the default text (the worst case for length) would push the field past its character
limit.

**Why this priority**: This is the core capability the issue asks for. Without
correct parsing, capitalization, a required default, and post-insertion length
enforcement, DKI cannot be authored safely at all. It is independently valuable: an
advertiser can add a single DKI headline and see it validated and published.

**Independent Test**: Author an ad group whose RSA contains one DKI headline
`{KeyWord:Running Shoes}`; confirm it parses, the default worst-case length is
enforced against the 30-char headline limit, and the exact `{KeyWord:Running Shoes}`
string is emitted to the ad builder unchanged.

**Acceptance Scenarios**:

1. **Given** a headline `{KeyWord:Running Shoes}` (default 13 chars ≤ 30), **When** the ad is parsed, **Then** it is accepted and the code is emitted verbatim to the ad builder.
2. **Given** a headline `{keyword:this default text is far too long to ever fit}` whose default exceeds 30 chars, **When** the ad is parsed, **Then** parsing fails with an actionable error naming the field, the limit, and the offending length.
3. **Given** a headline `{KeyWord}` with no default text, **When** the ad is parsed, **Then** parsing fails with an error stating a default text is required.
4. **Given** each of the five capitalization forms (`keyword`, `Keyword`, `KeyWord`, `KEYWord`, `KeyWORD`), **When** the field is parsed, **Then** each form is recognized as a valid DKI code and its casing mode is captured; an unrecognized casing token (e.g. `kEyword`) is rejected.

---

### User Story 2 - Use DKI only in permitted fields with clean Display paths (Priority: P2)

An advertiser must be prevented from placing DKI where Google forbids it — the Final
URL field — and from putting characters into a Display path (or its DKI default) that
Google rejects. The system accepts DKI in headlines, description lines, and Display
path segments only, rejects it in the Final URL, and rejects special/non-ASCII
characters (e.g. `é`) in the Display path and its DKI default text.

**Why this priority**: Prevents publishing ads Google will disapprove. Depends on the
core parser from P1 but adds field-placement and character constraints that catch a
distinct class of launch-blocking errors.

**Independent Test**: Attempt to author a DKI code in a Final URL and a Display path
containing `café`; confirm both are rejected with field-specific errors, while a clean
`{keyword:shoes}` Display path is accepted.

**Acceptance Scenarios**:

1. **Given** a DKI code in the Final URL field, **When** the ad is parsed, **Then** it is rejected with an error stating DKI/customizers are not allowed in Final URL.
2. **Given** a Display path `caf{keyword:é}`, or a Display-path DKI default containing `é`, **When** the ad is parsed, **Then** it is rejected for containing a special/non-ASCII character.
3. **Given** a Display-path DKI code `{keyword:shoes}` whose default is within the 15-char path limit, **When** the ad is parsed, **Then** it is accepted.

---

### User Story 3 - See lint warnings for risky-but-legal DKI before launch (Priority: P3)

An advertiser wants to be warned about DKI usage that is syntactically valid but
likely to cause problems at serve time, so bad DKI is caught before launch rather
than after disapproval or poor performance. The system surfaces non-blocking warnings
for the common failure modes documented by Google.

**Why this priority**: Improves quality and catches subtle issues, but is advisory —
the ad is still authorable without acting on warnings. Builds on P1/P2 parsing.

**Independent Test**: Author DKI ads that each trigger a distinct warning (near-limit
default, DSA context, restricted-content vertical, trademark-like token) and confirm
each produces a clearly-labelled warning without blocking parse.

**Acceptance Scenarios**:

1. **Given** a DKI default that fits but leaves little headroom, or an inserted keyword that would plausibly exceed the limit, **When** the ad is linted, **Then** a "too many characters" warning is surfaced.
2. **Given** DKI used in a Dynamic Search Ad context (no keyword targeting), **When** the ad is linted, **Then** a warning notes DKI is unavailable for DSA and the default text will be used.
3. **Given** DKI in a restricted vertical (Healthcare, Sexual Content) or containing a trademark-like token, **When** the ad is linted, **Then** a warning notes the insertion may be blocked by Google policy.
4. **Given** DKI whose default text reads ungrammatically in context, or a Display-path/landing-page combination that may not support dynamic text, **When** the ad is linted, **Then** best-effort grammar/misspelling/landing-page warnings are surfaced.

---

### Edge Cases

- **Nested or malformed braces**: `{keyword:{x}}`, `{keyword:a}b}`, or an unclosed `{keyword:a` — parsing must reject malformed codes with a clear error rather than silently mis-parsing.
- **Literal braces in copy**: text that legitimately contains `{` or `}` but is not a DKI code must not be mistaken for one; a `{...}` that is not a valid DKI code is an error, not silent pass-through.
- **Multiple DKI codes in one field**: e.g. `{keyword:a} for {keyword:b}` — each code is validated and the combined worst-case (all defaults inserted) is measured against the field limit.
- **Empty default** (`{keyword:}`): rejected — a non-empty default is required.
- **All-caps token preservation**: `KEYWord`/`KeyWORD` modes must preserve known all-caps tokens (e.g. `USA`) rather than lower-casing or title-casing them.
- **Whitespace in default**: leading/trailing whitespace in the default is handled deterministically (trimmed or preserved consistently) so length enforcement and round-trip are stable.
- **Backward compatibility**: existing ads with plain (non-DKI) headlines/descriptions/paths continue to parse and emit unchanged.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST parse the DKI code form `{keyword:default text}` inline within the existing RSA headline, description-line, and Display-path (Display URL) string fields, capturing the casing mode and the default text. No new structured input field is introduced.
- **FR-002**: System MUST NOT allow DKI codes in the Final URL field, rejecting them with an actionable error.
- **FR-003**: System MUST recognize all five capitalization modes — `keyword` (lower), `Keyword` (sentence), `KeyWord` (title), `KEYWord` and `KeyWORD` (mixed) — and reject any other casing of the literal token.
- **FR-004**: A pure display-render helper MUST reproduce each casing mode correctly, and the mixed modes (`KEYWord`, `KeyWORD`) MUST preserve known all-caps tokens (e.g. `USA`) from a small maintained token list. This rendered form is for optional human preview only; it is never persisted or emitted (character-count enforcement is casing-independent).
- **FR-005**: System MUST require a non-empty default text in every DKI code and reject codes lacking one.
- **FR-006**: System MUST enforce field character limits after insertion using the default text as the worst case: headline ≤ 30, description line ≤ 90, Display-path segment ≤ 15 characters. Worst-case length is computed by replacing every DKI code in the field with its (verbatim, untrimmed) default text and measuring the resulting string — so literal text around one or more codes is included in the count.
- **FR-007**: System MUST reject special / non-ASCII characters (e.g. `é`) in the Display path and in any Display-path DKI default text.
- **FR-008**: DKI-bearing fields MUST round-trip: a valid `{keyword:default text}` code that is parsed MUST be emitted to the ad builder byte-for-byte unchanged, including any whitespace inside the default text (defaults are preserved verbatim, never trimmed).
- **FR-009**: System MUST reject malformed DKI codes (unclosed braces, nested braces, empty default, missing colon) with a clear, field-named error rather than silently accepting or mis-parsing them.
- **FR-010**: System MUST surface a non-blocking "too many characters" lint warning when an inserted keyword (or the default) is at risk of exceeding the field limit.
- **FR-011**: System MUST surface a non-blocking lint warning that DKI is unavailable for Dynamic Search Ads (no keyword targeting) and that the default text would be inserted instead.
- **FR-012**: System MUST surface non-blocking lint warnings for restricted content (Healthcare, Sexual Content) and trademark-restricted tokens where DKI insertion may be blocked by Google policy.
- **FR-013**: System MUST surface best-effort non-blocking lint warnings for likely-ungrammatical insertion, misspellings (noting Google auto-corrects or falls back to default), and landing pages that may not support dynamic text.
- **FR-014**: Validation (FR-001–FR-009) MUST occur once at the parse boundary; downstream code receiving a parsed ad MUST NOT re-validate DKI. Lint warnings (FR-010–FR-013) MUST be produced by a separate pure lint function returning structured advisory findings (category + message); they are non-blocking and distinct from the blocking parse.
- **FR-015**: Non-DKI (plain) headline, description, and Display-path fields MUST continue to parse and emit exactly as before this feature.

### Key Entities *(include if feature involves data)*

- **DKI code**: a parsed representation of `{keyword:default text}` — its casing mode (one of five), its default text, and the literal source string preserved for round-trip emission.
- **DKI-bearing field**: a headline, description line, or Display-path segment that may contain zero or more DKI codes interleaved with literal text, carrying a computed worst-case length.
- **Lint warning**: an advisory, non-blocking finding (category + human-readable message) attached to a DKI-bearing field, distinct from a blocking parse error.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of valid DKI codes round-trip unchanged through parse and emit (byte-for-byte).
- **SC-002**: Every DKI code missing a default, exceeding the worst-case field limit, using DKI in the Final URL, or containing a special character in a Display path is rejected at parse time with an error naming the field and the reason — 0% reach the ad builder.
- **SC-003**: All five capitalization modes are recognized and correctly capitalized (including all-caps token preservation) in 100% of table-driven test cases derived from the issue's capitalization table.
- **SC-004**: Each documented risky-but-legal DKI pattern (near-limit, DSA, restricted vertical, trademark, grammar/landing-page) produces its corresponding advisory warning without blocking authoring.

