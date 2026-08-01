# Implementation Plan: Fix false path-to-EXCELLENT recommendations from raw enum comparison

**Branch**: `046-ad-strength-enum-fix` | **Date**: 2026-07-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/046-ad-strength-enum-fix/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

`ScoredAd.strength` (the issue calls it `AdReport.strength`; the actual interface
in `skills/adkit/scripts/src/audit/types.ts` is `ScoredAd`) carries the raw
Google Ads `ad_strength` enum ordinal (`7` for EXCELLENT) copied straight off the
API row, but two call sites compare it against the string literal `"EXCELLENT"`.
Both comparisons are therefore always true, so every ad — including ones already
EXCELLENT — gets a bogus "path to EXCELLENT" recommendation. The fix decodes the
enum to its name at the single point the row is parsed (`scoreAd` in
`skills/adkit/scripts/src/bin/audit.ts`), following the existing
`matchTypeName` decode convention in `skills/adkit/scripts/src/ads/enums.ts`, and
narrows `ScoredAd.strength` (plus the `pathToExcellent` `strength` parameter)
from bare `string` to the closed union of valid Google Ads strength names so the
comparison sites can't silently drift from the runtime contract again.

## Technical Context

**Language/Version**: TypeScript (Node, ESM), per `skills/adkit/scripts/package.json`

**Primary Dependencies**: `google-ads-api` (already a dependency; supplies the
bidirectional `enums.AdStrength` map used by the existing `matchTypeName`
convention in `src/ads/enums.ts`)

**Storage**: N/A — no persistence involved, pure in-memory transform

**Testing**: `vitest`, per existing `*.test.ts` files in `skills/adkit/scripts/src`

**Target Platform**: CLI (`/adkit audit`), Node.js

**Project Type**: CLI tool (single project, `skills/adkit/scripts`)

**Performance Goals**: N/A — no measurable performance change; decode is a single
object-key lookup per ad, already on the hot path today (just wrong)

**Constraints**: Must not change behavior for genuinely non-EXCELLENT ads (see
spec SC-002); must not introduce a runtime crash on an out-of-range/unrecognized
enum value (see spec Edge Cases)

**Scale/Scope**: Two comparison sites (`render.ts:51`, `scoring.ts:126`), one
parse site (`audit.ts:284`), one type definition (`types.ts:13`), one new decode
helper alongside the existing `matchTypeName` — no new files, no new modules

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled
`speckit init` template — every principle heading is a literal placeholder
token (`### [PRINCIPLE_1_NAME]`, etc.), not a real principle. Confirmed via
`python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py list`,
which reports zero matched principle headings. Per the plan skill's own rule
("When `.specify/memory/constitution.md` does not exist, the Constitution
Check section may state 'No constitution defined'"), this is treated
equivalently — there is no constitution content to quote or gate against.

**No constitution defined** — `.specify/memory/constitution.md` contains only
unfilled placeholder headings, so there are no real principles to check
against. The repo's actual binding conventions live in
`/Users/iam/Code/adkit/CLAUDE.md` (functional style, parse-don't-validate) and
are honored via the `## Parse Boundaries` section below: the enum decode moves
to the parse boundary and the resulting type becomes a closed union so
downstream code can't re-interpret it.

## Project Structure

### Documentation (this feature)

```text
specs/046-ad-strength-enum-fix/
├── spec.md               # Feature specification
├── plan.md               # This file (/speckit-plan command output)
├── tasks.md              # Phase 2 output (/speckit-tasks command)
└── checklists/
    └── requirements.md   # Spec quality checklist
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── ads/
│   └── enums.ts          # Add adStrengthName() alongside existing matchTypeName()
├── audit/
│   ├── types.ts          # Narrow ScoredAd.strength: string -> AdStrengthName union
│   ├── scoring.ts        # pathToExcellent(): narrow strength param, fix EXCELLENT compare
│   ├── scoring.test.ts   # Add fixture test using numeric ad_strength form
│   ├── render.ts         # Fix a.strength !== "EXCELLENT" compare (now type-safe)
│   └── render.test.ts    # (if present) add coverage for EXCELLENT ad rendering
└── bin/
    └── audit.ts           # scoreAd(): decode a.ad_strength via adStrengthName() at parse time
```

**Structure Decision**: Single existing project (`skills/adkit/scripts`), no new
files or directories. The fix is a small, localized change to five existing
modules: one new decode helper co-located with the existing enum-decode
convention (`ads/enums.ts`), one type narrowing (`audit/types.ts`), one parse-site
fix (`bin/audit.ts`), and two comparison-site fixes that fall out for free once
the type is correct (`audit/render.ts`, `audit/scoring.ts`).

## Complexity Tracking

*No violations — this fix removes an incorrect runtime assumption (bare
`string` masking an enum-vs-literal type mismatch) without introducing any new
abstraction, module, or dependency. Complexity Tracking is not applicable.*

## Parse Boundaries

1. **Trust boundary**: the Google Ads `ad_group_ad.ad_strength` field on a GAQL
   response row, as read at `a.ad_strength` in `scoreAd()`
   (`skills/adkit/scripts/src/bin/audit.ts`). Per the existing
   `matchTypeName` precedent in `src/ads/enums.ts`, the SDK returns this as the
   **raw numeric enum ordinal**, not the pre-decoded string name — it is kept as
   `string | number` (the same signature `matchTypeName` already uses), never
   read directly into a field typed `string`, until it passes through the new
   decode function below.

2. **Domain type**: `AdStrengthName`, a closed string-literal union —
   `"UNSPECIFIED" | "UNKNOWN" | "PENDING" | "NO_ADS" | "POOR" | "AVERAGE" | "GOOD" | "EXCELLENT"`
   — exported from `skills/adkit/scripts/src/audit/types.ts`, replacing the bare
   `string` on `ScoredAd.strength`. No branding/nominal-typing is needed here
   (unlike `UserId`/`OrderId`-style confusable primitives): a string-literal
   union is sufficient because the only failure mode being closed is "compared
   against a value outside the known set," which a union catches at compile
   time when `noUncheckedIndexedAccess`/exhaustiveness checks or a literal
   comparison (`!== "EXCELLENT"`) are involved. The `pathToExcellent()` function
   signature in `audit/scoring.ts` narrows its `strength: string` parameter to
   the same `AdStrengthName`.

3. **Parser**: `adStrengthName(value: string | number): AdStrengthName`, added
   to `skills/adkit/scripts/src/ads/enums.ts` next to the existing
   `matchTypeName`, following the identical shape: `enums.AdStrength[value]`
   when `value` is numeric (Google Ads API's real runtime contract), passed
   through unchanged when already a string name (defensive, since
   `enums.AdStrength` is a bidirectional map and some sibling fields on other
   row types arrive pre-decoded). Called once, at `scoreAd()`'s construction of
   the `ScoredAd` return value (`strength: adStrengthName(a.ad_strength)`) —
   the single point the raw row becomes a `ScoredAd`. Everywhere downstream
   (`render.ts`, `scoring.ts`) receives the already-decoded `AdStrengthName` and
   performs no re-parsing or re-validation, only the literal comparison the
   union now makes safe.

4. **Library choice**: no schema library — a hand-rolled decode function,
   matching the existing `matchTypeName` convention already used for
   `KeywordMatchType` in this codebase. The `google-ads-api` package's own
   `enums.AdStrength` bidirectional map is the source of truth for the
   ordinal-to-name mapping; no new dependency is introduced.
