# Implementation Plan: Stage `ads.sh update` changes into the local adbrief before mutating live

**Branch**: `043-adbrief-stage-update` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/043-adbrief-stage-update/spec.md`

## Summary

`ads.sh update` (`bin/apply-fixes.ts`) validates a fixes plan and mutates live Google Ads state, but never touches `adbriefs/` — so the local brief silently drifts from live on every update, unlike `ads.sh create` which already stages a write-brief → diff → apply gate before publishing. This feature closes that gap: `apply-fixes.ts` loads the reverse id index (`adbriefs/state.ts::loadStateIndex`), resolves the plan's `campaignId`/`adGroupId`/`adId` references to their owning brief slug via the existing `StateLocator`/`AdGroupLocator` types, groups the plan's already-computed changes (the same `campaignStatusPlan`/`newNegatives`/`newPositiveKeywords`/etc. outputs `fixes/plan.ts` produces today) per resolved slug, and applies them to that slug's on-disk brief through a new pure `applyPlanToBrief` function. The staged brief is diffed against disk with the existing `diffBriefs` (`adbriefs/diff.ts`) on every run, dry-run or `--apply`. On `--apply`, the live mutation for a given slug's entities runs first, exactly as today; only after it succeeds is that slug's brief written via the existing `writeBrief`. A plan touching multiple campaigns produces one independent diff/write per resolved slug (FR-010); an id with no state-file record degrades that entity's staging only (FR-001/FR-008), while its live mutation proceeds unchanged. All new logic is a pure module (`adbriefs/apply-plan.ts`) that reuses `Brief`, `StateIndex`, and `plan.ts`'s computed deltas — no new schema, no new dependency, no re-derivation of changes already computed for the live mutation.

## Technical Context

**Language/Version**: TypeScript on Node ≥ 24, run directly via `tsx` (no build step, per `package.json` scripts: `typecheck`/`test`/`test:watch`).

**Primary Dependencies**: existing only — `zod` (brief/state/plan parse boundaries), `yaml` (serialize/parse), `google-ads-api` (live mutations). No new runtime dependency.

**Storage**: flat YAML files under `adbriefs/` at the repo root — `<slug>.yaml` (intent brief) and `<slug>.state.yaml` (live-id index), both already established by feature 026.

**Testing**: `vitest` (co-located `*.test.ts`), run via `npx vitest run` in `skills/adkit/scripts`.

**Target Platform**: local CLI (`ads.sh update` / `ads.sh apply-fixes`), invoked by the `/adkit` skills and CI.

**Project Type**: single CLI package (`skills/adkit/scripts`).

**Performance Goals**: N/A (interactive CLI; resolving ids through an in-memory `StateIndex` and diffing a handful of campaign briefs is trivial — the spec requires zero additional live queries for id resolution, FR-001).

**Constraints**: preserve dry-run-by-default / `--apply` (FR-004); preserve the JSON-envelope contract, extended with `briefSynced`, `briefPath`, `briefStagingSkipped`, `briefStagingSkipReason` (FR-009); live-mutate-then-write ordering per slug (FR-005); one diff/write per resolved slug, never a combined cross-campaign diff (FR-010); a partial/failed apply must leave every not-yet-written brief byte-for-byte unchanged (FR-006); never overwrite a different campaign's brief at a slug (FR-007, mirrors `create`'s `assertNoForeignBrief`); `appendHeadlines` staging dedup must be case-sensitive exact-match, identical to the live-mutation rule already in `apply-fixes.ts` (clarified 2026-07-27).

**Scale/Scope**: a handful of campaigns/briefs touched per plan run; each brief is a few hundred lines of YAML.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after design.*

The project constitution at `.specify/memory/constitution.md` is an unfilled template (placeholder principle names); `constitution_audit.py list` matches no principle headings and `validate` treats the gate as a no-op. Verdict: **N/A**. The binding conventions for this repo are `CLAUDE.md`'s functional-style and parse-don't-validate rules, evaluated below:

- **Functional style — pure core, I/O at the edges** (CLAUDE.md: "Isolate I/O (network, filesystem, stdout, SDK mutations) to the edges"). The new `adbriefs/apply-plan.ts` module (`applyPlanToBrief`, id-resolution/grouping helpers) takes already-parsed values (`Brief`, `StateIndex`, `plan.ts`'s computed change-lists) and returns new values with no fs/network access; `bin/apply-fixes.ts` remains the only place that reads `adbriefs/*.yaml`/`*.state.yaml`, calls the Ads API, and writes brief files. **PASS**
- **Immutable data — no mutated parameters, no accumulator loops** (CLAUDE.md: "never mutate a parameter or build a result by pushing into an accumulator in a loop"). `applyPlanToBrief` returns a new `Brief` built via spread/`map`/`filter` over the base brief and the resolved deltas; it never mutates the `Brief` or `StateIndex` it's handed. Per-slug grouping of resolved plan entities uses `reduce`/`map`, consistent with the existing `reduce`-based live-state builders already in `apply-fixes.ts` (e.g. `liveNegatives`, `campaignBudgets`). **PASS**
- **No classes for logic** (CLAUDE.md: "The only acceptable classes are error types (exceptions) and unavoidable third-party SDK objects"). No new classes are introduced; the only class touched is the existing `AdbriefsError` (an error type, already permitted) thrown by `store.ts`/`state.ts` on a collision or corrupt file. **PASS**
- **Parse, don't validate — parse once at the boundary** (CLAUDE.md: "Turn untrusted/loose input into a precise, well-typed value once, at the edge... Downstream code receives the parsed type and never re-checks"). The three boundaries this feature touches are each already-established single parsers: `loadStateIndex`/`parseState` (state YAML → `StateIndex`), `parseBrief` (brief YAML → `Brief`), and `fixes/plan.ts`'s `validate`/`coerceKeyword`/`campaignStatusPlan`-family (plan `Record<string, unknown>` sections → typed change-lists). `applyPlanToBrief` consumes only the already-typed `Brief` and already-computed change-lists — it does not re-parse the plan or re-validate a change `validate()` already gated. **PASS**
- **Strengthen arguments, don't weaken results** (CLAUDE.md: "take a type that makes that impossible... rather than returning `Maybe`/null and forcing every caller to re-handle the 'impossible' case"). Per-slug grouping resolves ids to `StateLocator`/`AdGroupLocator` (proof a brief exists for that slug) *before* calling `applyPlanToBrief`, so the apply function's signature carries a brief that is known to exist — it is never called speculatively with a maybe-brief and asked to handle "no brief" internally; the "no brief" / "unresolvable id" cases are filtered out one level up (FR-001/FR-008) and surfaced as an explicit skip result, not absorbed into a nullable return from the pure apply function. **PASS**

Complexity Tracking is empty — no violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/043-adbrief-stage-update/
├── spec.md
├── plan.md
├── tasks.md              # created by /speckit-tasks
└── requirements.md       # spec quality checklist
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── adbriefs/
│   ├── apply-plan.ts        # NEW — resolve a FixesPlan's ids to per-slug groups via StateIndex,
│   │                        #   then applyPlanToBrief(base: Brief, resolved) -> Brief (pure)
│   ├── apply-plan.test.ts   # NEW
│   ├── store.ts             # unchanged — writeBrief/loadBriefIfExists/assertNoForeignBrief reused as-is
│   ├── diff.ts               # unchanged — diffBriefs reused as-is
│   └── state.ts              # unchanged — StateIndex/StateLocator/AdGroupLocator/loadStateIndex reused as-is
├── fixes/
│   └── plan.ts               # unchanged — campaignStatusPlan/newNegatives/newPositiveKeywords/etc. outputs
│                              #   are fed into applyPlanToBrief, not recomputed
├── lib/schema.ts              # unchanged — Brief reused verbatim as the staged-brief type
└── bin/
    ├── apply-fixes.ts        # MODIFIED — load StateIndex once; after validate(), resolve every
    │                          #   plan-touched id to (slug, entity); group per slug; for each
    │                          #   resolved slug load its on-disk brief, call applyPlanToBrief,
    │                          #   diffBriefs, print the diff (every run); on --apply, mutate live
    │                          #   first (existing sequence, unchanged), then writeBrief per slug
    │                          #   that mutated successfully; emit briefSynced/briefPath/
    │                          #   briefStagingSkipped/briefStagingSkipReason per FR-009
    └── apply-fixes.test.ts   # extended with the new staging/diff/skip cases

skills/adkit/reference/
├── update.md                 # document the new stage → diff → apply flow, incl. the
│                              #   per-entity unresolvable-id / missing-state-file skip behavior
└── conventions.md             # extend the shared create/update write-brief → diff → apply gate
                                #   description to cover update's per-slug independence (FR-010)
```

**Structure Decision**: Single CLI package (`skills/adkit/scripts`). Only one new file pair is added — `adbriefs/apply-plan.ts` (+ test) — because every other dependency (`Brief`, `StateIndex`, `diffBriefs`, `writeBrief`/`loadBriefIfExists`/`assertNoForeignBrief`, and every `fixes/plan.ts` change-list function) already exists and is reused verbatim. `bin/apply-fixes.ts` is the only edited entrypoint: it gains the id-resolution/grouping/staging wiring but keeps its existing live-fetch → validate → plan-derive → narrate → mutate structure intact, per FR-005's ordering requirement. `reference/update.md` and `reference/conventions.md` are updated to document the new flow, matching how feature 026 updated `reference/create.md`.

## Parse Boundaries

TypeScript feature — enumerated per the parse-dont-validate gate.

1. **Trust boundaries**
   - **Update plan YAML** (`FixesPlan`, `bin/apply-fixes.ts::loadPlan`) — already parsed once via `yamlParse` into the loose `FixesPlan` interface; its per-section arrays remain `Array<Record<string, unknown>>` and `fixes/plan.ts::validate` (plus the coercers `coerceKeyword`, `campaignStatusPlan`, `adGroupStatusPlan`, `adStatusPlan`, `searchPartnersPlan`, `addAdGroupsPlan`, `newNegatives`, `newPositiveKeywords`) remains the sole authority on shape, exactly as today. This feature deliberately does **not** tighten that boundary into a stronger zod type — `validate()` already gates every section before any mutation or staging runs, and `applyPlanToBrief` consumes only the *already-computed* typed outputs of those functions (`StatusPlanEntry`, `Keyword[]`, `AdGroupCreatePlanEntry`, etc.), never the raw `Record` sections. Re-parsing the plan into a second schema here would duplicate `plan.ts`'s existing authority rather than strengthen it.
   - **On-disk brief YAML** (`adbriefs/<slug>.yaml`) — parsed through the existing `parseBrief` boundary in `adbriefs/store.ts::loadBriefIfExists` (zod `BriefSchema.parse`), reused as-is. Staging never introduces a second brief parser.
   - **On-disk state YAML** (`adbriefs/<slug>.state.yaml`) — parsed through the existing `adbriefs/state.ts::loadStateIndex` (zod `CampaignStateSchema` via `parseState`), reused as-is. This is the boundary FR-001 relies on for id resolution; it is already a total, once-only parse (a corrupt state file raises `AdbriefsError` naming it, per `state.ts`'s existing contract) — no new parser is needed here, only a new *consumer* of its typed output (`StateIndex`/`StateLocator`/`AdGroupLocator`).
   - **CLI argv** (`string[]`) — unchanged; `--apply` is read in `bin/apply-fixes.ts::main` as today.
2. **Domain types**
   - `Brief` (`lib/schema.ts`) — reused verbatim as the staged-brief type; `applyPlanToBrief`'s return value is a `Brief`, carrying its invariants (15/4 RSA, ≤10 ad groups, unique names) without re-validation, since it is built by transforming an already-valid `Brief`.
   - `StateLocator` / `AdGroupLocator` (`adbriefs/state.ts`) — reused verbatim as the "resolved plan entity" type: a plan id that resolves through `StateIndex.byCampaignId`/`byAdGroupId`/`byAdId` already carries the slug + entity name a staging edit needs. No new "resolved entity" type is introduced — these existing locators are sufficient proof of "this id belongs to this brief."
   - A new **`ResolvedPlanGroup`** type (proposed, in `adbriefs/apply-plan.ts`): `{ slug: string; sections: <per-section subsets of the plan keyed to this slug's entities>; unresolvedIds: Array<{ kind: "campaignId" | "adGroupId" | "adId"; id: string }> }`. This is the type the per-slug grouping step produces: a proof that every id inside `sections` resolved to `slug`, plus an explicit (never silently dropped) list of ids that did not resolve, for that slug's warning/skip reporting (FR-001, FR-008).
   - The already-typed `fixes/plan.ts` outputs (`StatusPlanEntry`, `SearchPartnersPlanEntry`, `AdGroupCreatePlanEntry`, `Keyword[]` from `newNegatives`/`newPositiveKeywords`) are trusted inputs to `applyPlanToBrief` — they are the same values `bin/apply-fixes.ts` already uses to drive the live mutation, so staging can never compute a different change than what actually gets applied.
3. **Parsers**
   - `parseBrief` (`lib/schema.ts`, via `adbriefs/store.ts`) — unchanged, the one brief parser.
   - `parseState` / `loadStateIndex` (`adbriefs/state.ts`) — unchanged, the one state parser and its reverse-index builder.
   - `loadPlan` (`bin/apply-fixes.ts`) — unchanged, the one plan-YAML-to-`FixesPlan` parser; `validate` (`fixes/plan.ts`) remains the one shape authority downstream of it.
   - **`resolvePlanGroups`** (NEW, pure, proposed in `adbriefs/apply-plan.ts`): `(plan: FixesPlan, index: StateIndex) -> ResolvedPlanGroup[]`. Walks every id-bearing plan section, looks each id up in the appropriate `StateIndex` map, and groups by resolved `slug`; ids with no match are collected into that section's owning slug's `unresolvedIds` when a sibling id in the same block *does* resolve, or reported as a standalone "no owning slug" warning when nothing in the campaign resolves at all (the missing-state-file case, FR-008). Pure — no fs/network, single-input→single-output.
   - **`applyPlanToBrief`** (NEW, pure, proposed in `adbriefs/apply-plan.ts`): `(base: Brief, group: ResolvedPlanGroup, computed: <the plan.ts change-lists filtered to this group>) -> Brief`. Mirrors feature 026's `applyPlanToBrief` design (same name, same module family as `store.ts`/`diff.ts`/`state.ts`) but is introduced now because 026 shipped only `create`'s side of the gate. Builds a new `Brief` via spread/`map`: rewrites replace the targeted ad group's `responsiveSearchAd` headlines/descriptions/paths/finalUrl; `appendHeadlines` merges into the existing headline array using the same case-sensitive exact-match dedup `apply-fixes.ts` already uses for the live mutation; negatives/keywords/sitelinks/callouts/budgets/status fields are set from the corresponding computed change-list. A no-op change-list (e.g. all skips) leaves the returned `Brief` structurally/serialization-identical to `base`, so `diffBriefs(base, result).changed === false` (FR-011).
4. **Library choice** — existing dependencies only: `zod` (already used by every parser this feature touches, unchanged), `yaml` (serialize/parse, unchanged). No new dependency; the brief diff continues to use the existing hand-rolled LCS diff in `adbriefs/diff.ts`.

## Complexity Tracking

*No entries — the Constitution Check passed with no violations.*

## Phasing (MVP-first)

- **Phase 1 (US1, P1 — MVP):** `adbriefs/apply-plan.ts` (`resolvePlanGroups` + `applyPlanToBrief`) and the `bin/apply-fixes.ts` wiring to build/load the `StateIndex` once, resolve + group the plan, load each resolved slug's on-disk brief, apply the already-computed change-lists, diff via `diffBriefs`, and print the diff on every run (dry-run included) without writing anything. Independently shippable and testable per the spec's Independent Test: a dry-run against a campaign with brief + state shows a non-empty diff and leaves `adbriefs/` untouched.
- **Phase 2 (US2 + US3, P1, ship together):** wire `--apply` to write the staged brief via the existing `writeBrief` **only after** that slug's live mutation completes successfully (FR-005), and **only for slugs whose mutation succeeded** — a slug whose live mutation fails or partially fails is left with its on-disk brief untouched, and the JSON envelope reports `briefSynced: false` for it plus a loud divergence message (FR-006). These ship together because an apply-writes-brief path with no failure handling would falsely assert a synced state — the spec requires both in the same increment.
- **Phase 3 (US4, P3 — fallback):** the missing-state-file / unresolvable-id degrade path — `resolvePlanGroups` already produces this as a first-class result (not a bolt-on), but this phase is where the envelope fields (`briefStagingSkipped`, `briefStagingSkipReason: "no-state-file" | "unresolvable-id"`) and the explicit stderr warning naming the unresolvable id are wired into `bin/apply-fixes.ts`'s output, and where the "live mutation proceeds exactly as before this feature" regression is verified for campaigns with no state file at all.
- `reference/update.md` and `reference/conventions.md` are updated alongside Phase 1 (the diff-gate description) and Phase 2 (the auto-sync-on-success description), mirroring how feature 026 updated `reference/create.md` alongside its own phases.
