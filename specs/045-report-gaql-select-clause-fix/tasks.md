---

description: "Task list for fixing the GAQL SELECT/WHERE field mismatch in report queries"
---

# Tasks: Fix GAQL SELECT/WHERE field mismatch in report queries

**Input**: Design documents from `specs/045-report-gaql-select-clause-fix/`

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Included — the spec (Tests section, issue #43) explicitly requests a
generated-GAQL unit test and a regression test.

**Organization**: This feature has a single user story (US1, P1) — no Setup or
Foundational phase is needed; the fix is entirely inside one existing function.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1)
- Paths are relative to `skills/adkit/scripts/` (the adkit CLI package)

---

## Phase 1: User Story 1 - Daily campaign report succeeds end to end (Priority: P1) 🎯 MVP

**Goal**: `ads.sh report <customer> --days N` returns per-day, per-campaign
metrics with no "must be present in SELECT clause" error, and the guarantee
that fixes it is enforced for every report query, not just the one that broke.

**Independent Test**: Run `ads.sh report <customer> --days 7` against a real
account with enabled, serving campaigns; confirm it completes and prints
non-empty daily rows with no GAQL error.

### Tests for User Story 1

> Write these first; T002 should FAIL against the current `reportQuery()`
> before T001 lands, confirming it reproduces the bug.

- [ ] T001 [P] [US1] Add a case to `src/gaql/builders.test.ts` asserting `campaignDailyQuery(start, end).fields` includes `"campaign.status"`
- [ ] T002 [P] [US1] Add a regression case to `src/gaql/builders.test.ts` that iterates every `reportQuery`-derived export (`campaignTotalsQuery`, `campaignDailyQuery`, `adGroupQuery`, `adQuery`, `keywordQuery`, `searchTermQuery`, `geoQuery`, `geoRegionQuery`) and asserts each query's `fields` is a superset of `"campaign.status"` plus its own `orderings` (when present)

### Implementation for User Story 1

- [ ] T003 [US1] In `src/gaql/builders.ts`, name the status field the existing `_ENABLED` constant filters on (e.g. `const _STATUS_FIELD = "campaign.status"`) and change `reportQuery()` to compute `fields` as `[...new Set([...dims, _STATUS_FIELD, ...(orderings ?? [])]), ..._METRICS]` instead of `[...dims, ..._METRICS]` (depends on T001, T002)
- [ ] T004 [US1] Run `npm run typecheck` and `npm test` in `skills/adkit/scripts/` and confirm T001/T002 now pass and no existing `builders.test.ts` / `builders-parity.test.ts` case regresses (depends on T003)
- [ ] T005 [US1] Verify live: run `ads.sh report 8911925499 --days 7` and confirm it completes with per-day/per-campaign rows and no "must be present in SELECT clause" error (SC-001) (depends on T003)

**Checkpoint**: User Story 1 (the only story) is fully functional and
independently testable — this is the whole feature.

---

## Execution Wave DAG

```text
Wave 1 (parallel): T001, T002
Wave 2:            T003            (depends on T001, T002)
Wave 3 (parallel): T004, T005      (both depend on T003)
```

---

## Dependencies & Execution Order

### Phase Dependencies

- No Setup or Foundational phase — single user story, no shared infrastructure
  to stand up.
- **User Story 1 (Phase 1)**: self-contained; the whole feature.

### Within User Story 1

- Tests (T001, T002) are written first and must fail against the current
  `reportQuery()` before the fix lands.
- Implementation (T003) depends on both tests existing.
- Verification (T004, T005) depends on the implementation and can run in
  parallel with each other.

### Parallel Opportunities

- T001 and T002 (different assertions, same test file, no shared state) can be
  written in parallel.
- T004 (automated suite) and T005 (live manual check) can run in parallel once
  T003 lands.

---

## Implementation Strategy

### MVP First (and only)

1. T001, T002 — write the failing tests.
2. T003 — fix `reportQuery()`.
3. T004, T005 — confirm the suite is green and the live command works.
4. Done — this feature has exactly one user story, so there is no further
   incremental delivery beyond this MVP.

---

## Notes

- No new files are created; every task touches `src/gaql/builders.ts` and/or
  `src/gaql/builders.test.ts`, both already tracked.
- `segments.date` (the other WHERE-referenced field, from the date-range
  condition) is included in the fix's SELECT guarantee alongside
  `campaign.status` — see plan.md's Phase 1 Design "Revision" note: an earlier
  version of this plan excluded it based on an unverified assumption that a
  PR reviewer correctly caught (#43).
