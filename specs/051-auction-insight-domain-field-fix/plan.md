# Implementation Plan: Fix Auction Insights query rejection on v24 and surface real fetch errors

**Branch**: `051-auction-insight-domain-field-fix` | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/051-auction-insight-domain-field-fix/spec.md`

## Summary

`auctionInsightDomainQuery` / `auctionInsightDomainPriorWindowQuery`
(`skills/adkit/scripts/src/gaql/builders.ts`) issue `FROM auction_insight_domain`
selecting `auction_insight_domain.domain` — a resource/field shape that no longer
exists on the pinned Google Ads API v24. Confirmed against Google's own v24 proto
definitions (see Research Notes): the domain moved to a `segments` field,
`segments.auction_insight_domain`, queried `FROM campaign` alongside the unchanged
`metrics.auction_insight_search_*` fields. The fix repoints both builders at that
shape, follows the row-shape change through `RawAuctionInsightRow`
(`src/audit/rows.ts`) and the one other reader of the old shape
(`campaignPriorAuctionInsights` in `audit.ts`), and — since `campaignAuctionInsights`
/`campaignPriorAuctionInsights` currently have **no** try/catch guard at their call
site in `runAudit` (contrary to the issue's description of an existing-but-broken
catch, which does not match this branch's current code) — adds one, using the
codebase's existing `formatGoogleAdsError` helper (`src/ads/errors.ts`, already
imported in `audit.ts`) so a future rejection prints the real Ads API error instead
of `(undefined)`.

## Technical Context

**Language/Version**: TypeScript (Node.js), compiled with `tsc`, run via `tsx`/Node ESM.

**Primary Dependencies**: `google-ads-api` v24 client (query builders are pure,
no direct SDK import), `vitest` (test runner) — no new dependencies.

**Storage**: N/A — no persistence; this is an in-memory query/mapping fix inside a
single audit run.

**Testing**: `vitest` — existing `skills/adkit/scripts/src/gaql/builders.test.ts`
(golden-GAQL-string coverage for both builders), `src/bin/audit.test.ts`
(`campaignAuctionInsights` grouping/new-competitor coverage), and
`src/audit/rows.test.ts` (`normalizeAuctionInsightRow` coverage) — all update their
fixture row shapes; no new test files.

**Target Platform**: Node.js CLI (`ads.sh audit` / `/adkit audit`), same as today.

**Project Type**: CLI tool (single project) — `skills/adkit/scripts/`.

**Performance Goals**: N/A — one query's FROM/field shape and one guard clause;
no measurable performance impact.

**Constraints**: Must not change the `losing_to_competitor` / `new_competitor`
comparison logic (`newCompetitorDomains`, `withAuctionInsightFindings`), only the
data reaching it. No live Google Ads v24 credentials available in this run for
end-to-end verification against a real account (per Stop-condition guidance, this
is a recoverable gap, not a blocker) — unit tests plus the golden GAQL string are
the verification method, consistent with how issue #44's enum fix was verified.

**Scale/Scope**: Two query builders, one row type + its normalizer, one call site
in `audit.ts` gaining a try/catch, and their existing test fixtures. No new files,
no new public API surface.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled `speckit
init` template (placeholder tokens like `[PRINCIPLE_1_NAME]` throughout, no
headings matching `## I. Name` / `### Principle N: Name`) — confirmed by running
`constitution_audit.py list`, which reports "No principle headings matched in
.specify/memory/constitution.md."

No constitution defined.

## Project Structure

### Documentation (this feature)

```text
specs/051-auction-insight-domain-field-fix/
├── plan.md              # This file — includes research + data model + parse boundaries inline
├── spec.md              # Feature specification
├── tasks.md             # Phase 2 output (/speckit-tasks command)
└── checklists/
    └── requirements.md  # Spec quality checklist
```

(`research.md`, `data-model.md`, and `contracts/` are intentionally not created —
their content is folded into this file's Research Notes and Data Model sections
below, per this preset's minimal-artifact-tree rule. `checklists/requirements.md`
also exists, per `/speckit-specify`'s own mandatory checklist step;
`verify-minimal-tree.sh` flags it as "not in allowed set" since it only allows a
top-level `requirements.md`, not a `checklists/` directory — this is a pre-existing
mismatch between two speckit presets, reproduced identically on every prior
feature in this repo, e.g. `specs/044-psi-enum-string-mismatch/checklists/`, none
of which blocked those features from shipping.)

### Source Code (repository root)

```text
skills/adkit/scripts/
├── src/
│   ├── gaql/
│   │   ├── builders.ts             # auctionInsightDomainQuery / auctionInsightDomainPriorWindowQuery — FROM campaign, segments.auction_insight_domain
│   │   └── builders.test.ts        # golden GAQL strings + .fields assertion updated to the new shape
│   ├── audit/
│   │   ├── rows.ts                 # RawAuctionInsightRow — auction_insight_domain.domain -> segments.auction_insight_domain; normalizeAuctionInsightRow updated
│   │   └── rows.test.ts            # fixture rows updated to the new nested shape
│   └── bin/
│       ├── audit.ts                # campaignPriorAuctionInsights's r.auction_insight_domain.domain -> r.segments.auction_insight_domain; new try/catch around the two auction-insight fetches in runAudit, using the already-imported formatGoogleAdsError
│       └── audit.test.ts           # fixture rows updated; new case for the catch's degrade-and-log behavior
└── (no new files, no new dependencies)
```

**Structure Decision**: Single existing CLI project (`skills/adkit/scripts/`). No
new packages, no new top-level directories — this is a same-file, same-module bug
fix that follows one row-shape change through its three existing readers.

## Research Notes (Phase 0)

No open unknowns remain — the exact v24 field shape was resolved by reading
Google's own generated API definitions rather than guessing:

- **Decision**: Select `segments.auction_insight_domain` `FROM campaign` (instead
  of `auction_insight_domain.domain` `FROM auction_insight_domain`), keeping every
  existing `metrics.auction_insight_search_*` field unchanged.
  **Rationale**: Confirmed directly against `googleads/google-ads-dotnet`'s
  generated v24 sources: `AuctionInsightDomain` does not exist as a standalone
  resource/message anywhere in the V21–V25 folders of that repo (a GitHub code
  search across those version directories returns nothing), while
  `Segments.g.cs` in `V24` defines field #145,
  `public string AuctionInsightDomain { ... }` — doc comment "Domain (visible
  URL) of a participant in the Auction Insights report." — as a field on the
  shared `Segments` message, which `campaign` (like most report-style resources)
  carries. `Metrics.g.cs` in the same `V24` tree still defines
  `AuctionInsightSearchImpressionShare` / `...OutrankingShare` /
  `...OverlapRate` / `...PositionAboveRate` /
  `...AbsoluteTopImpressionPercentage` unchanged, so only the domain's field path
  moved — the metrics selection list needs no change.
  **Alternatives considered**: Guessing at a renamed resource (e.g.
  `auction_insight_domain_view`) — rejected once the dotnet source confirmed no
  such resource exists in v24 at all; segments-based domain, `FROM campaign`, is
  a documented pattern independently corroborated by a public GAQL example
  (`SELECT campaign.id, campaign.name, ..., metrics.auction_insight_search_impression_share,
  segments.auction_insight_domain FROM campaign`).
- **Decision**: Both `auctionInsightDomainQuery` (current window, full metrics)
  and `auctionInsightDomainPriorWindowQuery` (prior window, domain-only) move to
  the same `FROM campaign` / `segments.auction_insight_domain` shape, keeping
  their existing scope difference (metrics vs. no metrics) unchanged.
  **Rationale**: FR-002/FR-003 — the `new_competitor` check diffs their two
  outputs against each other by domain; if only one builder moved, the
  comparison would break in a new way. **Alternatives considered**: None — this
  is dictated by the pair's existing contract with `newCompetitorDomains`.
- **Decision**: Guard the two auction-insight fetches (`campaignAuctionInsights`,
  `campaignPriorAuctionInsights`) with a try/catch in `runAudit` (`audit.ts`,
  around where `auctionInsightsMap`/`priorDomainsMap` are currently assigned
  unguarded), degrading both to empty (`{}` / `{}`) on failure and logging via
  the codebase's existing `formatGoogleAdsError(err)` (`src/ads/errors.ts`,
  already imported in `audit.ts`), rather than adding a bespoke
  `(err as Error).message`-based catch.
  **Rationale**: `formatGoogleAdsError` already does exactly what FR-005/FR-006
  ask for in one call: it unwraps a `GoogleAdsFailure`'s `errors[]` array into a
  concise `<error_code>: <message> (at <field.path>)` string when present, and
  falls back to `<Name>: <exc>` for any non-Ads throwable — so reusing it avoids
  a second, parallel error-formatting implementation for the exact same problem
  this codebase already solved (it's used identically in `create.ts` and
  `apply-fixes.ts`). Note the issue's own text describes a try/catch already
  present at `audit.ts:1265-1281` printing `(undefined)`; reading this branch's
  current `runAudit`, no such catch exists around this call site today — the two
  calls are unguarded, so any query rejection currently propagates uncaught to
  the top-level `main()` handler instead of degrading. The fix (add the guard,
  using `formatGoogleAdsError`) satisfies the same intent either way: the audit
  must not crash on this fetch, and any future rejection must be diagnosable
  from the printed line.
  **Alternatives considered**: A bespoke `(err as Error).message` catch with a
  manual `errors[]` fallback — rejected as a duplicate of `formatGoogleAdsError`
  that this codebase would then have two divergent copies of.
- **Decision**: The warning line uses the existing `emitLines`/`WARNING:` idiom
  from the rest of `audit.ts` / `apply-fixes.ts`
  (`emitLines([\`WARNING: auction insights unavailable, skipping (${formatGoogleAdsError(err)})\`])`),
  written to stderr, not stdout. **Rationale**: Matches every other warning in
  this CLI (`apply-fixes.ts`'s `WARNING: ...` lines) and keeps stdout's JSON
  output clean for piping, per this file's own existing comment convention
  (`// human summary -> stderr (stdout stays clean JSON for piping)`).

No `NEEDS CLARIFICATION` markers remain in Technical Context above.

## Data Model (Phase 1)

No new entities. One existing type's shape moves to match the corrected wire
format:

- **`RawAuctionInsightRow`** (`skills/adkit/scripts/src/audit/rows.ts`) —
  `auction_insight_domain: { domain: string }` becomes
  `segments: { auction_insight_domain: string }`, reflecting the field's actual
  v24 location (a flat string on `segments`, not a nested resource object). The
  `metrics?` sub-shape (all five `auction_insight_search_*` fields) is unchanged.
- **`AuctionInsightRow`** (`skills/adkit/scripts/src/audit/types.ts`) —
  unchanged. It remains the trusted, already-flat output shape
  (`{ campaignId, domain, impressionShare, ... }`) that
  `normalizeAuctionInsightRow` produces; only the raw input it reads from moves,
  not the parsed output type or its callers (`withAuctionInsightFindings`,
  `renderAuctionInsights`, `auctionInsightsByCampaign`).
- **`campaignPriorAuctionInsights`'s inline row reducer** (`audit.ts`) reads
  `r.auction_insight_domain.domain` today; it moves to
  `r.segments.auction_insight_domain` in lockstep with `RawAuctionInsightRow`,
  since it consumes the same raw row type via `search<RawAuctionInsightRow>`.

No API contracts change — `campaignAuctionInsights` and
`campaignPriorAuctionInsights`'s exported signatures are unchanged; only the
wire shape they parse, and the query they issue to get it, are corrected. No
`contracts/` artifact applies (internal CLI functions, not an external
interface).

## Parse Boundaries

This is a TypeScript feature, so this section is substantive (not N/A).

1. **Trust boundary**: The Google Ads API response for the Auction Insights
   query (`auctionInsightDomainQuery` / `auctionInsightDomainPriorWindowQuery`),
   reaching `campaignAuctionInsights` / `campaignPriorAuctionInsights` in
   `audit.ts` via `search<RawAuctionInsightRow>(client, customerId, ...)`. The
   untrusted input this feature concerns itself with is the row's domain field
   location — the client library's generic `search<T>()` performs no runtime
   validation, so the wire value is only as trustworthy as the declared
   `RawAuctionInsightRow` type, which this fix corrects from an
   already-incorrect claim (`auction_insight_domain.domain`, a shape v24 never
   sends) to the true shape (`segments.auction_insight_domain`).
2. **Domain type**: `AuctionInsightRow.domain: string`
   (`scripts/src/audit/types.ts`) — already the precise, trusted flat string the
   rest of the audit (`newCompetitorDomains`, `withAuctionInsightFindings`,
   `renderAuctionInsights`) is entitled to assume is a bare domain name. No new
   brand is introduced: a domain string has no structural invariant this
   codebase enforces beyond "some string" (consistent with how `psi_api_key`
   and other free-form strings were left unbranded in prior plans) — introducing
   a branded `Domain` type here would be unwarranted ceremony for a one-field
   rename (YAGNI).
3. **Parser**: `normalizeAuctionInsightRow` (`scripts/src/audit/rows.ts`,
   existing function, unchanged in kind — only its one field access moves) plus
   the new inline field access in `campaignPriorAuctionInsights`'s reducer
   (`audit.ts`). Neither is a discriminated `Result`-returning parser: every
   `RawAuctionInsightRow` maps to a defined `AuctionInsightRow` (metrics
   zero-fill via the existing `zeroFillMetrics` helper covers missing metrics;
   the domain field itself is a required, always-present string on a
   successfully-returned row) — there is no failure mode internal to the
   mapping itself to report. The genuine failure mode (the whole query being
   rejected) is handled one layer up, by the new try/catch in `runAudit`, not by
   the row parser.
4. **Library choice**: Hand-rolled destructuring — a one-field rename inside an
   existing pure mapping function. No new dependency; `zod` (already a project
   dependency, used in `psi.ts`) is reserved in this codebase for boundaries
   with genuine structural uncertainty (arbitrary third-party JSON), not a
   single, already-typed SDK response field whose shape is fixed by Google's
   own proto contract.
5. **Failure boundary (new)**: The try/catch added around the
   `campaignAuctionInsights` / `campaignPriorAuctionInsights` calls in
   `runAudit` is itself a parse-adjacent boundary decision: on any thrown error,
   both maps degrade to `{}` (matching every other campaign-keyed map's
   already-established "absent means no data" convention in this same function,
   e.g. `auctionInsightsMap[sc.campaignId] ?? []`), and the diagnostic is
   produced by `formatGoogleAdsError` — an existing, already-tested boundary
   formatter — rather than a new one-off implementation.

## Complexity Tracking

*No Constitution Check violations — table intentionally omitted.*
