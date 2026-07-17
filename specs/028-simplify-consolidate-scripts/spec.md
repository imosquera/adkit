# Feature Specification: Simplify & consolidate the adkit scripts codebase

**Feature Branch**: `028-simplify-consolidate-scripts`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Simplify & consolidate the adkit scripts codebase (GAQL builders, large bin/ files, lib/ utils) — GitHub issue #28"

## User Scenarios & Testing *(mandatory)*

<!--
  Users here are (a) adkit CLI end-users, whose observable behavior must be preserved
  except where a change is deliberately called out, and (b) the maintainers who read and
  extend this codebase, for whom the goal is materially less duplication and smaller,
  single-responsibility modules.
-->

### User Story 1 - Consolidate the GAQL query-builder layer (Priority: P1)

A maintainer opens `gaql/builders.ts` to add or adjust a Google Ads read/mutate query. Today they face 26 exported builder functions across three families (report, audit, apply) that repeat the same `{resource, fields, conditions}` shape with small variations. After this change the builders are collapsed into a small number of parameterized/data-driven builders (or a table of query descriptors) so that adding a query is a data edit, not a new near-duplicate function — while every id interpolation still routes through the digits-only `gaqlId` guard and every query remains reviewable in one place.

**Why this priority**: The query layer is the highest-leverage, lowest-risk consolidation — the builders are pure functions with existing parity tests, so equivalence is straightforward to prove.

**Independent Test**: Run the existing `gaql/builders*.test.ts` (including `builders-parity.test.ts`) after the refactor; every builder still emits the same `SearchArgs`/GAQL as before (or a diff is explicitly recorded). Can be shipped alone and delivers a smaller, more maintainable query layer.

**Acceptance Scenarios**:

1. **Given** the consolidated builders, **When** the full test suite runs, **Then** every previously-covered query produces byte-identical GAQL/`SearchArgs` unless the change is listed in the PR's behavior-delta list.
2. **Given** a numeric id passed to any builder, **When** the query is built, **Then** the id is still guarded digits-only via `gaqlId` (non-digit input rejected exactly as before).

---

### User Story 2 - Decompose the oversized `bin/` command files (Priority: P1)

A maintainer needs to change audit scoring or rendering. Today `bin/audit.ts` is ~1500 lines mixing row normalization (7 near-identical `normalize*Row` functions), query orchestration, scoring, ~8 `render*` functions, and arg parsing. After this change those concerns live in focused modules (e.g. normalization, rendering, orchestration), the repetitive row-normalizers are folded into a single generic mapper, and shared logic across `apply-fixes.ts` / `fixes/plan.ts` and the other heavy files is extracted rather than duplicated.

**Why this priority**: `audit.ts` is the single largest source of accidental complexity; splitting it unlocks safe future edits and removes the biggest duplication cluster.

**Independent Test**: `bin/audit.test.ts` (and the other bin tests) pass unchanged against the decomposed modules; the audit CLI produces the same report output for a fixed input.

**Acceptance Scenarios**:

1. **Given** the decomposed audit modules, **When** `bin/audit.test.ts` runs, **Then** it passes without weakening assertions.
2. **Given** the same audit input as before the refactor, **When** the audit command renders its report, **Then** the output text is identical except for deltas explicitly listed in the PR.

---

### User Story 3 - Consolidate overlapping `lib/` helpers (Priority: P2)

A maintainer looking for a formatting or metrics helper finds one obvious home instead of overlapping helpers scattered across `lib/report.ts`, `lib/metrics.ts`, `lib/merge.ts`, `lib/cluster.ts`, and `lib/schema.ts`. The "backwards compatibility" re-export of report builders through `lib/report` is collapsed when nothing external depends on the indirection.

**Why this priority**: Lower blast radius than US1/US2 and partly dependent on them; valuable but not the headline win.

**Independent Test**: All `lib/*.test.ts` pass; public exports in `index.ts` that are actually consumed remain available (or their removal is called out).

**Acceptance Scenarios**:

1. **Given** consolidated helpers, **When** the suite runs, **Then** every consumer resolves its helper from the new single home with no behavior change.
2. **Given** the collapsed re-export, **When** the package builds and tests run, **Then** no import breaks (or a break is intentional and listed).

---

### Edge Cases

- **A consolidation would change a query's fields or output.** The change is only allowed if it is explicitly recorded in the PR's behavior-delta list; otherwise the builder must stay equivalent.
- **A test encodes current (soon-to-change) behavior.** The test is updated intentionally and the change is called out — tests are never weakened or deleted merely to make a refactor pass.
- **An `index.ts` public export is consumed by a caller outside `scripts/src`.** Such exports (or the `lib/report` re-export seam) are only removed after confirming no consumer depends on them; otherwise the export is preserved.
- **Scope creep into workflow docs.** `reference/*.md` and `SKILL.md` are out of scope for this pass and must not be modified.

## Clarifications

### Session 2026-07-17 (auto-answered by autopilot — see issue #28 comment)

- Q: When consolidating the 26 GAQL builders, replace them with a new data-driven API, or keep the named functions? → A: Preserve the existing named builder exports (`campaignTotalsQuery`, `auditKeywordsQuery`, `applyNegativesQuery`, …) as thin wrappers over a parameterized core, so every call site, test, and `index.ts` export stays stable and equivalence is provable.
- Q: The issue permits behavior changes if called out — what is the default posture on user-visible output (CLI text, query fields, JSON envelope) for this pass? → A: Behavior-preserving by default. This is an internal refactor; aim for zero user-visible output changes. Any unavoidable delta must be minimal and explicitly listed in the PR (FR-008).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The GAQL builder layer (`gaql/builders.ts`) MUST be consolidated so the three families (report, audit, apply) share parameterized construction instead of 26 near-duplicate functions, while preserving each query's output.
- **FR-002**: Every id interpolated into a query MUST continue to pass through the `gaqlId` digits-only guard; no consolidation may open an injection path that the current code closes.
- **FR-003**: `bin/audit.ts` MUST be decomposed into focused modules (at minimum: row normalization, rendering, and query/scoring orchestration) such that no single resulting module retains the full mixed-concern surface.
- **FR-004**: The repetitive `normalize*Row` functions MUST be folded into a shared/generic mapping approach rather than one bespoke function per row shape.
- **FR-005**: Shared logic across `bin/apply-fixes.ts`, `fixes/plan.ts`, and the other heavy files (`ads/entities.ts`, `bin/research.ts`) MUST be extracted where duplication exists, rather than left copy-pasted.
- **FR-006**: Overlapping helpers across `lib/` MUST be consolidated to a single home per responsibility, and the `lib/report` backwards-compat re-export MUST be collapsed unless an external consumer requires it.
- **FR-007**: The full `vitest` suite MUST pass at the end of the change; tests may only be modified to reflect an intentional, listed behavior change, never weakened to paper over a regression.
- **FR-008**: This pass is behavior-preserving by default — it MUST aim for zero user-visible output changes (CLI text, query fields, JSON envelope). Any unavoidable delta MUST be minimal and enumerated explicitly in the PR description; silent behavior changes are not permitted.
- **FR-012**: The consolidation MUST preserve the existing named builder exports as thin wrappers over the parameterized core, keeping every current call site, test, and `index.ts` export resolvable without edits (removals allowed only when unused and called out per FR-008).
- **FR-009**: The change MUST produce a measurable reduction in duplication/line count across the three scoped areas, and the PR MUST report the before/after deltas.
- **FR-010**: The change MUST NOT modify the `reference/*.md` workflow docs or `SKILL.md` routing (explicitly out of scope).
- **FR-011**: A short consolidation survey (what was merged/removed, with behavior deltas) MUST be posted to issue #28 as the audit trail before the refactor is presented for review.

### Functional Programming Constraints

- Query builders MUST remain pure functions of their inputs, returning new `SearchArgs` values with no shared-state mutation, consistent with the module's existing contract.
- Extracted normalization/rendering helpers MUST be pure (same input → same output, no side effects); I/O (SDK/MCP calls, stdout) stays isolated at the command edges.
- Consolidation MUST follow "parse, don't validate": push loose input through a single boundary parse into a strong type and remove redundant downstream re-checks rather than relocating them. Prefer strengthening argument types over re-validating "impossible" states.
- No classes for logic MUST be introduced; the only acceptable classes remain error types and unavoidable third-party SDK objects.

### Platform Constraints

- Change is confined to the `adkit` skill's TypeScript codebase under `skills/adkit/scripts/src`. No new runtime dependencies.
- All existing CLI invocation surfaces (the `bin/*` entrypoints and their `ads.sh`/skill wrappers) MUST keep working with identical arguments.
- No changes to `reference/*.md` or `SKILL.md`.

## Notes

- Generated/updated by /speckit-specify from GitHub issue #28.
- Behavior *may* change where it meaningfully reduces complexity, but every such change is called out per FR-008; the `vitest` suite is the equivalence guardrail. A human reviews the draft PR before merge, which satisfies the issue's "acknowledged before large refactors merge" acceptance criterion.
