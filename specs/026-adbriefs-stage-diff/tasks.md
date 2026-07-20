# Tasks: Stage campaign changes into an `adbriefs/` brief with a diff-before-apply gate

**Feature**: 026-adbriefs-stage-diff
**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md)

Unless noted, source paths are relative to the CLI package root `skills/adkit/scripts/`; `adbriefs/` and doc paths are relative to the repo root.

The strategy is test-first per unit: each new `src/adbriefs/*` module ships with a co-located `*.test.ts`, and the `vitest` suite stays green throughout. New pure functions get unit tests; the `bin/*` wiring gets tests at the command edge (as `create.test.ts` / `apply-fixes.test.ts` already do). MVP is User Story 1 (create-persist + gate) — independently shippable.

## Phase 1: Setup

- [x] T001 Establish a green baseline: from `skills/adkit/scripts/` run `npm ci` (or `npm install` if `node_modules` is absent), then `npx tsc --noEmit` and `npm test`. Record the passing test count so a regression is visible later.
- [x] T002 [P] Create the tracked `adbriefs/` directory at the repo root with a `.gitkeep` so it is versioned while empty (FR-012), and add a one-paragraph `adbriefs/README.md` stating "one YAML brief per campaign; local source of truth; do not hand-edit while an apply is in flight" (points at `reference/conventions.md`). (depends on T001)

## Phase 2: Foundational (shared pure module — blocks all stories)

- [x] T003 Create `src/adbriefs/store.ts` with pure `slugForCampaign(brief): string` (kebab-case slug of `campaign.name`, the deterministic filename identity per FR-008) and `briefPathForCampaign(root, brief): string`. Co-locate `src/adbriefs/store.test.ts` covering slug determinism, kebab-casing, and length/edge cases. (depends on T001)
- [x] T004 Add serialization to `src/adbriefs/store.ts`: `serializeBrief(brief): string` producing **stable, deterministic** YAML (fixed key order, `QUOTE_DOUBLE`, `lineWidth: 0` — mirroring the existing scaffold writer in `create.ts`) so two equal briefs serialize byte-identically (prerequisite for a clean diff). Extend `store.test.ts` with a round-trip + determinism assertion. (depends on T003)
- [x] T005 Create `src/adbriefs/diff.ts` with pure `diffBriefs(current: Brief | null, proposed: Brief): BriefDiff`, where `BriefDiff` is a typed value carrying whether anything changed, the added/removed/changed paths, and a rendered unified-diff string over the stable serialization (FR-004, FR-007, FR-009). A `null` current (no prior brief) renders as an all-added diff. Co-locate `src/adbriefs/diff.test.ts`: identical briefs → `changed === false` / empty render (FR-007); a budget change / appended keyword → a scoped, readable diff; null current → all-added. (depends on T004)

## Phase 3: User Story 1 — Persist a new campaign's brief before publishing + create-side gate (P1) 🎯 MVP

**Goal**: `/adkit create` writes the filled brief to `adbriefs/<slug>.yaml` before publishing, diffs against any existing brief, refuses to clobber a different campaign's brief, and re-syncs the file after a successful publish.

**Independent Test**: `ads.sh create <idea>` (dry-run) writes/updates `adbriefs/<slug>.yaml` with the full campaign state and shows the diff vs any existing brief; no publish happens until a non-dry-run run, and a successful publish leaves the file matching what was published.

- [x] T006 [US1] Add collision-guarded persistence to `src/adbriefs/store.ts`: `loadBriefIfExists(root, brief): Brief | null` (reuse `parseBrief` at the load boundary) and `writeBrief(root, brief): void` that **refuses** to overwrite an existing file describing a *different* campaign (name mismatch → throw a typed error surfaced as `error: adbriefs collision …`), per FR-008. Extend `store.test.ts` for the load, the happy write, and the refused-collision path. (depends on T005)
- [x] T007 [US1] Wire `src/bin/create.ts` to persist before publish: after `readBrief` + URL check and before any live `publishV1`, compute `diffBriefs(loadBriefIfExists(...), brief)` and print the rendered diff to stderr; on `--dry-run` include a `briefDiff`/`willWriteBrief` summary in the JSON envelope and write nothing live (FR-001, FR-004, FR-005). Keep the scaffold-to-`$TMPDIR` step for *filling* the brief, but the **filled** brief is persisted to `adbriefs/` as the source of truth. (depends on T006)
- [x] T008 [US1] On a successful non-dry-run publish in `create.ts`, call `writeBrief` so `adbriefs/<slug>.yaml` reflects the published state, and drop the envelope's "Not persisted locally" note (replace with the brief path) (FR-002, FR-006). Update `create.test.ts`: dry-run writes nothing live but reports the diff/target path; a stubbed successful publish persists the brief; a collision is refused. (depends on T007)
- [x] T009 [P] [US1] Update `reference/create.md`: add the "stage into `adbriefs/` first" step and the diff-before-publish gate to the Execution section, update the `version`/"Publishes are not persisted locally" table rows and the module docstring intent, and remove the stale "Nothing is written to disk" guidance (FR-011). (depends on T008)

> **⏸ Deferred to a follow-up PR (US2/US3 update-side CLI wiring).** The plan is keyed by
> live IDs (`campaignId`/`adGroupId`/`adId`) while a brief is keyed by names, so applying a
> plan onto a brief needs either the brief to carry live IDs or a full live-read
> reconstruction — and a *partial* sync would violate FR-006's "brief reflects live state."
> Rather than ship a misleading half-sync in an unattended PR, the create-side MVP (US1) +
> the shared `src/adbriefs/` store/diff land here; the shared machinery T010–T012 need
> already exists. Until wired, `/adkit update`'s review gate is the existing `--dry-run` →
> `--apply` two-step (documented in `update.md`). Tracked as the next increment.

## Phase 4: User Story 2 — Stage an update into the brief and review the diff before mutating (P1)  ⏸ deferred

**Goal**: `/adkit update` builds a base brief (load from `adbriefs/`, or hydrate best-effort from the live read), applies the plan to it to produce a proposed brief, shows the diff on dry-run, and mutates live only under `--apply`.

**Independent Test**: `ads.sh update <plan>` (default dry-run) against a campaign with an `adbriefs/` brief prints the current→proposed diff and mutates nothing; `--apply` performs the live mutation, and the diff shown matches the change applied.

- [ ] T010 [US2] Create `src/adbriefs/apply-plan.ts` with pure, immutable `applyPlanToBrief(base: Brief, plan): Brief` — folds the coerced plan deltas (rewrites/appendHeadlines, sitelinks, callouts, negatives, keyword add/remove/pause, new adGroups, budgets, campaign/adGroup status, language/searchPartners) into a **new** `Brief` via spread/`map`, never mutating `base`. Reuse `fixes/plan.ts` coercers/keys so brief-apply and live-apply agree. Co-locate `src/adbriefs/apply-plan.test.ts`: each delta kind reflected in the proposed brief; a no-op plan yields an equal brief (FR-007); base is not mutated. (depends on T005)
- [ ] T011 [US2] Create `src/adbriefs/hydrate.ts` with `briefFromLive(readResult): Brief` — narrow the existing live read (the audit read) into a schema-valid best-effort `Brief` via `parseBrief`, so an update target with no local brief still has a base to diff (FR-013). Co-locate `src/adbriefs/hydrate.test.ts` over a fixture read row-set. (depends on T005)
- [ ] T012 [US2] Wire `src/bin/apply-fixes.ts`: resolve the plan's target campaign → `adbriefs/<slug>.yaml` (load) or `briefFromLive` (hydrate) → `applyPlanToBrief` → `diffBriefs`. On dry-run, print the per-campaign rendered diff and add it to the JSON envelope; apply nothing live (FR-003, FR-004, FR-005, FR-009). For a plan touching multiple campaigns, emit one diff per campaign. (depends on T010, T011)
- [~] T013 [P] [US2] Update `reference/update.md`: **partially done** — added the `adbriefs/` source-of-truth + review-gate section pointing at `conventions.md`, and flagged the automatic brief-diff staging as the in-flight next increment. Full apply-to-brief-first wording lands when T012 wires it. (depends on T012)

## Phase 5: User Story 3 — Keep the brief in sync after a successful apply (P2)  ⏸ partly deferred

**Goal**: after a successful live apply the brief reflects the new live state; a partial/failed apply does not leave a brief asserting a fully-applied state.

**Independent Test**: `ads.sh update <plan> --apply` (stubbed success) rewrites `adbriefs/<slug>.yaml` to the proposed state; a stubbed partial failure leaves a detectable divergence rather than a clean "applied" brief.

- [x] T014 [US3] **create-side done; update-side deferred.** `create.ts` reports `briefSynced` (true on a clean publish, false on failure — FR-006/FR-010), so a failed publish is not left asserting a fully-applied brief. The `apply-fixes.ts` sync waits on the deferred T012 update wiring.
- [x] T015 [P] [US3] Update `reference/conventions.md` with a shared **"`adbriefs/` — the local source of truth + diff-before-apply gate"** section that both `create.md` and `update.md` link to (FR-011), including post-apply sync + the partial-failure divergence signal. (done)

## Phase 6: Polish & Verification

- [ ] T016 Full gate: from `skills/adkit/scripts/` run `npx tsc --noEmit` + `npm test` all green (no test weakened); run the parse-dont-validate scanner (`python3 .specify/presets/parse-dont-validate/scripts/python/parse_dont_validate.py scan src/adbriefs`) and confirm no `any`/boolean-validator/stray-cast findings in the new module. (depends on T014)
- [ ] T017 [P] End-to-end dry-run smoke: `ads.sh create <sample-idea> --dry-run` writes/updates a brief under `adbriefs/` and reports the diff; `ads.sh update <sample-plan>` prints a per-campaign diff and mutates nothing; confirm the JSON envelope contract is intact on both. Capture the output for the PR body. (depends on T016)

## Dependencies & Execution Waves

- **Wave 1 (setup):** T001 → T002.
- **Wave 2 (foundational, blocks stories):** T003 → T004 → T005.
- **Wave 3 (US1 / MVP):** T006 → T007 → T008 → T009.
- **Wave 4 (US2):** T010, T011 (parallel) → T012 → T013.
- **Wave 5 (US3):** T014 → T015.
- **Wave 6 (polish):** T016 → T017.

`[P]` marks a task that can run in parallel with its siblings once its dependency is met (distinct files). US1 is the MVP: T001–T009 deliver a persisted brief + create-side gate independently of US2/US3.
