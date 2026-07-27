# Implementation Plan: Fix GAQL SELECT/WHERE field mismatch in report queries

**Branch**: `045-report-gaql-select-clause-fix` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/045-report-gaql-select-clause-fix/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

`campaignDailyQuery` in `src/gaql/builders.ts` (via the shared `reportQuery()`
factory) filters `WHERE campaign.status = 'ENABLED'` but its SELECT field list
omits `campaign.status`, so the Google Ads API rejects the query with "The
following field must be present in SELECT clause: 'campaign.status'." The fix
makes `reportQuery()` itself guarantee that every field a report query filters
or orders on is present in its own SELECT list, so no individual query builder
(existing or future) can drift out of sync with its own WHERE/ORDER BY clause.

## Technical Context

**Language/Version**: TypeScript 5.7 (Node >=24)

**Primary Dependencies**: `google-ads-api` SDK, `zod`, `yaml`

**Storage**: N/A — reads only, no persistence in this feature

**Testing**: vitest (`skills/adkit/scripts/src/gaql/builders.test.ts`)

**Target Platform**: Node CLI (`adkit-report` bin)

**Project Type**: CLI (single project, `skills/adkit/scripts/`)

**Performance Goals**: N/A — no measurable perf change, same query shape plus one extra SELECT column

**Constraints**: Must not change the output shape/fields of any report query whose SELECT clause is already correct (FR-004)

**Scale/Scope**: One shared query-builder function (`reportQuery` in `src/gaql/builders.ts`) plus its 7 call sites (`campaignTotalsQuery`, `campaignDailyQuery`, `adGroupQuery`, `adQuery`, `keywordQuery`, `searchTermQuery`, `geoQuery`, `geoRegionQuery`)

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
against. The repo's actual binding conventions live in `/Users/iam/Code/adkit/CLAUDE.md`
(functional style, parse-don't-validate) and are honored via the
`## Parse Boundaries` section below and the functional design in Phase 1.

## Project Structure

### Documentation (this feature)

Under the `spec-minimal` preset, the feature directory contains only:

```text
specs/045-report-gaql-select-clause-fix/
├── spec.md
├── plan.md               # this file — includes the Research and Data Model
│                          #   content that would otherwise live in
│                          #   research.md / data-model.md
├── tasks.md               # Phase 2 output (/speckit-tasks — not this command)
└── checklists/
    └── requirements.md
```

`research.md`, `data-model.md`, and `contracts/` are not created — this
feature has no research unknowns and no external interface contract (it's an
internal query-construction bug fix), so those sections are folded below as
"N/A" rather than omitted silently.

### Source Code (repository root)

```text
skills/adkit/scripts/
├── src/
│   ├── gaql/
│   │   ├── builders.ts        # reportQuery() factory — the fix lands here
│   │   ├── builders.test.ts   # existing suite; new assertions land here
│   │   └── search-args.ts     # SearchArgs type + toGaql() serializer (unchanged)
│   └── bin/
│       └── report.ts          # IO shell that calls the builders (unchanged)
└── (no new files)
```

**Structure Decision**: Single project, no new files. The fix is entirely
inside the existing `reportQuery()` factory in `src/gaql/builders.ts` plus new
test cases in the existing `builders.test.ts` — this is a targeted correctness
fix to a shared helper, not a new module.

### Phase 0: Research

No open unknowns. The Technical Context above is fully determined by reading
the existing codebase (`src/gaql/builders.ts`, `src/gaql/search-args.ts`,
`src/bin/report.ts`) — there was nothing to research: the failing field
(`campaign.status`), the query that omits it (`campaignDailyQuery`), and the
shared factory it goes through (`reportQuery`) are all directly observable in
the source. `research.md` is intentionally not created (spec-minimal preset).

### Phase 1: Design

**Root cause** (`src/gaql/builders.ts:57-80`): every report query is built by
`reportQuery(resource, dims, start, end, orderings?)`, whose `fields` is
`[...dims, ..._METRICS]` and whose `conditions` is always
`_whereConds(start, end)` = `[_ENABLED, dateRangeCondition]`, where
`_ENABLED = "campaign.status = 'ENABLED'"`. Every report query therefore
filters on `campaign.status` in WHERE, but only `campaignTotalsQuery` happens
to also list `campaign.status` in its `dims`. `campaignDailyQuery`'s dims
(`campaign.id`, `campaign.name`, `segments.date`) don't include it, so its
SELECT clause is missing a field its own WHERE clause requires — the exact
class of bug FR-002/FR-003 target.

**Fix** (in `reportQuery()`, not in any individual query function): compute
`fields` as the union of `dims`, the two fixed fields `_whereConds` always
filters on (`campaign.status`, `segments.date`), and any `orderings` fields —
deduplicated, preserving `dims` order, with `_METRICS` appended last.
Concretely:

```ts
const _STATUS_FIELD = "campaign.status"; // mirrors _ENABLED's field, named once
const _DATE_FIELD = "segments.date"; // mirrors _whereConds' date-range field

function reportQuery(resource, dims, start, end, orderings?): SearchArgs {
  const required = new Set([...dims, _STATUS_FIELD, _DATE_FIELD, ...(orderings ?? [])]);
  return {
    resource,
    fields: [...required, ..._METRICS],
    conditions: _whereConds(start, end),
    ...(orderings ? { orderings } : {}),
  };
}
```

This guarantees FR-002 (SELECT ⊇ WHERE/ORDER-BY fields) for every current and
future call through `reportQuery` — a caller cannot forget to add
`campaign.status` or `segments.date` because the factory adds both, satisfying
FR-003 (enforced at the shared layer, not per-callsite).

**Revision**: an earlier version of this plan deliberately excluded
`segments.date` from the guarantee, reasoning that "the live error only ever
cited `campaign.status`, and `campaignTotalsQuery` already omits
`segments.date` from SELECT and runs successfully today." That reasoning was
never actually verified against a live account (no credentials were available
in the implementing environment) — it was an inference from a single error
report, not a confirmed fact, and a PR reviewer correctly flagged it as
unverified speculation: `_whereConds` always adds a `segments.date BETWEEN …`
condition, so by the same FR-002 rule applied to `campaign.status`,
`segments.date` belongs in SELECT for every report query too. The fix now
includes both fields unconditionally. This changes the SELECT clause (and
therefore the exact GAQL string) for all 8 report queries, not 7 — `campaign.status`
was already correct in `campaignTotalsQuery` alone, but `segments.date` was
missing from every report query except `campaignDailyQuery` (which already
lists it as a dimension). FR-004 ("no behavior change for already-correct
queries") is unaffected in spirit: no report query had both fields correctly
selected before this fix, so there was no "already-correct" case being
disturbed — only `campaignDailyQuery`'s SELECT clause is unchanged by this
revision, since it already selected `segments.date`.

**Data model**: no entities — this is a stateless query-string construction
fix. `SearchArgs` (`src/gaql/search-args.ts`) is the only relevant type and is
unchanged: `{ resource, fields, conditions, orderings?, limit? }`. No
`data-model.md` is created (spec-minimal preset; nothing to document beyond
the existing `SearchArgs` shape above).

**Contracts**: none — `reportQuery` is an internal helper, not an external
interface (no CLI flag, HTTP endpoint, or public API surface changes). No
`contracts/` directory is created.

**Test plan** (lands in `builders.test.ts`, not a new file): add a case that
asserts `campaignDailyQuery(...).fields` includes `"campaign.status"`, plus a
generic regression assertion that iterates every `reportQuery`-derived export
(`campaignTotalsQuery`, `campaignDailyQuery`, `adGroupQuery`, `adQuery`,
`keywordQuery`, `searchTermQuery`, `geoQuery`, `geoRegionQuery`) and checks
`fields` is a superset of `{"campaign.status", ...(orderings ?? [])}` — this
is SC-002 made concrete and automated, so a future report query cannot
reintroduce this class of bug undetected.

## Parse Boundaries

This is a TypeScript feature (`skills/adkit/scripts`, `.ts`).

1. **Trust boundaries**: none newly introduced by this fix. The only
   pre-existing trust boundary this code sits behind is the Google Ads API's
   JSON response, deserialized into `GaqlRow` (`src/lib/auth.ts`) — untouched
   by this change. `reportQuery()`'s inputs (`resource: string`, `dims:
   readonly string[]`, `start`/`end: string`, `orderings?: readonly
   string[]`) are all internal, developer-supplied literals from other
   builder functions in the same file — not untrusted external input, so
   there is no new boundary to parse at.
2. **Domain types**: `SearchArgs` (`src/gaql/search-args.ts`) remains the one
   domain type in this path — a plain readonly interface, not branded
   (its fields are structural GAQL fragments, not identifiers that could be
   confused with another domain concept). No new type is introduced; the fix
   changes how `SearchArgs.fields` is *computed* inside `reportQuery`, not its
   shape.
3. **Parsers**: N/A — there is no untrusted-input-to-domain-type parse step in
   this fix. `toGaql()` (`src/gaql/search-args.ts`) remains a pure
   `SearchArgs -> string` serializer, unchanged.
4. **Library choice**: N/A — no schema library needed; `reportQuery`'s new
   field-union logic is plain `Set` deduplication over already-typed
   `readonly string[]` values, consistent with the project's existing
   functional style (no classes, no mutation — `Set` is built once from
   spread inputs and never mutated after construction).

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No constitution violations — no constitution is defined (see Constitution
Check above) and the fix introduces no new complexity (no new files, no new
abstractions, a single small change to one existing factory function).
