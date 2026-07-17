# Implementation Plan: Migrate read commands to the official google-ads-mcp server

**Branch**: `011-migrate-reads-google-ads-mcp` | **Date**: 2026-07-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/011-migrate-reads-google-ads-mcp/spec.md`

## Summary

Restructure every Google Ads *read* query builder in
`skills/adkit/scripts/src/gaql/builders.ts` to return a typed, decomposed
`SearchArgs` value (`{ resource, fields, conditions, orderings?, limit? }`) instead
of a raw GAQL string, backed by a pure `toGaql(SearchArgs)` serializer that
reproduces the exact strings today's SDK path consumes. Extend the `AdsClient`
abstraction in `lib/auth.ts` with a structured search entrypoint the SDK client
satisfies via `toGaql`, add an `McpAdsClient` seam that consumes `SearchArgs`, and a
read-backend selector that parses a single env flag into a backend choice defaulting
to the SDK. The live MCP round-trip, field-for-field parity, and default-backend
cutover require a live account + running Python MCP server and are **deferred**
(documented) — this change ships the offline-verifiable foundation and keeps every
read byte-identical under the default SDK backend.

## Technical Context

**Language/Version**: TypeScript (ES2022 modules), Node ≥ 18, run via `tsx`/`vitest`

**Primary Dependencies**: `google-ads-api@^24.1.0` (SDK, unchanged); `@modelcontextprotocol/sdk` introduced only as a type-level/seam dependency for the deferred MCP client — no live wiring exercised in tests

**Storage**: N/A (credentials read from `~/.config/google-ads/google-ads.yaml`)

**Testing**: vitest (`skills/adkit/scripts`)

**Target Platform**: CLI bins under `skills/adkit/scripts/src/bin/`

**Project Type**: single CLI/library package

**Performance Goals**: no regression under the default SDK backend; MCP transport/parallelism perf is a deferred-phase concern

**Constraints**: offline-buildable and fully unit-testable without a live Google Ads account or a running MCP server; SDK path behavior unchanged

**Scale/Scope**: ~20 read builders across report/audit/apply-fixes; one `AdsClient` interface; one backend selector; reference-doc updates

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
section below — the builders stay pure functions returning immutable `SearchArgs`
values (no accumulator loops, no classes for logic), `toGaql` is a pure serializer,
and the one narrowing at the boundary (the env flag → backend choice) is parsed once.

## Project Structure

### Documentation (this feature)

```text
specs/011-migrate-reads-google-ads-mcp/
├── plan.md              # This file
├── spec.md              # Feature spec
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── gaql/
│   ├── builders.ts        # CHANGED: every read builder returns SearchArgs
│   ├── builders.test.ts   # CHANGED: assert SearchArgs shape + toGaql equivalence
│   ├── search-args.ts     # NEW: SearchArgs type + pure toGaql() serializer
│   ├── search-args.test.ts# NEW: toGaql clause assembly/omission unit tests
│   └── escape.ts          # UNCHANGED: gaqlId() reused inside conditions
├── lib/
│   ├── auth.ts            # CHANGED: AdsClient.searchStructured(SearchArgs); backend selector
│   ├── auth.test.ts       # CHANGED: SDK client structured search == toGaql path
│   └── mcp-client.ts      # NEW: McpAdsClient seam consuming SearchArgs (live wiring gated/deferred)
└── bin/                   # report.ts / audit.ts / apply-fixes.ts / preflight.ts read call-sites
```

## Parse Boundaries

This feature is implemented in TypeScript with a real executable surface, so it does
introduce and touch boundaries — enumerated here per the parse-don't-validate preset.

1. **Trust boundaries**: Two are relevant. (a) **GAQL id interpolation** — already
   guarded by `gaqlId()` in `gaql/escape.ts`, which parses a `string | number` into a
   digits-only string or throws. This boundary is preserved: builders route ids
   through `gaqlId()` when constructing `conditions`, so no un-guarded id ever reaches
   `toGaql`. (b) **Read-backend env flag** — `ADKIT_READ_BACKEND` (untrusted process
   env) is parsed **once** at the selector into a closed `ReadBackend` union
   (`"sdk" | "mcp"`), defaulting to `"sdk"` for any absent/unrecognized value; no
   downstream code re-reads or re-checks the raw env string. No new HTTP handler, DB
   row, or `JSON.parse` of external data is added by the offline scope (the MCP row
   parser lives in the deferred `mcp-client.ts` live path).
2. **Domain types**: `SearchArgs` is the new domain type — it makes a well-formed
   decomposed query representable and an ad-hoc string un-representable at the builder
   boundary. `ReadBackend` is a closed union so an illegal backend name cannot flow
   downstream. Both carry their proof: once a builder returns a `SearchArgs`, callers
   never re-validate its parts.
3. **Parsers**: `parseReadBackend(env): ReadBackend` is the one parser added — raw env
   string in, precise union out, default applied at the boundary. `gaqlId()` remains
   the id parser. `toGaql(SearchArgs)` is a pure *serializer* (domain type → string),
   not a parser, and adds no validation.
4. **Library choice**: N/A — no schema library (zod, etc.) is warranted; the two
   boundaries (digits-only id, a two-value backend union) are trivial closed parses
   better expressed as small pure functions than a schema dependency.

## Complexity Tracking

No constitution gate applies (N/A) and no complexity deviation is introduced: the
change is a type-preserving refactor plus a small reversible seam. The one added
runtime dependency (`@modelcontextprotocol/sdk`) is confined to the deferred MCP
client seam and is not exercised by the default SDK path or the test suite.
