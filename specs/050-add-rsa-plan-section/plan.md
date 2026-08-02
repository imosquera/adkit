# Implementation Plan: `addRsa` plan section (add a 2nd RSA to an existing ad group)

**Branch**: `050-add-rsa-plan-section` | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/050-add-rsa-plan-section/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Add a new, optional `addRsa` section to the `ads.sh update` plan schema
(`bin/apply-fixes.ts`) that closes the one documented gap in
`reference/audit.md`'s `rsa_count_mismatch` finding: an ad group live with
fewer than `RSAS_PER_AD_GROUP` (2) non-REMOVED RSAs gets a second, distinct
RSA created **PAUSED**, idempotently (re-running a plan against an ad group
already at 2 is a no-op skip, never a 3rd create). Each `addRsa` block is
`{ adGroupId, headlines[15], descriptions[4], finalUrl?, path1?, path2? }`,
validated with the exact RSA rules `/adkit create`/`rewrites`/`adGroups`
already enforce (reusing `ResponsiveSearchAdSchema` + `normalizeRsa`, not a
new rule set), defaulted/`finalUrl`-resolved against one new live-state fetch
(count + sole existing RSA's `finalUrl` per targeted ad group), mutated via
the existing `createResponsiveSearchAd` entity builder (no new low-level Ads
API code), and staged into the resolved `adbriefs/<slug>.yaml`'s ad group
`responsiveSearchAds` array before write — following the same
validate → live-state fetch → skip-partition → mutate → stage → envelope
pipeline every other plan section (`bidding`, `adGroups`) already uses.

## Technical Context

**Language/Version**: TypeScript 5.7 (Node >=24)

**Primary Dependencies**: `google-ads-api` SDK, `zod`, `yaml`

**Storage**: Adbriefs on disk (`adbriefs/<slug>.yaml`), staged/diffed/written
by the existing `apply-plan.ts` / `store.ts` pipeline — unchanged mechanism;
`addRsa` flows through it as a new case alongside `rewrites`/`appendHeadlines`/
`adGroups`.

**Testing**: vitest — `fixes/plan.test.ts` (pure `addRsaErrors`/`addRsaPlan`
unit tests, mirroring the existing `adGroups validation`/`addAdGroupsPlan`
describe blocks), `bin/apply-fixes.test.ts` (fake-`AdsClient` end-to-end plan
runs, mirroring the existing `adGroups (add-ad-group) path` describe block),
`adbriefs/apply-plan.test.ts` (addRsa staging into a `Brief`'s
`responsiveSearchAds` array, mirroring the existing `adGroups create appends
a new ad group…` tests).

**Target Platform**: Node CLI (`ads.sh update` / `apply-fixes` bin)

**Project Type**: CLI (single project, `skills/adkit/scripts/`)

**Performance Goals**: N/A — one new GAQL query per `update` run, scoped only
to the ad-group ids the plan's `addRsa` blocks reference (empty list ⇒ no
query, same short-circuit every other live-state fetch in `apply-fixes.ts`
already uses, e.g. `liveAdGroupNames`).

**Constraints**: Must never create a 3rd RSA on an ad group that already has
2+ (FR-005/SC-002) — including when two `addRsa` blocks in the same plan
target the same `adGroupId` (spec Edge Cases: the second must be evaluated
against the *post-first-block* count, not the live count both blocks started
from). Must never partially apply an invalid plan (FR-004, dry-run-safe).
Must not touch `RSAS_PER_AD_GROUP`/`BriefSchema`'s exactly-2 requirement
(FR-014) — `addRsa` only ever moves a count from below 2 toward 2.

**Scale/Scope**: One new plan section, one new pure validation function
(`addRsaErrors`), one new pure skip-partition function (`addRsaPlan`), one
new GAQL query builder (`applyRsaCountsQuery`), one new live-state fetch
(`liveRsaState`), one new `ResolvedPlanGroup.sections` array + its
`resolvePlanGroups`/`applyPlanToBrief` wiring, one new mutation loop block in
`bin/apply-fixes.ts` reusing the existing `createResponsiveSearchAd` entity
builder, two new envelope keys, two doc updates
(`reference/update.md`/`reference/audit.md`). No new files, no new schema
library, no new low-level Ads API entity builder.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled
`speckit init` template — confirmed via
`python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py list`,
which reports zero matched principle headings (same result the sibling
`048-bid-strategy-lever` plan recorded).

**No constitution defined** — there are no real principles to check against.
The repo's actual binding conventions live in `/Users/iam/Code/adkit/CLAUDE.md`
(functional style: pure functions, immutable data, no classes for logic;
parse-don't-validate: parse untrusted input once at the boundary, don't
re-validate downstream) and are honored as follows:

- **Functional style**: `addRsaErrors` and `addRsaPlan` (new, `fixes/plan.ts`)
  are pure `(blocks, liveState) -> string[]` / `(blocks, liveState) ->
  [creates, skips]` functions with no I/O and no mutation of their
  arguments — matching the existing `biddingErrors`/`biddingPlan` and
  `adGroupsErrors`/`addAdGroupsPlan` pairs they sit alongside. The
  same-`adGroupId`-twice edge case (a running count that must advance as
  earlier blocks in the same plan are decided) is implemented as a single
  `reduce` that builds a *new* count map per step rather than mutating a
  shared counter — no class, no accumulator pushed into by a `for` loop body.
  `applyPlanToBrief`'s `addRsa` staging extends its existing `adGroups.map`
  return-new-array shape (`{ ...ag, responsiveSearchAds: [...] }`); it never
  pushes into `ag.responsiveSearchAds` in place.
- **Parse, don't validate**: see the `## Parse Boundaries` section below.

## Project Structure

### Documentation (this feature)

Under the `spec-minimal` preset, the feature directory contains only:

```text
specs/050-add-rsa-plan-section/
├── spec.md
├── plan.md               # this file — includes the Research and Data Model
│                          #   content that would otherwise live in
│                          #   research.md / data-model.md
└── tasks.md               # Phase 2 output (/speckit-tasks — not this command)
```

`research.md`, `data-model.md`, and `contracts/` are not created — Phase 0
below folds the (small) research findings inline, and there is no external
interface contract (no new public API surface, only a new internal plan
section and its CLI output).

### Source Code (repository root)

```text
skills/adkit/scripts/
├── src/
│   ├── lib/
│   │   └── schema.ts             # unchanged — RSAS_PER_AD_GROUP and
│   │                              #   ResponsiveSearchAdSchema (already exported)
│   │                              #   are REUSED as-is, not modified (FR-014)
│   ├── fixes/
│   │   ├── plan.ts               # + addRsaErrors (validation, mirrors
│   │   │                          #   adGroupsErrors/rewritesErrors);
│   │   │                          #   + addRsaPlan (create/skip partition,
│   │   │                          #   mirrors addAdGroupsPlan/biddingPlan);
│   │   │                          #   + AddRsaCreatePlanEntry type;
│   │   │                          #   validate() gains an addRsa param
│   │   └── plan.test.ts          # + addRsaErrors / addRsaPlan unit tests
│   ├── gaql/
│   │   └── builders.ts           # + applyRsaCountsQuery(adGroupIds) —
│   │                              #   new builder, apply-family section
│   ├── adbriefs/
│   │   ├── apply-plan.ts         # + ResolvedPlanGroup.sections.addRsa;
│   │   │                          #   + PlanSections.addRsa;
│   │   │                          #   resolvePlanGroups: new byAdGroupId
│   │   │                          #   resolution arm (mirrors `keywords`);
│   │   │                          #   applyPlanToBrief: append the new RSA
│   │   │                          #   into the targeted ad group's
│   │   │                          #   responsiveSearchAds when still <2;
│   │   │                          #   + ApplyPlanComputed.addRsaCreates
│   │   └── apply-plan.test.ts    # + addRsa staging tests
│   ├── ads/
│   │   └── entities.ts           # unchanged — createResponsiveSearchAd
│   │                              #   (already exported) is REUSED as-is
│   └── bin/
│       ├── apply-fixes.ts        # + FixesPlan.addRsa; + liveRsaState()
│       │                          #   live-state fetch; + addRsaChanges/
│       │                          #   addRsaSkips partition call (ahead of
│       │                          #   validate(), mirrors biddingChanges/
│       │                          #   biddingSkips); + mutation loop block
│       │                          #   (reuses createResponsiveSearchAd);
│       │                          #   + addRsaChanges/addRsaSkipped envelope
│       │                          #   keys; plan-shape doc comment updated
│       └── apply-fixes.test.ts   # + end-to-end addRsa create/skip/
│                                   #   validation-failure/failure-isolation
│                                   #   tests
└── ../reference/
    ├── update.md                  # + addRsa paragraph (new bullet, same
    │                              #   style as the existing `adGroups` bullet
    │                              #   at line 106); plan-shape example updated
    └── audit.md                   # line 42 (`rsa_count_mismatch` note)
                                    #   rewritten: under-2 is now fixable via
                                    #   addRsa; 3+ still needs manual UI cleanup
```

**Structure Decision**: Single project, no new files. Every change extends an
existing module in its existing role, following the exact shape of the most
recent comparable addition (`adGroups`, the add-a-whole-ad-group lever) —
this is additive, not a new subsystem.

### Phase 0: Research

Findings from reading the current `fixes/plan.ts`, `gaql/builders.ts`,
`bin/apply-fixes.ts`, `adbriefs/apply-plan.ts`, `lib/schema.ts`,
`ads/entities.ts` (no `research.md` needed — this is locating the right
extension points, not external research):

- **The RSA copy-validation rules already live in one reusable place**:
  `ResponsiveSearchAdSchema` (`lib/schema.ts:333-378`) enforces exactly 15
  headlines (≤30 chars)/4 descriptions (≤90 chars), no duplicate
  headline/description text, and (via `displayPathContentIssues`) the
  `path1`/`path2` content rules — the exact rule set FR-002 requires, with no
  new rule to invent. `fixes/plan.ts`'s `normalizeRsa` (line 866) already
  turns bare-string `headlines`/`descriptions` into the `{text}` shape the
  schema wants (used today by `adGroupsErrors`/`normalizeAdGroup` for the
  `adGroups` section's embedded RSAs) — `addRsa` reuses `normalizeRsa`
  directly, so a plan author writes `headlines: ["...", "..."]` exactly like
  every other section, not `[{text: "..."}]`.
- **`ResponsiveSearchAdSchema.finalUrl` is required, but FR-007's default is
  live-state-dependent** (the target ad group's existing RSA's `finalUrl`),
  so the zod schema alone cannot resolve it — the same reason `biddingErrors`
  (not a schema) has to consult fetched `BiddingLiveState`. The right shape:
  a new pure function `resolveAddRsaFinalUrl(block, liveRsaState)` that
  returns `block.finalUrl ?? liveRsaState.get(adGroupId)?.soleFinalUrl`,
  called by *both* `addRsaErrors` (to decide "no finalUrl and nothing to
  default from ⇒ error") and the mutate/stage steps (so the value actually
  written matches what was validated) — exported from `fixes/plan.ts`
  alongside `addRsaErrors`/`addRsaPlan`, avoiding two independent
  defaulting implementations drifting apart.
- **No existing GAQL query returns "live RSA count + the one existing RSA's
  `finalUrl`, scoped to specific ad-group ids."** `auditAdGroupAdQuery`
  (`gaql/builders.ts:419`) is the closest sibling — same `ad_group_ad`
  resource, same `status != 'REMOVED'` + `ad.type = 'RESPONSIVE_SEARCH_AD'`
  filter `bin/audit.ts`'s `rsa_count_mismatch` finding already uses to define
  "live RSA count" (ENABLED + PAUSED, excludes REMOVED) — but it is scoped
  by `campaign.id`, not `ad_group.id`, and doesn't select `final_urls`. A new
  builder, `applyRsaCountsQuery(adGroupIds)`, is the `inListQuery` factory
  (already used by `applyAdGroupNamesQuery`/`applyPositiveKeywordsQuery`
  etc.) scoped by `ad_group.id IN (...)`, selecting
  `ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls`, with the same
  two conditions `auditAdGroupAdQuery` uses. This keeps the "what counts as
  a live RSA" definition identical between `addRsa`'s skip decision and the
  audit finding it closes (spec Assumptions), without duplicating
  `auditAdGroupAdQuery` itself (different resource scope, different selected
  fields, different call site — a shared factory, not a shared function, is
  the right amount of reuse here, same as `inListQuery` already provides for
  every other apply-family query).
- **The live-state shell function belongs in `bin/apply-fixes.ts` next to its
  siblings** (`liveAdGroupNames`, `liveBiddingGuardState`-equivalent):
  `liveRsaState(client, customerId, adGroupIds): Promise<Map<number, {
  count: number; soleFinalUrl?: string }>>`, built the same
  `rows.reduce(...)` way `liveAdGroupNames` (line 429) already is — grouping
  `applyRsaCountsQuery`'s rows by `ad_group.id`, with `soleFinalUrl` set only
  when the group's count is exactly 1 (unambiguous default; count 0 has
  nothing to default from — FR-007's validation-error edge case; count ≥2 is
  already a skip, so its `finalUrl` is never consulted). Short-circuits to
  an empty `Map` when `addRsa` is absent from the plan, mirroring every
  other live-state fetch's `if (ids.length === 0) return new Map()` guard.
- **The idempotent skip-partition needs to run *before* `validate()`,
  exactly like `biddingPlan`/`biddingChanges`** (`bin/apply-fixes.ts:819`):
  `addRsaPlan(blocks, liveRsaState)` partitions into `[addRsaChanges,
  addRsaSkips]` — a block is a skip when the *current* count for its
  `adGroupId` (starting from live, then incremented once per prior block in
  the same call that resolved to a create for that same `adGroupId` — the
  spec's same-plan-double-target edge case) is already `>=
  RSAS_PER_AD_GROUP`. Implemented as a single left-to-right `reduce` over
  `blocks` that threads a `Map<adGroupId, number>` of running counts
  (seeded from `liveRsaState`) through each step and appends to either the
  `creates` or `skips` array — no shared mutable counter, no class. Only
  `addRsaChanges` is passed into `addRsaErrors`/the mutation loop/staging,
  exactly as only `biddingChanges` reaches `biddingErrors` today — a skip
  never reaches validation-as-a-real-change, the guardrail, or a mutate
  call. (A block that fails `addRsaErrors` for an unrelated reason, e.g. bad
  headline count, is still validated and reported even though it may end up
  a skip post-partition — same ordering `biddingErrors`/`biddingChanges`
  already establish, and the same behavior spec.md's Edge Cases section
  calls for.)
- **The mutation loop reuses `createResponsiveSearchAd` as-is**
  (`ads/entities.ts:628`) — it already takes a single `ResponsiveSearchAd`
  plus an `adGroupRn` and creates it PAUSED (FR-006 is already this
  function's existing behavior, needing zero changes). The new loop block in
  `bin/apply-fixes.ts` (alongside the existing "9) new ad groups" block,
  ~line 1366) is: for each `addRsaChanges` entry, build
  `adGroupRn = customers/${customer}/adGroups/${pyStr(agid)}`, call
  `createResponsiveSearchAd`, and on failure call the existing
  `recordFailure` with `slugsForIds([agid], stateIndex.byAdGroupId)` (FR-008
  — the exact per-block failure-isolation mechanism `keywords`/
  `adGroupStatus`/`searchPartners` already use, keyed by `byAdGroupId`
  because `addRsa` blocks carry `adGroupId`, not `campaignId`).
- **Brief staging (FR-011/FR-012) resolves via the existing `byAdGroupId`
  arm** `resolvePlanGroups` (`adbriefs/apply-plan.ts:190-193`) already uses
  for `keywords` — `addRsa` needs the identical
  `const loc = byAdGroupId(b, "adGroupId"); if (loc)
  groupFor(...).sections.addRsa.push({ adGroupName: loc.adGroupName, block:
  b })` arm (a new `ResolvedAddRsaBlock { adGroupName: string; block:
  Record<string, unknown> }` type, mirroring `ResolvedKeywordsBlock`).
  `applyPlanToBrief`'s existing `adGroups.map` (line 266) gains one more
  `findLast`-style lookup per `ag`: if `group.sections.addRsa` has an entry
  whose `adGroupName === ag.name` AND `ag.responsiveSearchAds.length <
  RSAS_PER_AD_GROUP` AND a matching parsed entry exists in
  `computed.addRsaCreates` (new `ApplyPlanComputed` field, populated from
  `bin/apply-fixes.ts`'s `addRsaChanges`, exactly the way
  `computed.adGroupCreates` is populated from `agCreates` today — the
  already-parsed `ResponsiveSearchAd`, not the raw block, is what gets
  appended, so staging can never diverge from what validation actually
  accepted), append it: `responsiveSearchAds: [...ag.responsiveSearchAds,
  newRsa]`. The `<RSAS_PER_AD_GROUP` re-check here is defense-in-depth
  only (the live-state partition already guarantees `addRsaChanges` only
  contains under-2 targets); it costs nothing and keeps this function's
  invariant self-evident without re-reading `bin/apply-fixes.ts`. Unresolved
  `adGroupId`s fall through to `standalone`/`unresolvedIds` automatically
  (FR-012) — no new code needed there, `byAdGroupId` already pushes to
  `standalone` on a miss.
- **The JSON envelope** (`emitStatusEnvelope`, `bin/apply-fixes.ts:912`)
  gains two keys, `addRsaChanges: addRsaChanges` and `addRsaSkipped:
  addRsaSkips`, inserted next to `biddingChanges`/`biddingSkipped` —
  matching FR-010's "idempotency-reporting pattern" requirement exactly.
  No spend-affecting warning is needed (unlike `bidding`'s
  `bidStrategyChangeAffectsSpend`): every `addRsa` create publishes PAUSED
  (FR-006), so there is no live-spend consequence to surface loudly, same
  as the existing `adGroups` lever's silence on this point.
- **Docs**: `reference/update.md`'s plan-shape comment block (top of
  `bin/apply-fixes.ts`, ~line 28, mirrored in the reference doc) gains an
  `"addRsa": [...]` line next to `"adGroups"`; a new prose bullet (style of
  the existing `adGroups` bullet, `reference/update.md:106`) documents
  fields, the `finalUrl` default, the PAUSED convention, and idempotency.
  `reference/audit.md:42`'s `rsa_count_mismatch` note is rewritten to state
  the under-2 case is now fixable via `addRsa`, while 3+ still needs manual
  UI cleanup (FR-013).

### Phase 1: Design

**Data flow** (new `addRsa` plan section):

1. **Plan format**:
   ```yaml
   addRsa:
     - adGroupId: 178042335678
       headlines: ["<15 distinct-angle headlines>"]
       descriptions: ["<4 distinct-angle descriptions>"]
       finalUrl: "https://www.example.com/ideas/close-assistant"   # optional — defaults from the ad group's existing live RSA
       path1: "demo"    # optional
       path2: "trial"   # optional
   ```
2. **Fetch** (`bin/apply-fixes.ts`, alongside the other live-state fetches
   ~line 798): `liveRsaState(client, customer,
   section(plan, "addRsa").map(b => b.adGroupId))` →
   `Map<number, { count: number; soleFinalUrl?: string }>`, via the new
   `applyRsaCountsQuery` builder.
3. **Partition** (`bin/apply-fixes.ts`, ahead of `validate()`, mirroring the
   existing `biddingPlan` call at line 819): `const [addRsaChanges,
   addRsaSkips] = addRsaPlan(section(plan, "addRsa"), liveRsaState);`
4. **Validate** (`fixes/plan.ts`, new `addRsaErrors`, called from `validate`
   over `addRsaChanges` only — never `addRsaSkips`, mirroring `biddingErrors`
   over `biddingChanges`): for each block —
   - `adGroupId` missing/non-numeric → error (mirrors `keywordsErrors`'
     `agid` check).
   - Resolve `finalUrl` via `resolveAddRsaFinalUrl(block, liveRsaState)`; if
     still `undefined` (block omitted it AND the ad group's live count is 0)
     → error naming the ad group (FR-007's validation-error edge case).
   - Parse `{ headlines: normalizeRsa(block).headlines, descriptions:
     normalizeRsa(block).descriptions, finalUrl: resolvedFinalUrl, path1,
     path2 }` through `ResponsiveSearchAdSchema.safeParse`; every zod issue
     surfaces prefixed `addRsa adGroup <id>: <path>: <message>` (mirrors
     `adGroupsErrors`' issue-prefixing exactly).
5. **Validation failure aborts before any mutation** (FR-004) — same
   `errs.length > 0` early-return `bin/apply-fixes.ts:822` already enforces
   for every section; no new control flow needed.
6. **Mutate** (`bin/apply-fixes.ts`, new loop block alongside "9) new ad
   groups"): for each `addRsaChanges` entry, build the `ResponsiveSearchAd`
   (same construction `addRsaErrors` validated, via
   `resolveAddRsaFinalUrl` + `normalizeRsa` + `ResponsiveSearchAdSchema.parse`
   — computed once, in `addRsaPlan`'s create entries, so validate and mutate
   can never disagree — see `AddRsaCreatePlanEntry` below), call
   `createResponsiveSearchAd(client, customer, rsa, adGroupRn)`, log a
   `+ RSA -> ad group <id>` line, and on failure `recordFailure` (FR-008).
   `addRsaSkips` are logged `already 2/2 RSAs, skipped`.
7. **Staging** (`adbriefs/apply-plan.ts`): `resolvePlanGroups` gains the new
   `byAdGroupId` arm (`sections.addRsa`); `applyPlanToBrief` appends the
   matching `computed.addRsaCreates` entry's parsed RSA onto the targeted ad
   group's `responsiveSearchAds` when still under `RSAS_PER_AD_GROUP`. An
   `addRsa` block whose `adGroupId` doesn't resolve to any brief slug falls
   into `unresolvedIds` (existing standalone-collection code path, FR-012) —
   the live mutation (step 6) still ran; only staging is skipped, surfaced as
   the existing `WARNING: plan references id(s) with no record...` line.
8. **Envelope** (`emitStatusEnvelope`): `addRsaChanges`/`addRsaSkipped` keys
   added, mirroring `biddingChanges`/`biddingSkipped` (FR-010).
9. **Docs**: `reference/update.md` (new `addRsa` bullet + plan-shape
   example line) and `reference/audit.md:42` (rewritten `rsa_count_mismatch`
   note) updated per FR-013.

**New/changed types** (`fixes/plan.ts`):

```ts
export interface AddRsaCreatePlanEntry {
  adGroupId: unknown;
  adGroupRn: (customerId: string) => string; // or plain adGroupId, rn built at the call site — implementer's choice, kept out of plan.ts (no client/customerId there)
  rsa: ResponsiveSearchAd; // already-parsed, already-defaulted
}

export function resolveAddRsaFinalUrl(
  block: Record<string, unknown>,
  liveRsaState: Map<unknown, { count: number; soleFinalUrl?: string }> | Record<string, { count: number; soleFinalUrl?: string }>,
): string | undefined;

export function addRsaErrors(
  blocks: Array<Record<string, unknown>>,
  liveRsaState: Map<unknown, { count: number; soleFinalUrl?: string }> | Record<string, { count: number; soleFinalUrl?: string }>,
): string[];

export function addRsaPlan(
  blocks: Array<Record<string, unknown>>,
  liveRsaState: Map<unknown, { count: number; soleFinalUrl?: string }> | Record<string, { count: number; soleFinalUrl?: string }>,
): [AddRsaCreatePlanEntry[], Array<Record<string, unknown>>]; // [creates, skips]
```

(The exact `AddRsaCreatePlanEntry` shape — whether it carries a raw
`adGroupId` and lets `bin/apply-fixes.ts` build the resource name, versus
something richer — is an implementation-time call for `/speckit-tasks`; the
constraint that matters is that the *parsed, defaulted* `ResponsiveSearchAd`
travels from `addRsaPlan`'s create entry through to both the mutate call and
`computed.addRsaCreates`, never re-parsed or re-defaulted downstream.)

**Test plan**:

- `fixes/plan.test.ts` (new `describe("addRsa validation")` /
  `describe("addRsaPlan")` blocks, mirroring `adGroups validation`/
  `addAdGroupsPlan`): missing/non-numeric `adGroupId`; wrong headline/
  description count; over-length headline/description; duplicate headline/
  description; bad `path1`/`path2`; `finalUrl` omitted with a live count of
  0 (error) vs. 1 (defaults) vs. omitted-and-count-already-≥2 (still a skip,
  so no default is ever needed — but `addRsaErrors` isn't even called on it,
  since only `addRsaChanges` reaches it); same-plan double-target (`SC-002`'s
  edge case) — second block partitions as a skip against the post-first
  count.
- `bin/apply-fixes.test.ts` (new `describe("addRsa (add-2nd-RSA) path")`,
  mirroring `adGroups (add-ad-group) path`): fake-`AdsClient` end-to-end —
  1-live-RSA ad group creates a 2nd PAUSED RSA (SC-001); re-run against a
  2-live-RSA ad group is skipped with zero mutate calls (SC-002); invalid
  block fails validation before any mutate call, alongside a valid block in
  the same plan (SC-003, FR-004); unresolvable `adGroupId` (no live ad
  group at all) is caught per-block via `recordFailure` without aborting
  other blocks (FR-008); dry-run performs zero live mutations regardless of
  outcome (US2 Acceptance Scenario 2).
- `adbriefs/apply-plan.test.ts` (new tests alongside the existing `adGroups
  create appends...` tests): a resolved `addRsa` block stages the new RSA
  onto the targeted ad group's `responsiveSearchAds`, producing a brief that
  re-parses against `BriefSchema` with exactly 2 entries (SC-004); an
  unresolved `adGroupId` produces no brief change and surfaces via
  `unresolvedIds` (FR-012).

## Parse Boundaries

This is a TypeScript feature (`skills/adkit/scripts`, `.ts`).

1. **Trust boundaries**: one new trust boundary at the network edge — the new
   `applyRsaCountsQuery` GAQL read, deserialized the same typed-row way every
   other `client.searchStructured<Row>(...)` call in `bin/apply-fixes.ts`
   already is (e.g. `liveAdGroupNames`'s `AdGroupNameRow`). The update-plan
   YAML boundary itself is unchanged (`loadPlan`, parse-only) — `addRsa`
   blocks stay untyped `Record<string, unknown>` at that boundary, exactly
   like `rewrites`/`adGroups`/`bidding` today; `validate()` remains the sole
   authority that turns a raw block into "safe to mutate."
2. **Domain types**: no new branded/domain type. The `ResponsiveSearchAd`
   type (already exported by `lib/schema.ts`) is the single point where an
   `addRsa` block's copy becomes a trusted value — `addRsaErrors`/
   `addRsaPlan` parse it via `ResponsiveSearchAdSchema.safeParse`/`.parse`
   exactly once, and every downstream consumer (the mutate call, the brief
   staging) is handed that already-parsed value (via
   `AddRsaCreatePlanEntry.rsa` / `computed.addRsaCreates`), never the raw
   block again — no re-validation of headline/description length or
   `finalUrl`-ness downstream (the "don't re-check what parsing already
   established" rule this repo's CLAUDE.md calls out explicitly). The one
   new small parse this feature adds, `resolveAddRsaFinalUrl`, deliberately
   returns `string | undefined` (not yet a `Brief`-shaped `finalUrl`) —
   its result feeds directly into the *single* `ResponsiveSearchAdSchema`
   parse in step 4 above, so "is this URL valid/present" is still checked
   exactly once, at that one parse, not twice.
3. **Parsers**: `ResponsiveSearchAdSchema` (existing, reused) is the parser
   for RSA copy; `parseBrief`/`BriefSchema` (existing, unchanged) remains the
   single parse step that turns the proposed brief (now possibly carrying
   one more `responsiveSearchAds` entry) into a trusted value before write —
   `stageResolvedGroups` already re-parses every proposed brief through
   `parseBrief` (line 646) regardless of which section changed it, so
   `addRsa`'s staged result is validated by the exact same mechanism
   `adGroups`/`rewrites`/`bidding` staging already goes through, with zero
   new code there.
4. **Library choice**: N/A — no new schema library. `addRsaErrors`/
   `addRsaPlan`/`resolveAddRsaFinalUrl` are plain functional code (pure
   functions, a `reduce` for the running-count partition, no mutation, no
   class), matching the existing `biddingErrors`/`addAdGroupsPlan` style
   they sit beside.

**Scanner run**: `python3 .specify/presets/parse-dont-validate/scripts/python/parse_dont_validate.py scan <files>`
was run (from `skills/adkit/scripts`, after `npm install` to make the
project's `typescript` package resolvable — the scanner shells out to the TS
Compiler API and refuses to run without it) against every file this feature
touches: `src/fixes/plan.ts`, `src/gaql/builders.ts`, `src/bin/apply-fixes.ts`,
`src/adbriefs/apply-plan.ts`, `src/lib/schema.ts`, `src/ads/entities.ts`. It
reported 12 findings, all on lines that predate this feature (e.g.
`isDigitString`/`isSameHeadline`/`isSkip` boolean helpers flagged as PDV003,
`as const`/`as Iterable<unknown>` casts flagged as PDV004) — none are in code
this plan adds or changes; they are the current, already-shipped baseline in
files this feature happens to also touch. Nothing here requires a design
change: the new functions this plan introduces (`addRsaErrors`, `addRsaPlan`,
`resolveAddRsaFinalUrl`) follow the same shapes as their siblings that
*already* trip these same rule categories (e.g. `addRsaPlan`'s internal
`isSkip`-style predicate will likely earn the same PDV003 the existing
`biddingPlan`'s `isSkip` (line 691) already does) — consistent with the
existing, accepted pattern in this codebase rather than a new anti-pattern,
and no waiver comment is warranted beyond what the existing siblings would
also warrant (none are currently waived either — this preset's gate is
evidently not yet enforced as a hard blocker on this repo's existing code,
only informative here).

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No constitution violations — no constitution is defined (see Constitution
Check above). No new files or abstractions are introduced beyond one new
small helper (`resolveAddRsaFinalUrl`) needed because, uniquely among this
feature's siblings, `finalUrl` defaulting depends on live state rather than
being either fully optional or fully required; every other change widens an
existing function, constant, or envelope in its existing role, following the
`adGroups`/`bidding` precedent exactly.
