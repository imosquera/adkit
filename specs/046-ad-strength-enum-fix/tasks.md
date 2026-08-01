---

description: "Task list for Fix false path-to-EXCELLENT recommendations from raw enum comparison"

---

# Tasks: Fix false path-to-EXCELLENT recommendations from raw enum comparison

**Input**: Design documents from `/specs/046-ad-strength-enum-fix/`

**Prerequisites**: plan.md, spec.md

**Tests**: Included — the spec explicitly requires a fixture test using the numeric API form (spec.md Independent Test / FR-003, FR-004).

**Organization**: One user story (US1, P1) plus a small Foundational phase for the shared decode/type work both comparison sites depend on.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1)
- Paths are relative to `skills/adkit/scripts/`

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: Decode `ad_strength` to a closed union at the parse boundary — both comparison-site fixes in US1 depend on this type existing.

**⚠️ CRITICAL**: No US1 task can begin until this phase is complete.

- [x] T001 Add `AdStrengthName` union type (`"UNSPECIFIED" | "UNKNOWN" | "PENDING" | "NO_ADS" | "POOR" | "AVERAGE" | "GOOD" | "EXCELLENT"`) and export it from `src/audit/types.ts`; narrow `ScoredAd.strength` from `string` to `AdStrengthName`
- [x] T002 Add `adStrengthName(value: string | number): AdStrengthName` to `src/ads/enums.ts`, mirroring the existing `matchTypeName` convention (numeric input decodes via `enums.AdStrength[value]`; string input passes through unchanged) (depends on T001)
- [x] T003 In `scoreAd()` (`src/bin/audit.ts`), replace `strength: a.ad_strength` with `strength: adStrengthName(a.ad_strength)` (depends on T002)
- [x] T004 Narrow the `strength` parameter of `pathToExcellent()` in `src/audit/scoring.ts` from `string` to `AdStrengthName` (depends on T001)

**Checkpoint**: `ScoredAd.strength` and `pathToExcellent`'s `strength` param are both `AdStrengthName`, decoded once at the parse boundary — US1 can now fix the comparison sites with a type-checked guarantee that `strength` is a real name, not a raw ordinal.

---

## Phase 2: User Story 1 - Audit output stops lying about EXCELLENT ads (Priority: P1) 🎯 MVP

**Goal**: An ad whose Google Ads API `ad_strength` is EXCELLENT gets no "path to EXCELLENT" lines and no fallback diversity recommendation; non-EXCELLENT ads are unaffected.

**Independent Test**: Run the audit against a fixture where an ad's `ad_strength` is the numeric value `7` (the actual API contract), and confirm the rendered report contains no `pathToExcellent` step lines and no fallback recommendation for that ad.

### Tests for User Story 1

> Write these first; they must FAIL against the current (buggy) code before the implementation tasks below.

- [x] T005 [P] [US1] Add a `scoreAd`/`pathToExcellent` fixture test in `src/audit/scoring.test.ts` asserting that an ad with numeric `ad_strength` `7` (EXCELLENT) produces an empty `pathToExcellent()` result and no fallback recommendation, using `enums.AdStrength.EXCELLENT` (or the literal `7`) as the input rather than the string `"EXCELLENT"`
- [x] T006 [P] [US1] Add/update a render test (in `src/audit/render.test.ts`, or the closest existing render test file) asserting that `renderCreativeSummary` prints no `-> ` step lines for an ad whose decoded `strength` is `"EXCELLENT"`

### Implementation for User Story 1

- [x] T007 [US1] In `src/audit/render.ts`, keep `a.strength !== "EXCELLENT"` (now type-checked against `AdStrengthName`) gating the `pathToExcellent` step lines — confirm the comparison is now correct given decoded input from T003; adjust only if the type checker flags it (depends on T003, T004, T005, T006)
- [x] T008 [US1] In `src/audit/scoring.ts`, keep `strength !== "EXCELLENT"` (now type-checked) gating the fallback diversity recommendation — confirm correctness under the decoded input from T004; adjust only if the type checker flags it (depends on T004, T005, T006)
- [x] T009 [US1] Update any existing test in `src/audit/scoring.test.ts` / `src/bin/audit-psi.test.ts` / `src/lib/psi.test.ts` that hardcodes a string-literal `strength` value to use a value that matches `AdStrengthName` (they already use string names like `"POOR"`, so this is a type-correctness pass, not a behavior change) (depends on T001)

**Checkpoint**: User Story 1 is fully functional and independently testable — running the audit against the new fixtures shows correct EXCELLENT-vs-non-EXCELLENT behavior.

---

## Phase 3: Polish & Cross-Cutting Concerns

- [x] T010 Run the full `skills/adkit/scripts` test suite and typecheck (`npm test`, `npm run typecheck` or equivalent per `package.json`) and fix any fallout from the `AdStrengthName` narrowing
- [x] T011 Re-read `src/bin/audit.ts` and `src/audit/render.ts` for any other bare-`string` comparison against `a.strength` or `ad_strength` that this fix missed (per issue #51's note that #52 has the same defect in the PSI path — out of scope here, do not touch PSI files)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — start immediately. BLOCKS Phase 2's implementation tasks (T007–T009), though the test tasks (T005, T006) can be written in parallel with Phase 1 since they should fail against current code.
- **User Story 1 (Phase 2)**: Tests (T005, T006) can start immediately in parallel with Phase 1. Implementation tasks (T007–T009) depend on Phase 1 completing.
- **Polish (Phase 3)**: Depends on Phase 2 completion.

### Parallel Opportunities

- T001 and T002 are sequential (T002 needs the type from T001 for its return type), but T004 can run in parallel with T002 once T001 lands.
- T005 and T006 are independent files — run in parallel.
- T007 and T008 touch different files — run in parallel once their shared dependencies (T003/T004) land.

---

## Parallel Example: Foundational + Tests

```bash
# Once T001 lands, run in parallel:
Task: "Add adStrengthName() to src/ads/enums.ts"
Task: "Narrow pathToExcellent's strength param in src/audit/scoring.ts"

# In parallel with all of Phase 1:
Task: "Add EXCELLENT fixture test in src/audit/scoring.test.ts"
Task: "Add EXCELLENT render test in src/audit/render.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational (decode + type narrowing)
2. Complete Phase 2: User Story 1 (tests + comparison-site confirmation)
3. **STOP and VALIDATE**: Run the new fixture tests; confirm they pass and that non-EXCELLENT ads are unaffected
4. Complete Phase 3: Polish (full suite + typecheck)

This is a single-story bug fix — there is no incremental multi-story delivery plan beyond MVP.

---

## Notes

- [P] tasks touch different files with no interdependency
- Write T005/T006 first and confirm they fail against the current buggy comparison before landing T001–T004
- This fix intentionally does not touch the PSI path (`skills/adkit/scripts` PSI files) — that is issue #52, out of scope here
