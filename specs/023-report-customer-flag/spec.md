# Feature Specification: Consistent `--customer` flag and readable errors for `adkit report`

**Feature Branch**: `023-report-customer-flag`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Fix `adkit report` to accept `--customer <id>` (and `--customer=<id>`) like the audit/create/update subcommands, keeping the positional customer form for back-compat; and harden `sdkErrorMessage` so it never surfaces `[object Object]` on errors. Source: GitHub issue #23."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Select the report account with `--customer` (Priority: P1)

An operator who has learned the `--customer <id>` convention from `audit`, `create`, and `update` runs `adkit report --customer 1111111111 --days 30` expecting the report to run against account `1111111111`. Today that flag is ignored and the run fails; the operator should get the same behavior as every other subcommand.

**Why this priority**: This is the core defect. The inconsistent interface silently produces a broken run and an unreadable error, which is the primary complaint in the issue.

**Independent Test**: Run `adkit report --customer <id> --days 30` and confirm the report resolves the same account as the positional form and produces its normal output.

**Acceptance Scenarios**:

1. **Given** a valid leaf account id, **When** the operator runs `report --customer <id> --days 30`, **Then** the command targets `<id>` and produces the report output (JSON + dashboard), identical to the positional form.
2. **Given** the `--customer=<id>` equals form, **When** the operator runs `report --customer=<id>`, **Then** the value after `=` is used as the account id.
3. **Given** the legacy positional form, **When** the operator runs `report <id>`, **Then** it still resolves `<id>` as before (back-compat preserved).

---

### User Story 2 - Get a readable error when a report query fails (Priority: P1)

When a report query is rejected by the Google Ads API, the operator sees a message that names the actual cause instead of the literal string `[object Object]`.

**Why this priority**: An unreadable error blocks the operator from diagnosing any failure, not just the `--customer` case. It is a general reliability defect in the error path.

**Independent Test**: Pass an error object that lacks the `failure.errors[].message` shape to the error formatter and confirm the resulting string is human-legible and never equals `[object Object]`.

**Acceptance Scenarios**:

1. **Given** an error object without the `failure.errors[].message` shape, **When** it is formatted for display, **Then** the output is a non-empty, human-readable string and never `[object Object]`.
2. **Given** an error carrying a google-ads-api shape (`error_string`, `errors[].errorCode`, or a nested `failure`), **When** it is formatted, **Then** the most specific available message is surfaced.
3. **Given** an error with none of the known shapes, **When** it is formatted, **Then** a truncated serialization of the object is shown rather than `[object Object]`.

---

### Edge Cases

- `--customer` given with no following value, or as the final token → the command must not consume an unrelated token; behavior should mirror how the other subcommands treat a missing flag value.
- Both `--customer <id>` and a positional id supplied → define a single deterministic precedence (flag wins, consistent with the other subcommands) rather than silently using a garbage value.
- Error object is `null`/`undefined`, a plain string, or an `Error` instance without the SDK shape → the formatter still returns a legible string.
- A report run against a manager account that rejects metrics queries → surface actionable guidance if the same rejection audit already detects can occur here.

## Clarifications

### Session 2026-07-16

Auto-answered by autopilot from the issue + repo code (no user-facing ambiguity; these are design decisions grounded in `skills/adkit/scripts/src/bin/audit.ts` and `.../src/bin/report.ts`).

- Q: When both `--customer <flag>` and a positional id are given, which wins? → A: The flag wins — matches `audit`/`create` precedence (`resolveCustomer([args.customer, ...])` prefers the explicit flag).
- Q: How should `--customer` with a missing/next-is-flag value behave? → A: Mirror `report`'s existing `--manager`/`--days` parsing exactly (`customer = argv[i+1] ?? customer; i += 1`), so the flag is a no-op keeping the default when no value follows — consistent with the file's own convention.
- Q: Is FR-008 (manager-metrics hint) in scope, or deferred? → A: In scope. `report` queries metrics and can hit query_error 59 exactly like `audit`; reuse audit's exported `isManagerMetricsError` + `managerMetricsHint` rather than duplicating detection.
- Q: What is the truncated-serialization fallback length in `sdkErrorMessage`? → A: Cap the `JSON.stringify` fallback at ~500 chars (append an ellipsis when longer) — long enough to be diagnostic, short enough not to flood the terminal. Implementation detail; adjustable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `report` MUST accept `--customer <id>` and `--customer=<id>` and use that value as the leaf account id, mirroring how `audit`/`create`/`update` parse `--customer`.
- **FR-002**: `report` MUST continue to accept the positional customer id form for back-compat.
- **FR-003**: When both a `--customer` flag and a positional id are supplied, `report` MUST apply a single deterministic precedence consistent with the other subcommands (flag takes precedence).
- **FR-004**: The user-facing usage/help for `report` (the `reference/report.md` argument-hint and the header comment in the report entrypoint) MUST present `--customer <id>` as the primary form, consistent with the other commands.
- **FR-005**: The shared SDK error formatter MUST never return the string `[object Object]` for any input.
- **FR-006**: The error formatter MUST extract the most specific message available, including google-ads-api shapes (`failure.errors[].message`, `error_string`, `errors[].errorCode`, and nested `failure`).
- **FR-007**: When no known error shape matches, the formatter MUST fall back to a truncated serialization of the object rather than a coerced `String(...)` that yields `[object Object]`.
- **FR-008**: When a `report` query is rejected as "metrics on a manager account" (query_error 59), `report` MUST surface the same manager-metrics guidance that `audit` shows, reusing audit's exported `isManagerMetricsError` + `managerMetricsHint` rather than duplicating detection.

### Functional Programming Constraints

- Argument parsing MUST remain a pure function of its input tokens, returning a new parsed value; no mutation of shared state during parsing.
- The error formatter MUST be a pure function from an unknown error value to a string, with no side effects.

### Platform Constraints

- Change is confined to the `adkit` CLI (Node/TypeScript). No new runtime dependencies.
- Existing invocation surface (`ads.sh report ...`) MUST keep working.

## Notes

- Generated/updated by /speckit-specify from GitHub issue #23.
