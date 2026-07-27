# Implementation Plan: PSI auto-diagnosis never triggers because Quality Score enum fields arrive as integers, not strings

**Branch**: `044-psi-enum-string-mismatch` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/044-psi-enum-string-mismatch/spec.md`

## Summary

`/adkit audit` maps three Google Ads Quality Score component fields
(`post_click_quality_score`, `creative_quality_score`, `search_predicted_ctr`) straight
from the API response into `QualityScoreEntry.landingPageExp` / `.adRelevance` /
`.expectedCtr`. The Google Ads client returns these three fields as the raw enum
**integer** (e.g. `2` for BELOW_AVERAGE) rather than the resolved string name every
other enum on the same client arrives as. Downstream code — the PSI URL selector
(`belowAverageFinalUrls` in `psi.ts`) and the Quality Score render sections
(`renderQualityScoreSection` in `render.ts`) — compares these fields against the
string `"BELOW_AVERAGE"`, so the comparison is always false and PSI silently never
runs. The fix normalizes the three fields to canonical string buckets at the mapping
point in `audit.ts` (`qualityScore()`), via one small pure helper, and widens the raw
row type to admit the actual `string | number` wire shape. No change to the PSI
trigger/selection logic itself, no schema/CLI-flag changes.

## Technical Context

**Language/Version**: TypeScript (Node.js), compiled with `tsc`, run via `tsx`/Node ESM.

**Primary Dependencies**: `google-ads-api` (Google Ads client), `zod` (existing PSI
response boundary parser), `vitest` (test runner) — no new dependencies.

**Storage**: N/A — no persistence involved; this is an in-memory mapping fix inside a
single audit run.

**Testing**: `vitest` — existing `scripts/src/bin/audit.test.ts` (shell-level
`qualityScore()` coverage) and `scripts/src/bin/audit-psi.test.ts` (`runPsi` /
`renderPsi` coverage), both already in `skills/adkit/scripts/`.

**Target Platform**: Node.js CLI (`ads.sh audit` / `/adkit audit`), same as today.

**Project Type**: CLI tool (single project) — `skills/adkit/scripts/`.

**Performance Goals**: N/A — pure in-memory string mapping over already-fetched rows;
no measurable performance impact.

**Constraints**: Must not change the PSI trigger/selection logic (`belowAverageFinalUrls`
comparison, `runPsi` flow) or the render sections' comparison logic — only the value
reaching them. No live Google Ads/PSI credentials available for verification; unit
tests are the verification method (per issue #40's own instruction).

**Scale/Scope**: Three struct fields on one row-mapping function, plus one new helper
function and its widened input type. No new files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is the unfilled spec-kit template
(placeholder tokens like `[PRINCIPLE_1_NAME]` throughout, no headings matching
`## I. Name` / `### Principle N: Name`; confirmed by running
`constitution_audit.py list`, which reports "No principle headings matched").

No constitution defined.

## Project Structure

### Documentation (this feature)

```text
specs/044-psi-enum-string-mismatch/
├── plan.md              # This file — includes research + data model + parse boundaries inline
├── spec.md              # Feature specification
├── tasks.md             # Phase 2 output (/speckit-tasks command)
└── checklists/
    └── requirements.md  # Spec quality checklist
```

(`research.md`, `data-model.md`, and `contracts/` are intentionally not created —
their content is folded into this file's Research Notes and Data Model sections
below, per this preset's minimal-artifact-tree rule.)

### Source Code (repository root)

```text
skills/adkit/scripts/
├── src/
│   ├── bin/
│   │   ├── audit.ts                 # qualityScore() — mapping point; add the enum→string helper here
│   │   ├── audit.test.ts            # add the integer-enum regression case to the existing qualityScore() suite
│   │   └── audit-psi.test.ts        # existing runPsi/renderPsi coverage — unchanged, still green
│   ├── audit/
│   │   ├── rows.ts                  # QualityScoreRow / RawQualityScoreRow — widen 3 fields to string | number
│   │   ├── types.ts                 # QualityScoreEntry — already string-typed, unchanged
│   │   └── render.ts                # renderQualityScoreSection — unchanged, already compares against strings
│   └── lib/
│       └── psi.ts                   # belowAverageFinalUrls / BELOW_AVERAGE — unchanged, already compares against strings
└── vitest.config.ts                 # existing config, no changes needed
```

**Structure Decision**: Single existing CLI project (`skills/adkit/scripts/`). No new
packages, no new top-level directories — this is a same-file, same-module bug fix.

## Research Notes (Phase 0)

No open unknowns — the root cause and required fix are fully specified by the source
issue and confirmed by reading the current code (see spec.md's Clarifications
section for the auto-answered implementation-adjacent decisions). Findings:

- **Decision**: Add a pure `qualityScoreBucket(value: string | number | null | undefined): string`
  helper in `audit.ts`, used only at the three call sites inside `qualityScore()`.
  **Rationale**: Matches the issue's explicit instruction to fix "at the mapping
  point in audit.ts, via a small pure enum→string helper." Keeps the fix local to the
  one confirmed exception rather than rewriting `rows.ts`'s general "enums arrive
  pre-resolved" boundary convention, which holds for every other enum in this file.
  **Alternatives considered**: Converting inside `normalizeQualityScoreRow` in
  `rows.ts` — rejected because the issue is explicit about the fix location, and
  `rows.ts`'s own module doc (`"Enum fields arrive as their STRING name already"`)
  would need a caveat added for a single field group, muddying a boundary convention
  that is correct for everything else on that client.
- **Decision**: The integer→string table is Google Ads API's own public
  `QualityScoreBucket` enum: `0`=UNSPECIFIED, `1`=UNKNOWN, `2`=BELOW_AVERAGE,
  `3`=AVERAGE, `4`=ABOVE_AVERAGE. **Rationale**: This is a fixed, externally
  documented enum, not a project-specific design choice — using any other mapping
  would silently corrupt values Google Ads sends. **Alternatives considered**: None;
  this table isn't a decision point, it's the enum's own contract.
  **Verification**: Confirmed against the code comment already in
  `skills/adkit/scripts/src/gaql/builders.ts:315` ("component ratings
  (BELOW_AVERAGE/AVERAGE/ABOVE_AVERAGE)") and issue #40's own text (`2` =
  BELOW_AVERAGE).
- **Decision**: An out-of-range/unrecognized integer maps to `"UNKNOWN"` rather than
  throwing. **Rationale**: Non-fatal degrade is the established pattern throughout
  `rows.ts`'s other normalizers (e.g. `ad_group_criterion.quality_info` entirely
  absent → empty-string defaults, never a throw); a future/undocumented enum value
  should not crash an otherwise-successful audit run.
- **Decision**: A field already arriving as a string, or a missing/absent field
  (normalizes to `""` today), is unaffected — the helper passes strings through
  unchanged and only converts genuine `number` inputs. **Rationale**: FR-003/FR-004 —
  no regression on the already-working string path or the existing missing-field
  degrade path.

No `NEEDS CLARIFICATION` markers remain in Technical Context above.

## Data Model (Phase 1)

No new entities. One existing type is widened at its true wire boundary:

- **`QualityScoreRow.ad_group_criterion.quality_info`** (`scripts/src/audit/rows.ts`) —
  `post_click_quality_score`, `creative_quality_score`, `search_predicted_ctr` widen
  from `string` to `string | number`, reflecting the value shape the Google Ads API
  client actually sends (the type previously asserted `string` but was never enforced
  at a parse boundary — this bug is proof the assertion was unsound).
  `RawQualityScoreRow`'s `Partial<...>` of the same shape widens along with it.
- **`QualityScoreEntry`** (`scripts/src/audit/types.ts`) — unchanged. Remains
  `landingPageExp: string; adRelevance: string; expectedCtr: string;` — this is the
  trusted, narrowed output the new helper produces; it was already correctly typed,
  the bug was a runtime value never matching what the type promised.

No API contracts change — `qualityScore()`'s exported signature
(`Promise<Record<number, QualityScoreEntry[]>>`) is unchanged; only the values inside
it are corrected. No `contracts/` artifact applies (internal CLI function, not an
external interface).

## Parse Boundaries

This is a TypeScript feature, so this section is substantive (not N/A).

1. **Trust boundary**: The Google Ads API response for the Quality Score query
   (`auditQualityScoreQuery`), reaching `qualityScore()` in `audit.ts` via
   `search<RawQualityScoreRow>(client, customerId, ...)`. The three enum sub-fields
   (`post_click_quality_score`, `creative_quality_score`, `search_predicted_ctr`) are
   the untrusted input this feature concerns itself with — the client library's
   generic `search<T>()` performs no runtime validation, so the wire value is only as
   trustworthy as the declared `Raw*Row` type, which this fix corrects to
   `string | number` (previously an unenforced, incorrect `string`-only claim).
2. **Domain type**: `QualityScoreEntry.landingPageExp` / `.adRelevance` /
   `.expectedCtr` (`scripts/src/audit/types.ts`) — already the precise, trusted
   `string` type the rest of the audit (the PSI selector, the QS render sections)
   is entitled to assume is one of the canonical bucket names. No new brand is
   introduced: these are already plain, narrow `string` fields and every downstream
   consumer needs exactly that, not a richer nominal type — introducing a branded
   `QualityScoreBucket` type here would be unwarranted ceremony for a three-field,
   single-module fix (YAGNI).
3. **Parser**: The new `qualityScoreBucket(value: string | number | null | undefined): string`
   pure function, colocated in `scripts/src/bin/audit.ts` next to `qualityScore()`
   (the sole call site). It is not a discriminated `Result`-returning parser because
   it cannot fail — every input (string, number, null, undefined) maps to a defined
   string output (pass-through, table lookup, `"UNKNOWN"` fallback, or `""` for
   absent) — so a `{ kind: "ok" | "err" }` wrapper would add no information. This
   mirrors the existing non-`Result` style of this file's other pure mappers (e.g.
   `Math.trunc(score)` inline in the same function).
4. **Library choice**: Hand-rolled — a five-entry lookup table plus a `typeof` check
   is the entire boundary. Pulling in `zod` (already a project dependency, used in
   `psi.ts` for the PSI HTTP response) would be strictly more machinery than a
   five-value closed enum needs; `zod` is reserved in this codebase for boundaries
   with real structural uncertainty (arbitrary third-party JSON), not a single
   `number → string` table lookup.

## Complexity Tracking

*No Constitution Check violations — table intentionally omitted.*
