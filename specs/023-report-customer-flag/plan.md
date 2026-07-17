# Implementation Plan: Consistent `--customer` flag and readable errors for `adkit report`

**Branch**: `023-report-customer-flag` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/023-report-customer-flag/spec.md`

## Summary

Two P1 defects in the `adkit report` subcommand:

1. `report` ignores `--customer <id>` (accepted by `audit`/`create`/`update`), silently treating the literal `--customer` token as the positional customer and querying a garbage account. Fix: teach `parseArgs` to consume `--customer <id>` and `--customer=<id>`, keeping the positional form for back-compat; flag wins over positional.
2. The shared `sdkErrorMessage` formatter returns `[object Object]` for plain error objects that lack `failure.errors[].message`. Fix: extend it to pull additional google-ads-api shapes and fall back to a truncated `JSON.stringify` instead of `String(exc)`.

Plus FR-008: surface audit's existing manager-metrics guidance (`isManagerMetricsError` + `managerMetricsHint`) from `report`'s error handler, since `report` queries metrics and can hit the same `query_error 59` rejection.

## Technical Context

**Language/Version**: TypeScript (Node, ESM), compiled via the adkit `skills/adkit/scripts` package.

**Primary Dependencies**: `google-ads-api` (SDK error shapes), `yaml`, `vitest` (tests). No new dependencies.

**Storage**: N/A (report writes YAML to `ads/output/reports/`; unchanged).

**Testing**: `vitest` — existing `report.test.ts` and `output.test.ts` under `skills/adkit/scripts/src`.

**Target Platform**: CLI (`ads.sh report …` → `adkit-report`).

**Project Type**: single CLI project.

**Performance Goals**: N/A (arg parsing + error formatting; no hot path).

**Constraints**: Pure functions for parsing and error formatting (repo CLAUDE.md rule 1); back-compat for the positional customer form; existing `ads.sh report` invocation must keep working.

**Scale/Scope**: Three source files + two test files under `skills/adkit/scripts/src`, plus `reference/report.md` usage text.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after design.*

The project constitution at `.specify/memory/constitution.md` is an unfilled template (placeholder principle names); `constitution_audit.py validate` treats it as a no-op. The binding conventions for this repo live in `CLAUDE.md` and are honored here:

- **Functional style** (CLAUDE.md rule 1): "same input → same output, no side effects in the core logic". `parseArgs` and `sdkErrorMessage` remain pure functions returning new values; no parameter mutation. **PASS**
- **Parse, don't validate** (CLAUDE.md rule 2): "Turn untrusted/loose input (CLI args, JSON plans, API rows, env) into a precise, well-typed value once, at the edge". `parseArgs` is the single CLI-arg boundary producing the strong `ReportArgs`; `sdkErrorMessage` narrows an `unknown` SDK error to a `string` at the error edge. **PASS**
- **No redundant downstream checks** (CLAUDE.md rule 2): the parsed `ReportArgs.customer` is trusted downstream; no new re-checks are introduced. **PASS**

No violations; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/023-report-customer-flag/
├── spec.md
├── plan.md
├── tasks.md            # created by /speckit-tasks
├── requirements.md     # spec quality checklist (checklists/requirements.md)
└── quickstart.md       # optional validation guide
```

### Source Code (repository root)

```text
skills/adkit/scripts/
├── src/
│   ├── bin/
│   │   ├── report.ts        # parseArgs: accept --customer; error handler: manager-metrics hint
│   │   ├── report.test.ts   # new cases: --customer, --customer=, precedence, back-compat
│   │   └── audit.ts         # reuse exported isManagerMetricsError / managerMetricsHint
│   └── cli/
│       ├── output.ts        # harden sdkErrorMessage
│       └── output.test.ts   # new case: no [object Object]
└── reference/
    └── report.md            # argument-hint updated to --customer <id> primary
```

**Structure Decision**: Single CLI package (`skills/adkit/scripts`). Changes are confined to `report.ts`, `output.ts`, their tests, and `reference/report.md`. `audit.ts`'s `isManagerMetricsError`/`managerMetricsHint` are already exported and reused as-is.

## Parse Boundaries

TypeScript feature — enumerated per the parse-dont-validate gate.

1. **Trust boundaries**
   - **CLI argv** (`string[]`) enters `report.ts::parseArgs(argv)`. Raw tokens are untrusted; they are consumed token-by-token and never leak out untyped — the function returns a fully-typed `ReportArgs`.
   - **SDK thrown error** (`unknown`) enters `output.ts::sdkErrorMessage(exc: unknown)`. Kept as `unknown` (never `any`); every field access is a guarded narrowing (`(exc as {…})?.field`) before use.
2. **Domain types**
   - `ReportArgs { customer: string; manager: string; days: number }` — the parsed, trusted shape returned by `parseArgs`. Existing type; extended only in how `customer` is populated, not its shape. Customer/manager ids remain `string` (existing convention; `normalizeId`/`requireDigits` enforce digit-only downstream — unchanged).
   - The error path produces a plain `string` (the human-readable message); no new nominal type is warranted for a one-shot display string.
3. **Parsers**
   - `parseArgs` (module `src/bin/report.ts`) is the sole CLI-arg parser: `string[] → ReportArgs`. It does not throw; unknown/valueless flags fall through to existing defaults, consistent with the file's `--manager`/`--days` handling.
   - `sdkErrorMessage` (module `src/cli/output.ts`) is the sole error parser: `unknown → string`. It tries, in order, `failure.errors[].message`, then other google-ads-api shapes (`error_string`, `errors[].errorCode`, nested `failure`), then a truncated `JSON.stringify`, then a primitive `String()` only for genuinely primitive inputs — guaranteeing it never returns `[object Object]`.
4. **Library choice**
   - Hand-rolled parsers, not a schema library. Rationale: both boundaries are tiny (a fixed CLI grammar and a best-effort error unwrap), the repo does not use Zod for CLI parsing here, and `google-ads-api`'s error object is a loose union best handled by ordered guarded reads. Adding a schema dependency would be heavier than the problem warrants and inconsistent with the sibling `audit`/`create` parsers.

## Complexity Tracking

*No Constitution Check violations; nothing to justify.*
