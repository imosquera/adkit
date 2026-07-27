# Implementation Plan: Dynamic Keyword Insertion (DKI) in ad text

**Branch**: `019-dynamic-keyword-insertion` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

## Summary

Parse `{keyword:default text}` DKI codes inline within the existing RSA headline,
description, and Display-path string fields at the Brief-parse boundary (zod).
Casing-mode recognition, default-text requirement, malformed-brace rejection, and
worst-case-length enforcement all happen once, in `zod.superRefine`, on
`lib/schema.ts`'s existing `Headline`/`Description`/display-path fields — no new
structured field is introduced (per the spec's clarification). A separate pure
render helper (casing playback) and a separate pure lint function (non-blocking
advisory warnings) live alongside the parser but outside the blocking parse path.

## Technical Context

**Language/Version**: TypeScript (Node >=24), this repo's existing `skills/adkit/scripts` package.

**Primary Dependencies**: `zod` (already the schema layer for `Brief`).

**Storage**: N/A — DKI codes live inside the existing string fields; nothing new persisted.

**Testing**: `vitest` (`npm test`), colocated `*.test.ts` files, matching the rest of the package.

**Target Platform**: Node CLI (`/adkit` skill scripts).

**Project Type**: Single project — library code inside an existing CLI package.

**Performance Goals**: N/A — pure string parsing on short ad-copy fields.

**Constraints**: Parse, don't validate (repo convention): DKI validation happens exactly
once, at `parseBrief`. Downstream code (entities.ts, audit, report) never re-validates.

**Scale/Scope**: A handful of new pure modules; no SDK/API surface changes.

## Constitution Check

No project constitution file beyond `CLAUDE.md`'s functional-style + parse-don't-validate
conventions, both followed: every DKI function is pure (no I/O), and parsing happens
once at the zod boundary in `lib/schema.ts`.

## Project Structure

### Documentation (this feature)

```text
specs/019-dynamic-keyword-insertion/
├── plan.md              # This file
├── spec.md              # Feature specification (complete)
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── dki/
│   ├── parse.ts          # Pure DKI parser: casing modes, malformed-brace
│   │                      # rejection, worst-case length (the parse boundary)
│   ├── parse.test.ts
│   ├── render.ts          # Pure display-render helper (casing playback,
│   │                      # ALL_CAPS_TOKENS preservation) — preview only
│   ├── render.test.ts
│   ├── lint.ts            # Pure non-blocking advisory lint (FR-010–013)
│   └── lint.test.ts
└── lib/
    └── schema.ts          # Wires dki/parse.ts into Headline/Description/
                            # displayPath/finalUrl at Brief-parse time
```

**Structure Decision**: DKI logic is a new `dki/` module alongside the existing
`ads/`, `audit/`, `gaql/`, `ideas/`, `lib/` modules in `skills/adkit/scripts/src`.
`lib/schema.ts` is the only caller of `dki/parse.ts` — it is the single parse
boundary (FR-014). `dki/render.ts` and `dki/lint.ts` are standalone pure utilities,
not wired into the publish/audit pipelines in this pass (no existing lint-surfacing
UI to hang them off), available for a future `/adkit audit`-style consumer.

## Complexity Tracking

No constitution violations to justify.
