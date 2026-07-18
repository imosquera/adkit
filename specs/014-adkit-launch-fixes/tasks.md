# Tasks: `update` rewrites can set the RSA display path (path1/path2)

**Input**: Design documents from `/specs/014-adkit-launch-fixes/`

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Included — the spec's acceptance scenarios and edge cases are behavioral and the project is test-first (vitest). All work lands in `skills/adkit/scripts/`.

## Format: `[ID] [P?] [Story] Description (depends on ...)`

- **[P]**: Can run in parallel with other ready tasks once dependencies are satisfied
- **[Story]**: US1 (the single user story — fix a bad display path via `update`)

---

## Phase 1: Foundational (shared parse boundary)

**Purpose**: The reusable display-path parse the op-builder will trust.

- [ ] T001 [US1] Add a reusable display-path-pair parser in `skills/adkit/scripts/src/lib/schema.ts` that reuses the existing `displayPath` rules + `path2-requires-path1` refinement and yields `{ path1?, path2? }` (or export the pieces so `apply-fixes.ts` can parse a rewrite entry's paths at its boundary).

---

## Phase 2: US1 — Fix a bad display path via `update` (Priority: P1)

**Story goal**: A `rewrites` entry may carry optional `path1`/`path2`; the update op sets them when present, validated once at the boundary.

**Independent test**: Build the update op from a rewrite entry with `path1`(/`path2`) and assert the `responsive_search_ad` resource carries the paths; assert copy-only entries are unchanged; assert invalid paths are rejected.

- [ ] T002 [P] [US1] Extend `rsaUpdateOp` in `skills/adkit/scripts/src/bin/apply-fixes.ts` to accept optional `path1`/`path2` and set them on the `responsive_search_ad` resource only when provided (mirroring `createResponsiveSearchAd`). (depends on T001)
- [ ] T003 [US1] Parse `path1`/`path2` off each `rewrites` entry at the plan boundary and thread the parsed values into the `rsaUpdateOp` call in `apply-fixes.ts`; reject invalid paths with a clear CLI error. (depends on T001, T002)
- [ ] T004 [P] [US1] Update the dry-run summary line for a rewrite so a display-path change is visible before `--apply` in `apply-fixes.ts`. (depends on T003)
- [ ] T005 [P] [US1] Add tests in `skills/adkit/scripts/src/bin/apply-fixes.test.ts` covering: path1-only set, path1+path2 set, no-path unchanged, path2-without-path1 rejected, empty/space/slash/over-15/TODO rejected, and append-op untouched. (depends on T002, T003)

---

## Phase 3: Gates

- [ ] T006 [US1] Run `npm run typecheck && npm run test` in `skills/adkit/scripts` and the parse-dont-validate + constitution scanners; drive all to green. (depends on T002, T003, T004, T005)

---

## Execution Wave DAG

- **Wave 1**: T001
- **Wave 2**: T002
- **Wave 3**: T003
- **Wave 4**: T004, T005 (parallel)
- **Wave 5**: T006

## Dependencies

- Single user story (US1); no cross-story dependencies.
- T001 (shared parser) blocks everything; T002 blocks T003; T003 blocks T004; T002+T003 block T005; all block the T006 gate.
