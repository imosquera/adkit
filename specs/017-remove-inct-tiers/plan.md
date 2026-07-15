# Implementation Plan: Remove hardcoded I/N/C/T tiers, use only LLM-generated Keyword Themes

**Branch**: `017-remove-inct-tiers` | **Date**: 2026-07-15 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/017-remove-inct-tiers/spec.md`

## Summary

`skills/adkit/reference/gtm.md` currently authors two theme structures per run: the
LLM-generated `### Keyword Themes` (3-6 free-form semantic clusters — already the
ad-group source of truth for `/adkit create`) and a hardcoded four-tier
Informational/Navigational/Commercial/Transactional (I/N/C/T) classification inside
`### Keywords`, which today also resolves each theme's `> Offer:` line via a fixed
precedence order (Transactional > Commercial > Navigational > Informational). This
plan removes the I/N/C/T taxonomy (definitions, subsection mandate, precedence-order
offer resolution) from `gtm.md` and every other reference doc and code path that
depends on it, so the Keyword Themes' own member keywords resolve the offer directly,
with no separate tier system layered on top. The `TIER_NAMES` heuristic in the audit
skill's `scoring.ts` — the only *code* dependency on the taxonomy — is deleted along
with the fixture/test literals that reference it.

This is a documentation- and fixture-driven cleanup: no new runtime data flows, no new
persisted entities, no new external interface. The affected code (`scoring.ts`) is a
pure function library with no I/O of its own.

## Technical Context

**Language/Version**: TypeScript (Node, per `skills/adkit/scripts/package.json`); Markdown reference docs

**Primary Dependencies**: None new. Existing: the scripts package's configured test runner for `skills/adkit/scripts/src/**/*.test.ts`

**Storage**: N/A — reference docs are static markdown; `scoring.ts` is pure in-memory logic, no persistence

**Testing**: Existing `skills/adkit/scripts` test suite (`audit.test.ts`, `scoring.test.ts`, `create.test.ts`, `ideas/parse.test.ts`)

**Target Platform**: N/A — CLI/reference-doc tooling, no deployment target change

**Project Type**: Single project — `skills/adkit/` (reference docs) + `skills/adkit/scripts/` (TypeScript CLI/audit library)

**Performance Goals**: N/A — no performance-sensitive path touched

**Constraints**: Every doc/code edit must preserve the LLM-generated Keyword Themes as the sole theme source; no behavior change to anything unrelated to I/N/C/T (e.g. `pathToExcellent`, `differentiationGaps`, `cannibalization` in `scoring.ts` are untouched)

**Scale/Scope**: 5 reference docs + 1 source file + 4 test files, per the issue's explicit file list

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this worktree contains only unfilled template
placeholders (`[PRINCIPLE_1_NAME]`, `[PRINCIPLE_1_DESCRIPTION]`, etc.) — running
`constitution_audit.py list` against it returns "No principle headings matched."
There is no ratified project constitution to gate against for this feature.

**Verdict**: N/A — no ratified constitution exists in `.specify/memory/constitution.md` to check gates against.

This repository does carry binding engineering conventions in the project root
`CLAUDE.md` (functional style; parse-don't-validate). Those live outside
`.specify/memory/constitution.md` so they are not subject to this gate's quote/verdict
mechanics, but they are honored throughout this plan and in the Parse Boundaries
section below — `scoring.ts` changes stay pure-function, immutable-data edits
(removing a `Set` constant and a branch, no loops-with-accumulators, no classes) and
no new trust boundary is introduced.

## Project Structure

### Documentation (this feature)

```text
specs/017-remove-inct-tiers/
├── plan.md              # This file (/speckit-plan command output)
├── spec.md              # Feature specification (/speckit-specify command output)
├── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
└── checklists/
    └── requirements.md  # Spec quality checklist
```

(`research.md`, `data-model.md`, `contracts/` are intentionally not created — this
preset enforces a minimal artifact tree; there is no new data model or external
contract for this feature, so their content would have been empty regardless.)

### Source Code (repository root)

```text
skills/adkit/
├── reference/
│   ├── gtm.md                          # drop I/N/C/T subsection mandate, tier
│   │                                    # definitions, precedence-order offer
│   │                                    # resolution; Offer derives from Keyword
│   │                                    # Themes' member keywords directly
│   ├── create.md                       # drop I/N/C/T precedence reference (RSA
│   │                                    # temperature already reads the theme's
│   │                                    # own `> Offer:` line — no tier lookup)
│   └── google/
│       ├── 2-keyword-mining.md         # replace T/C/I/N bucket table + paid-vs-SEO
│       │                                # routing with theme-relevance framing
│       ├── 5-negative-keywords.md      # reframe "Non-Commercial"/"Informational"
│       │                                # fixed category around theme relevance
│       └── 3-account-structure.md      # drop the Transactional/commercial mention
└── scripts/src/
    ├── audit/
    │   ├── scoring.ts                  # remove TIER_NAMES + the tier-label branch
    │   │                                # in conceptWords()
    │   └── scoring.test.ts             # update fixtures using tier-name literals
    ├── bin/
    │   ├── audit.test.ts               # update ad-group/heading fixtures
    │   └── create.test.ts              # update `#### Informational`/`#### Commercial`
    │                                    # heading fixtures
    └── ideas/
        └── parse.test.ts               # update heading fixtures
```

**Structure Decision**: Single project, editing files in place at the paths the issue
names. No new files, directories, or modules are introduced — this is a subtractive
change (remove a taxonomy) plus fixture updates to keep tests describing the new
theme-only structure.

## Design Decisions

### D1 — Offer resolution without I/N/C/T precedence

Today `gtm.md` step 15c resolves a theme's `> Offer:` by taking the
"highest-actionable represented intent tier (Transactional > Commercial > Navigational
> Informational) among its member keywords" and using that tier's fixed Default offer.
With I/N/C/T removed, `### Keywords` no longer carries per-keyword intent-tier
annotations at all, so there is nothing left to take a precedence order *over*. The
theme's `> Offer:` becomes an LLM judgment call made directly from the theme's member
keywords and the theme's own buying-cycle read (still informed by the same signals —
`free`/DIY modifiers, comparison language, ready-to-act phrasing — just applied once,
per theme, instead of once per keyword then re-aggregated through a tier lookup).
`gtm.md`'s `### Keywords` section keeps its keyword list + volume/competition/CPC
decoration and the Dropped/Negative Keywords subsections; it drops only the four
`####` intent-tier subsections and their Default-offer blockquotes.

### D2 — `2-keyword-mining.md` bucket table

The existing table hard-codes "Transactional primary / Commercial primary /
Informational→SEO / Navigational→brand campaign" routing. Per the issue, replace it
with guidance that routes on the keyword's Keyword Theme membership and relevance
instead: a keyword's paid-worthiness is judged by whether it's on-theme for a live ad
group (per `gtm.md`'s on-theme/off-theme tag) rather than by a fixed I/N/C/T label.

### D3 — `5-negative-keywords.md` "Non-Commercial" category

Category 2 of the three-list structure ("Non-Commercial — informational, job seeker,
student intent") is reframed as a "low theme-relevance" negative bucket: the same
literal negative-keyword lists stay (course, tutorial, jobs, salary, etc. are still
useful negatives), but the justification for adding them changes from "this term is
categorically Informational" to "this term does not match any live Keyword Theme's
buyer intent."

### D4 — `scoring.ts` `conceptWords()` after `TIER_NAMES` removal

Today, when an ad group has zero fetched keywords, `conceptWords()` falls back to the
ad group's own *name* — unless that name is a generic tier label (`informational` /
`navigational` / `commercial` / `transactional`), in which case it returns no concept
words at all (empty string), because a bare tier name isn't a useful headline-matching
signal. Once ad groups are named after LLM-generated Keyword Themes (e.g. `Salon
Software`, `Barber / Stylist`), an ad-group name is never one of those four generic
labels, so the special case is dead code once the taxonomy is gone elsewhere. Removing
`TIER_NAMES` and the branch makes `conceptWords()` always use the ad-group name as a
fallback when there are no keywords — consistent with a Keyword-Theme-named ad group
actually being a meaningful signal (unlike a bare "Commercial").

## Parse Boundaries

This feature is implemented in TypeScript (`skills/adkit/scripts/src/audit/scoring.ts`
and its test files) plus Markdown reference-doc edits with no executable surface.

1. **Trust boundaries**: This change introduces none. `conceptWords(agName,
   keywords)` and its test fixtures already receive `agName: string` and `keywords:
   readonly string[]` as plain in-memory arguments from the caller (`bin/audit.ts`,
   which itself parses GAQL rows upstream of this module — unchanged by this feature).
   No new HTTP handler, DB row, env var, CLI flag, `JSON.parse`, or SDK response is
   read by this change. `TIER_NAMES` was an internal `ReadonlySet<string>` constant,
   not a parser of external input — removing it removes a piece of internal decision
   logic, not a boundary.
2. **Domain types**: None introduced. `agName` stays a plain `string` (ad-group name,
   already trusted by the time it reaches `conceptWords()` — sourced from
   `ad_group.name` in an already-typed GAQL row upstream); no new branded type is
   needed because this feature does not add a new kind of identifier or value that
   could be confused with another.
3. **Parsers**: None added, none removed. The `conceptWords` function itself is not a
   parser (it does not turn raw/untrusted input into a domain type); it's pure string
   transformation over already-trusted `string`/`string[]` values, and stays that way.
4. **Library choice**: N/A — no schema library is warranted; there is no new trust
   boundary for one to guard.

## Complexity Tracking

*No entries — Constitution Check is N/A (no ratified constitution) and no complexity
deviation is introduced by this change.*
