# Tasks: Consistent `--customer` flag and readable errors for `adkit report`

**Feature**: 023-report-customer-flag
**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md)

All paths are relative to the CLI package root `skills/adkit/scripts/`.

Tests requested (spec Verify section + FR acceptance scenarios call for unit tests), so test tasks are included and written before the implementation they cover.

## Phase 1: Setup

- [ ] T001 Confirm the CLI package builds and existing tests pass as a baseline: run `npm test` and `npx tsc --noEmit` from `skills/adkit/scripts/` (install deps first if `node_modules` is absent).

## Phase 2: Foundational

*No shared foundational work — the two fixes touch independent modules (`report.ts` and `output.ts`). Proceed directly to the user stories.*

## Phase 3: User Story 1 — Select the report account with `--customer` (P1)

**Goal**: `report --customer <id>` / `--customer=<id>` targets the leaf account like the other subcommands; positional form kept; flag wins.

**Independent Test**: `parseArgs(["--customer","123"])` and `parseArgs(["--customer=123"])` both yield `customer === "123"`; `parseArgs(["456"])` still yields `"456"`; flag+positional yields the flag value.

- [ ] T002 [P] [US1] Add failing tests in `src/bin/report.test.ts` for `parseArgs`: (a) `--customer <id>` sets customer, (b) `--customer=<id>` sets customer, (c) positional-only still works (back-compat), (d) flag wins when both flag and positional are given, (e) trailing `--customer` with no value keeps the default (no crash). (depends on T001)
- [ ] T003 [US1] Update `parseArgs` in `src/bin/report.ts` to handle `--customer <id>` (consume next token, `i += 1`) and `--customer=<id>` (slice), mirroring the existing `--manager`/`--days` branches; ensure the flag value takes precedence over any positional token. (depends on T002)
- [ ] T004 [P] [US1] Update the header usage comment in `src/bin/report.ts` (~L11) to show `adkit-report --customer <id> [--manager <id>] [--days 14]` as the primary form, positional as legacy. (depends on T003)
- [ ] T005 [P] [US1] Update `reference/report.md` `argument-hint` (and any usage line) to present `--customer <id>` as the primary form, consistent with `audit`/`create`/`update`. (depends on T003)

## Phase 4: User Story 2 — Readable error when a report query fails (P1)

**Goal**: `sdkErrorMessage` never returns `[object Object]`; it extracts the most specific google-ads-api message and otherwise serializes.

**Independent Test**: `sdkErrorMessage({ some: "object" })` returns a non-`[object Object]`, non-empty string; known SDK shapes surface their message.

- [ ] T006 [P] [US2] Add failing tests in `src/cli/output.test.ts`: (a) an error object without `failure.errors[].message` yields a non-`[object Object]` string, (b) an object with `error_string` surfaces it, (c) an object with `errors[].errorCode` / nested `failure` surfaces a useful message, (d) a primitive (string/number) and `null`/`undefined` still format legibly. (depends on T001)
- [ ] T007 [US2] Harden `sdkErrorMessage` in `src/cli/output.ts`: keep the existing `failure.errors[].message` path first, then try `error_string`, `errors[].errorCode`, and a nested `failure`; as a last resort return a truncated `JSON.stringify(exc)` (~500 chars, ellipsis when longer) rather than `String(exc)`; only use `String()` for genuinely primitive inputs. Keep it a pure `unknown → string` function. (depends on T006)

## Phase 5: User Story 3 / FR-008 — Manager-metrics guidance in report (P1)

**Goal**: A `query_error 59` "metrics on a manager account" rejection from a report run surfaces audit's `managerMetricsHint()` instead of an opaque error.

**Independent Test**: Feeding a manager-metrics-shaped error through report's error path yields the manager-metrics guidance text.

- [ ] T008 [P] [US3] Add a test (in `src/bin/report.test.ts`) asserting that report's error-handling helper returns the manager-metrics guidance when given a `query_error 59` / "manager account" shaped error, and returns the normal message otherwise. (depends on T001)
- [ ] T009 [US3] In `src/bin/report.ts`, import audit's exported `isManagerMetricsError` + `managerMetricsHint` (from `./audit.js`) and, in the report query `catch` block (~L414–423), prefer the manager-metrics hint when `isManagerMetricsError(exc)` is true; otherwise keep the existing `remediationHint` path. Avoid duplicating detection logic. (depends on T007, T008)

## Phase 6: Polish & Cross-Cutting

- [ ] T010 Run the full gate set from `skills/adkit/scripts/`: `npx tsc --noEmit`, `npm test`, and lint (`npx eslint .` or the package's lint script); fix any fallout. (depends on T003, T004, T005, T007, T009)
- [ ] T011 Manual end-to-end verification per spec Verify section: from the repo root run `bash ads.sh report --customer 8911925499 --days 30` (expect JSON + dashboard / a real error, never `[object Object]`) and `bash ads.sh report 8911925499` (back-compat). Record the observed output. (depends on T010)

## Dependencies (story completion order)

- Setup (T001) → everything.
- US1 (T002–T005), US2 (T006–T007), and US3-tests (T008) are mutually independent and can proceed in parallel after T001.
- US3 impl (T009) depends on US2 impl (T007, for the hardened formatter feeding `isManagerMetricsError`) and its own test (T008).
- Polish (T010) depends on all implementation tasks; T011 depends on T010.

## Execution Wave DAG

- **Wave 1** (after start): T001
- **Wave 2** (after T001, parallel): T002, T006, T008
- **Wave 3** (parallel): T003 (after T002), T007 (after T006)
- **Wave 4** (parallel): T004, T005 (after T003), T009 (after T007, T008)
- **Wave 5**: T010 (after T003, T004, T005, T007, T009)
- **Wave 6**: T011 (after T010)

## Implementation Strategy

MVP = User Story 1 (the `--customer` fix) — it alone resolves the primary reported defect. US2 (readable errors) and US3 (manager-metrics hint) are independently valuable increments layered on top. Each user story is independently testable via its unit tests before the manual end-to-end check.
