# Implementation Plan: Display RDA combined image cap, quoted plan ids, numeric live status

**Branch**: `084-display-rda-cap-budget-id-status-enum` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/084-display-rda-cap-budget-id-status-enum/spec.md`

## Summary

Three small, independent fixes, each at the single place every caller routes through:

1. **Combined RDA caps** — add a `superRefine` to `ResponsiveDisplayAdSchema` (`src/lib/schema.ts`) enforcing `marketingImages + squareMarketingImages <= 15` and `logoImages + squareLogoImages <= 5`. The per-field `.max` calls go: the combined check subsumes them, and keeping both would print two errors for one cause.
2. **Quoted plan ids** — a pure `normalizePlanIds(raw)` in `src/fixes/plan.ts`, called once from `loadPlan` (`src/bin/apply-fixes.ts`), converts canonical digit-string `campaignId` / `adGroupId` / `adId` values on every section block to numbers. That's the form unquoted YAML ids already take and the key type of every live-state map, so `budgetsErrors` / `getBiddingState` (the two raw-id lookups) and every other section see one id type.
3. **Numeric live status** — `liveCampaignStatuses` / `liveAdGroupStatuses` decode through the existing `enumName(enums.CampaignStatus | enums.AdGroupStatus, …)` from `src/ads/enums.ts`, the same helper the report path uses. The stale comments claiming these fields arrive as strings get corrected.

## Technical Context

**Language/Version**: TypeScript (Node 22), ESM, run via `tsx`

**Primary Dependencies**: zod ^3.24, google-ads-api ^24.1, yaml

**Storage**: N/A

**Testing**: vitest (`npm test` in `skills/adkit/scripts`)

**Target Platform**: CLI (`ads.sh create` / `ads.sh update`)

**Project Type**: single project (CLI scripts package)

**Performance Goals**: N/A

**Constraints**: no new dependencies; no change for already-working plans (unquoted ids, string statuses)

**Scale/Scope**: 3 source files, 3 test files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled `speckit init` template — `constitution_audit.py list` reports zero matched principle headings (same as the 046/048 plans).

**No constitution defined** — there are no principles to check against. The binding conventions live in `CLAUDE.md` (functional style; parse, don't validate) and are honored here. All three changes are pure functions or schema refinements with no new I/O. The id normalization happens once at the plan's parse boundary, so no downstream section re-checks the id type.

## Parse Boundaries

1. **Trust boundaries**
   - *Display brief YAML* (`create`) → `unknown` from the YAML parser, fed straight to `DisplayBriefSchema` (zod). The combined caps now live in that schema, so a parsed `ResponsiveDisplayAd` proves Google will accept its image/logo counts.
   - *Update plan YAML* (`update`) → `yamlParse` output (`unknown`) passes through `normalizePlanIds` inside `loadPlan` before the existing `validate` (zod per-section schemas + guardrail checks) sees it. `normalizePlanIds` is the one place id types are reconciled.
   - *GAQL rows* (`campaign.status`, `ad_group.status`) → SDK values typed `string | number` at the row interface (no longer the false `string`), decoded once in the fetcher with `enumName`; the live status maps hold names only.
2. **Domain types** — `ResponsiveDisplayAd` (zod-inferred; now carries the combined-cap invariant). Plan ids stay `number` after normalization, matching the `Map<number, …>` live-state keys. No new branded types: campaign/ad-group/ad ids already share the numeric map-key convention throughout `apply-fixes.ts`, and branding them would be a broad refactor outside this bug fix.
3. **Parsers**
   - `ResponsiveDisplayAdSchema` (`src/lib/schema.ts`) — zod; throws `ZodError` via `parseAnyBrief`, as today.
   - `normalizePlanIds(raw: unknown): unknown` (`src/fixes/plan.ts`) — a total, pure transform: it never throws, and it leaves anything that isn't a canonical, safe-integer digit string untouched for `validate` to judge.
   - `enumName(table, value)` (`src/ads/enums.ts`, existing) — decodes number or name to a name, `UNKNOWN` for an out-of-range ordinal.
4. **Library choice** — zod (existing dependency) for the brief cap; the SDK's own bidirectional enum tables plus the existing `enumName` helper for status. No new library.

## Design

### Combined caps (schema.ts)

```text
ResponsiveDisplayAdSchema = z.object({... per-field .min / .nonempty only ...}).strict()
  .superRefine: images > 15  → issue at ["marketingImages"]  "marketingImages + squareMarketingImages: at most 15 combined (Google's limit), got N"
                logos  > 5   → issue at ["logoImages"]       "logoImages + squareLogoImages: at most 5 combined (Google's limit), got N"
```

`DisplayBriefSchema` keeps using `z.array(ResponsiveDisplayAdSchema)`; nothing reads `.shape` from it (checked), so wrapping it in `ZodEffects` is safe.

### Id normalization (plan.ts + loadPlan)

- Keys: `campaignId`, `adGroupId`, `adId` on each object element of each array-valued top-level section.
- Convert iff `typeof v === "string"`, `/^[1-9][0-9]*$/`, and `Number.isSafeInteger(Number(v))`.
- Top-level scalars (`customerId`, `mccCustomerId`, `landingUrl`) are untouched.

### Status decode (apply-fixes.ts)

- `CampaignStatusRow.campaign.status` / `AdGroupStatusRow.ad_group.status`: `string | number`.
- `acc.set(id, enumName(enums.CampaignStatus, status) ?? "UNKNOWN")` (and the same with `AdGroupStatus`).

## Project Structure

### Documentation (this feature)

```text
specs/084-display-rda-cap-budget-id-status-enum/
├── spec.md
├── plan.md
├── tasks.md
├── quickstart.md
└── research.md
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── lib/schema.ts            # combined RDA caps
├── lib/schema.test.ts       # (or the existing display-brief test file) cap tests
├── fixes/plan.ts            # normalizePlanIds
├── fixes/plan.test.ts       # normalization + quoted budgets/bidding tests
├── bin/apply-fixes.ts       # loadPlan calls normalizePlanIds; status decode
└── bin/apply-fixes.test.ts  # numeric live status test
```

**Structure Decision**: existing single-package layout; no new files besides spec artifacts.

## Complexity Tracking

No constitution violations — no constitution is defined. No new files or abstractions; every change sits inside an existing function or schema.
