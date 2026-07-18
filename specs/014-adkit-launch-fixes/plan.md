# Implementation Plan: `update` rewrites can set the RSA display path (path1/path2)

**Branch**: `014-adkit-launch-fixes` | **Date**: 2026-07-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/014-adkit-launch-fixes/spec.md`

## Summary

Give `update`'s `rewrites` op parity with `create`: allow a rewrite entry to carry optional `path1`/`path2` display-path segments, validated once at the plan boundary with the same rules `create` uses, and set on the `responsive_search_ad` update resource only when present (so copy-only rewrites are unchanged). This closes item 5(a) of issue #14 — the only piece of that issue not already fixed by PR #10.

## Technical Context

**Language/Version**: TypeScript 5.7, Node ≥24, run via `tsx`

**Primary Dependencies**: `zod` (validation), `google-ads-api` (SDK); no new dependencies

**Storage**: N/A (mutations go to the Google Ads API at the existing IO edge)

**Testing**: `vitest` (`npm run test` in `skills/adkit/scripts`)

**Target Platform**: CLI (`ads.sh update`), macOS/Linux

**Project Type**: Single project (CLI + lib)

**Performance Goals**: N/A — a single-op path change; no hot path

**Constraints**: Pure parse/build functions; IO isolated to the existing mutate edge in `apply-fixes.ts`

**Scale/Scope**: One op-builder (`rsaUpdateOp`), one rewrites-boundary parse, reuse of the existing `displayPath` schema, plus tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution at `.specify/memory/constitution.md` is an unpopulated template (no ratified principle headings — `constitution_audit.py list` returns none), so there are no formal constitution principles to check against: **N/A** — no constitution defined. The binding engineering rules live in `CLAUDE.md` (functional style; parse, don't validate) and are honored here: the change stays pure (parse + build), isolates IO to the existing edge, and pushes path validation to a single boundary rather than scattering re-checks. See `## Parse Boundaries` below for the parse-don't-validate design.

## Parse Boundaries

This feature has a TypeScript surface, so the parse-don't-validate discipline is designed in here.

1. **Trust boundaries** — the untrusted input is the fixes-plan JSON read by `bin/apply-fixes.ts` (authored by the operator / upstream tooling, arriving via `JSON.parse` as `unknown`). Specifically, each element of the `rewrites` array may now carry `path1`/`path2` alongside `adId`/`headlines`/`descriptions`. The raw blob is kept as `Record<string, unknown>` (never `any`) until parsed.

2. **Domain types** — a rewrite's display path is modeled as an optional `DisplayPath` value: a `string` that has passed the `displayPath` rules (≤15 chars, lowercased, no whitespace/`/`, no `TODO` placeholder). The pair is modeled as `{ path1?: DisplayPath; path2?: DisplayPath }` with the invariant `path2 ⇒ path1`. Carrying the parsed pair as a value means the op-builder never re-checks it.

3. **Parsers** — a single parser (reusing the existing `displayPath` zod schema and the `path2-requires-path1` refinement from `src/lib/schema.ts`) maps the raw rewrite entry's `path1`/`path2` to the domain pair or fails with a typed zod error surfaced at the CLI boundary. The parser lives with the rewrites-plan parsing in `bin/apply-fixes.ts` (or a small shared helper in `lib/schema.ts`); the op-builder `rsaUpdateOp` receives already-parsed values and performs no validation.

4. **Library choice** — zod, the project's existing schema library, reused so create and update share one definition of a valid display path. No hand-rolled casts; no new dependency.

## Project Structure

### Documentation (this feature)

```text
specs/014-adkit-launch-fixes/
├── plan.md              # This file
├── spec.md              # Feature spec
├── tasks.md             # Phase 2 output (/speckit-tasks)
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── bin/
│   ├── apply-fixes.ts        # rewrites boundary parse + rsaUpdateOp (path1/path2)
│   └── apply-fixes.test.ts   # op-builder + validation tests
└── lib/
    ├── schema.ts             # reused displayPath rules / path-pair parser
    └── schema.test.ts
```

**Structure Decision**: Single-project CLI. The change is localized to `bin/apply-fixes.ts` (op-builder + rewrites boundary) reusing display-path validation from `lib/schema.ts`; tests extend `apply-fixes.test.ts` (and `schema.test.ts` if a shared helper is added).

## Complexity Tracking

No constitution violations; no complexity to justify.
