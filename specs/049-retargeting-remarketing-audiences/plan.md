# Implementation Plan: Retargeting/Remarketing Campaign Support

**Branch**: `049-retargeting-remarketing-audiences` | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/049-retargeting-remarketing-audiences/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Adds audience-segment support to adkit end to end: a new `ads.sh audiences`
subcommand (`list` / `create-custom-intent` / `upload-customer-match`), a
`Brief.adGroups[].audienceSegments` schema field attached via
`AdGroupCriterion.user_list`/`.audience`/`.custom_audience` in Google's
observation-safe pattern, a new `"display-remarketing"` `networkSettings`
value that unlocks the Display Network **only** when the campaign has a
non-empty audience segment somewhere in its ad groups (enforced by a
`BriefSchema.superRefine` cross-field check), an `audiences` fixes-lever on
`ads.sh update` mirroring the existing `keywords` lever's add/remove/idempotent
pattern, and an audit-side campaign-channel-type field so `ads.sh audit` can
skip (not misfire) RSA/keyword/ad-strength checks on Display campaigns.

## Technical Context

**Language/Version**: TypeScript 5.7 (Node >=24)

**Primary Dependencies**: `google-ads-api` SDK (`^24.1.0`), `zod`, `yaml`

**Storage**: Adbriefs on disk (`adbriefs/<slug>.yaml`), staged/diffed/written by
the existing `apply-plan.ts` / `store.ts` pipeline — unchanged mechanism;
`audienceSegments` flows through it exactly as `keywords` already does.

**Testing**: vitest — `lib/schema.test.ts` (new `AudienceSegmentSchema` +
`BriefSchema.superRefine` display-remarketing gate), `fixes/plan.test.ts` (new
`audiences` lever validation/idempotency), `bin/apply-fixes.test.ts` (fake
`AdsClient` end-to-end `audiences` mutate runs), `ads/entities.test.ts` (new
`createAudienceSegments`/`buildAudienceSegmentOps`, Display campaign/ad-group
creation), `bin/audiences.test.ts` (new — list/create-custom-intent/
upload-customer-match), `audit/rows.test.ts` + `bin/audit.test.ts` (channel-type
field, Display-campaign check-skipping).

**Target Platform**: Node CLI (`ads.sh audiences` new bin; `ads.sh create` /
`ads.sh update` / `ads.sh audit` extended)

**Project Type**: CLI (single project, `skills/adkit/scripts/`)

**Performance Goals**: N/A — one new GAQL query for `audiences list`, one new
selected field on the existing audit campaign query; no bulk/streaming
concerns.

**Constraints**: Must not change behavior for any existing brief that omits
`audienceSegments` or uses `"search-only"`/`"search-partners-display"`
(FR-004, FR-010, SC-002) — `target_content_network` stays hardcoded `false`
for every `networkSettings` value except the new one. Customer-match upload
must never place a plaintext identifier in a request payload, log line, or
on-disk artifact (FR-003, SC-003) — hashing happens before the SDK boundary,
not inside it. `display-remarketing` must be rejected pre-flight (before any
mutate call) when no ad group carries a non-empty `audienceSegments` (FR-009,
SC-004) — enforced in `BriefSchema.superRefine`, not downstream in `entities.ts`.

**Scale/Scope**: One new bin (`src/bin/audiences.ts`), one new GAQL builder
(`applyAudienceSegmentsQuery` + an `auditCampaignsQuery`/`CampaignRow`
extension), two new `entities.ts` builders (`createAudienceSegments`,
`buildAudienceSegmentOps`) plus parameterizing `createSearchCampaign`/
`createAdGroup`'s hardcoded channel-type values, one new `schema.ts` type
(`AudienceSegmentSchema`) plus two field additions (`AdGroup.audienceSegments`,
a widened `NETWORK_SETTINGS`), one new `fixes/plan.ts` validator
(`audienceSegmentsErrors`) mirroring `keywordsErrors`, one new `apply-fixes.ts`
mutate-loop branch mirroring the existing `keywords` block, and one new
`audit/rows.ts` field (`advertising_channel_type`) consumed by a new guard in
`bin/audit.ts`'s RSA/keyword/ad-strength checks.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled
`speckit init` template — confirmed via
`python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py list`,
which reports zero matched principle headings (same result as the sibling
`046-bid-strategy-edits`/`048-bid-strategy-lever` plans).

**No constitution defined** — there are no real principles to check against.
The repo's actual binding conventions live in `/Users/iam/Code/adkit/CLAUDE.md`
(functional style: pure functions, immutable data, no classes for logic;
parse-don't-validate: parse untrusted input once at the boundary, don't
re-validate downstream) and are honored via the `## Parse Boundaries` section
below: every new validator (`audienceSegmentsErrors`, the `superRefine`
display-remarketing gate) is a pure `(blocks, liveState) -> string[]` /
`(brief) -> issues` function with no I/O, matching the existing
`keywordsErrors`/`budgetsErrors` style; the only new I/O is one new GAQL
query (`applyAudienceSegmentsQuery`, mirroring `applyPositiveKeywordsQuery`)
and the customer-match upload path, which is I/O by nature (a network upload)
but hashes before that boundary, never after.

## Project Structure

### Documentation (this feature)

Under the `spec-minimal` preset, the feature directory contains only:

```text
specs/049-retargeting-remarketing-audiences/
├── spec.md
├── plan.md               # this file — includes the Research and Data Model
│                          #   content that would otherwise live in
│                          #   research.md / data-model.md
├── tasks.md               # Phase 2 output (/speckit-tasks — not this command)
└── checklists/
    └── requirements.md
```

`research.md`, `data-model.md`, and `contracts/` are not created — Phase 0
below folds the (already-completed) research findings inline, and the only
"interface contract" this feature adds is the CLI surface of the new
`ads.sh audiences` subcommand and the widened `Brief`/plan-lever schemas,
both documented in Phase 1 below and in `reference/audiences.md` (a new skill
reference doc, not a spec-kit contract file).

### Source Code (repository root)

```text
skills/adkit/scripts/
├── src/
│   ├── lib/
│   │   ├── schema.ts              # + AudienceSegmentSchema; AdGroupSchema gains
│   │   │                          #   audienceSegments: z.array(AudienceSegmentSchema).default([]);
│   │   │                          #   NETWORK_SETTINGS gains "display-remarketing";
│   │   │                          #   BriefSchema.superRefine gains the
│   │   │                          #   display-remarketing-requires-segments gate
│   │   └── schema.test.ts         # + tests for the new schema field + superRefine gate
│   ├── ads/
│   │   ├── entities.ts            # createSearchCampaign parameterized for Display channel type
│   │   │                          #   (network_settings.target_content_network,
│   │   │                          #   advertising_channel_type); createAdGroup
│   │   │                          #   parameterized for ad_group.type; + createAudienceSegments
│   │   │                          #   (create-path, ad_group_criterion.user_list/.audience) and
│   │   │                          #   + buildAudienceSegmentOps (update-path add/remove,
│   │   │                          #   mirrors buildKeywordOps)
│   │   └── entities.test.ts       # + tests for both new builders + parameterized create paths
│   ├── gaql/
│   │   └── builders.ts            # + applyAudienceSegmentsQuery (mirrors
│   │                               #   applyPositiveKeywordsQuery); auditCampaignsQuery gains
│   │                               #   campaign.advertising_channel_type
│   ├── audit/
│   │   ├── rows.ts                # CampaignRow/ServingRow gain advertising_channel_type
│   │   └── rows.test.ts           # + normalization tests for the new field
│   ├── fixes/
│   │   ├── plan.ts                # + coerceAudienceSegment, segKey identity fn,
│   │   │                          #   newAudienceSegments filter, audienceSegmentsErrors
│   │   │                          #   validator (mirrors keywordsErrors); FAILURE_STEPS
│   │   │                          #   gains "create-audience-segments"
│   │   └── plan.test.ts           # + validator/idempotency tests
│   ├── bin/
│   │   ├── create.ts              # + reads adGroup.audienceSegments post-ad-group-creation,
│   │   │                          #   calls createAudienceSegments; rejects display-remarketing
│   │   │                          #   briefs pre-flight is actually enforced in schema.ts
│   │   │                          #   (superRefine), so create.ts just surfaces the ZodError
│   │   ├── create.test.ts         # + tests for audienceSegments wiring + rejection surfacing
│   │   ├── apply-fixes.ts         # + FixesPlan.audiences key; liveAudienceSegments fetcher
│   │   │                          #   (mirrors livePositiveKeywords); mutate-loop block (mirrors
│   │   │                          #   the "4b) positive keyword edits" block)
│   │   ├── apply-fixes.test.ts    # + end-to-end audiences-lever tests
│   │   ├── audiences.ts           # NEW — list / create-custom-intent / upload-customer-match
│   │   │                          #   subcommand, argv parsing mirrors keyword-ideas.ts,
│   │   │                          #   run-guard mirrors every other bin
│   │   ├── audiences.test.ts      # NEW
│   │   ├── audit.ts               # RSA-count/keyword-inclusion/ad-strength checks (~383-407 and
│   │   │                          #   surrounding scoring calls) gain a Display-channel-type
│   │   │                          #   guard that skips them for Display campaigns
│   │   └── audit.test.ts          # + tests: Display campaign skips search-specific checks,
│   │                              #   Search campaigns unaffected
│   └── lib/
│       └── hash.ts                # NEW — SHA-256 + Google's customer-match normalization
│                                  #   (lowercase/trim email, E.164 phone) — the one place
│                                  #   plaintext identifiers are read and immediately hashed
├── ads.sh                          # case statement gains `audiences)` (line ~23); usage
│                                   #   strings (lines ~5, ~16) updated
└── ../reference/
    ├── audiences.md                # NEW skill reference doc for the subcommand
    ├── create.md                   # networkSettings row + a new audienceSegments row
    └── update.md                   # + `audiences` plan-lever section (mirrors `keywords`)
```

**Structure Decision**: Single project, `skills/adkit/scripts/`. Every change
either widens an existing module in its existing role (schema, entities,
GAQL builders, fixes/plan, apply-fixes, audit) or adds one clearly-scoped new
file per new capability (`bin/audiences.ts` for the subcommand, `lib/hash.ts`
for the hashing boundary) — no new subsystem or package.

### Phase 0: Research

Findings from reading the existing codebase (no `research.md` needed — this is
locating exact extension points in code already read in full):

- **Display Network is a single hardcoded line to change.**
  `createSearchCampaign` (`src/ads/entities.ts:137-177`) sets
  `network_settings.target_content_network: false` unconditionally (line 159,
  documented at 134-135/144-146 as "Display Network is always OFF") and
  `advertising_channel_type: enums.AdvertisingChannelType.SEARCH` (line 149).
  Both need to become conditional on `brief.campaign.networkSettings ===
  "display-remarketing"`. `createAdGroup` (`entities.ts:595-619`) similarly
  hardcodes `type: enums.AdGroupType.SEARCH_STANDARD` (line 609) and needs the
  same conditional. This repo's existing RSA-authoring pipeline (per the
  issue's explicit v1 scope) is reused unchanged — a `display-remarketing`
  campaign still creates Responsive Search Ads, just with Display Network
  enabled and an audience attached, not a new Display-creative ad type.
- **`AdGroupCriterion` vs `CampaignCriterion` is the targeting-vs-observation
  switch, not a boolean flag.** Confirmed against the SDK's bundled protos:
  `AdGroupCriterion.user_list`/`.audience`/`.custom_audience`/
  `.combined_audience` on a Display/Video ad group is true targeting
  (`negative: true` excludes); `CampaignCriterion.user_list`/`.custom_audience`/
  `.combined_audience` on a Search campaign has no restrictive semantics on
  that channel — it functions as an audience **signal** for Smart Bidding
  (`CampaignCriterion` has **no** `audience` oneof member at all — only
  `AdGroupCriterion` does). Given FR-005 ("OBSERVATION mode... bid/report
  visibility only... does not restrict targeting"), and that Story 1's search
  campaigns must stay observation-only while Story 3's `display-remarketing`
  ad groups need real targeting, the design is: **always create the
  `AdGroupCriterion` (never `CampaignCriterion`) for `audienceSegments`**,
  since `AdGroupCriterion` on a *Search* ad group is itself Google's
  documented "audience segment" mechanism and behaves as observation/signal
  there (Search doesn't support ad-group-level audience *restriction* the way
  Display does — the same criterion type's *effect* differs by channel, which
  is exactly the "safe by default, restrictive only where the channel makes it
  so" behavior FR-005 asks for). No separate `restrict`/`targeting-mode` field
  is needed on `AudienceSegmentSchema` for v1 — mode follows channel, matching
  the Clarifications session's "no client-side size/behavior re-implementation
  of what Google already enforces" precedent (spec Edge Cases: audience-size
  validation deferred to Google Ads).
- **`createKeywords` (`entities.ts:662-679`) and `buildKeywordOps`
  (`entities.ts:466-491`) are the exact shape precedents** for
  `createAudienceSegments` (create-path) and `buildAudienceSegmentOps`
  (update-path): same `entity: "ad_group_criterion"` /
  `operation: "create"|"remove"|"update"` / `resource: { ad_group: adGroupRn,
  ... }` shape, swapping `.keyword: {...}` for `.user_list: { user_list: rn }`
  (remarketing/customer-match lists) or `.custom_audience`/`.combined_audience`
  (in-market/affinity/custom-intent — the audience types FR-001's `list`
  command enumerates). `AudienceSegmentSchema` therefore needs an
  `audienceId` (numeric Google Ads audience/user-list ID) — the mutate builder
  resolves the ID to the correct oneof branch via a resource-name lookup done
  in `audiences list`'s output shape (each listed audience already tags its
  `type`), not by asking the brief author to specify the Google-internal oneof
  branch.
- **The `keywords` fixes-lever (`fixes/plan.ts` + `apply-fixes.ts`) is the
  exact precedent for the new `audiences` lever**: `coerceKeyword`
  (`plan.ts:81-102`) → `coerceAudienceSegment`; `posKey`/`keyStr`
  (`plan.ts:110-125`) → a `segKey(audienceId)` identity function (audience
  segments have no match-type axis, so the identity key is simply the numeric
  ID); `livePositiveKeywords` (`apply-fixes.ts:404-422`, backed by
  `applyPositiveKeywordsQuery` in `gaql/builders.ts:683-704`) →
  `liveAudienceSegments` backed by a new `applyAudienceSegmentsQuery` filtering
  `ad_group_criterion` on `type IN (USER_LIST, CUSTOM_AUDIENCE,
  COMBINED_AUDIENCE) AND status != 'REMOVED'`; `newPositiveKeywords`
  (`plan.ts:211-229`) → `newAudienceSegments`; `keywordsErrors`
  (`plan.ts:709-752`, wired into `validate()` at `plan.ts:1003`) →
  `audienceSegmentsErrors` (same "cannot remove — not present live" shape,
  satisfying FR-007's idempotency requirement: re-adding an already-live
  segment is filtered out by `newAudienceSegments` before it ever reaches a
  mutate call, and re-removing an absent one is rejected by
  `audienceSegmentsErrors`, mirroring `rpErrors` at `plan.ts:720-733` — but see
  Phase 1 below for why FR-007 requires the *validator* to treat "already in
  desired end state" as success rather than error, one deliberate deviation
  from the strict `keywords` precedent). The mutate loop
  (`apply-fixes.ts:1216-1240`, "4b) positive keyword edits") is the precedent
  for the new `audiences` block, and `FixesPlan.keywords` (`apply-fixes.ts:496`
  area) is the precedent for a new `FixesPlan.audiences?: Array<Record<string,
  unknown>>` key.
- **The audit path fetches no channel-type field today.**
  `auditCampaignsQuery` (`gaql/builders.ts:369-379`) selects only
  `campaign.id/name/status`; `CampaignRow`/`ServingRow` (`audit/rows.ts:38-40,
  65-75`) carry no channel-type field; `auditAdGroupAdQuery`
  (`gaql/builders.ts:419-441`) hardcodes `ad_group_ad.ad.type =
  'RESPONSIVE_SEARCH_AD'` (line 437); `bin/audit.ts`'s RSA-count check
  (`rsaCountsByAdGroup`/`rsaCountMismatches`, lines ~383-407) has no
  campaign-type guard. FR-011/SC-005 require adding
  `campaign.advertising_channel_type` to `auditCampaignsQuery` and
  `CampaignRow`, then guarding the RSA-count, keyword-inclusion, and
  ad-strength-scoring checks in `bin/audit.ts` on `channelType !== "DISPLAY"`
  (skip entirely per the Clarifications session's answer — no adapted
  display-specific check is built in v1).
- **Dispatch mechanism for the new subcommand**: `ads.sh` is a bash `case`
  statement over filename convention (`ads.sh:20-25,48`) — adding `audiences)`
  to the allowed-subcommand list and creating `src/bin/audiences.ts` (argv
  parsing modeled on `keyword-ideas.ts:63,294`, run-guard modeled on every
  existing bin's `isMainModule(import.meta.url)` pattern) is the entire wiring
  needed; no separate command-registration table exists.
- **Customer-match hashing has no in-SDK helper.** The SDK's
  `common.IUserIdentifier` expects pre-hashed `hashed_email`/
  `hashed_phone_number` strings — hashing is entirely the caller's
  responsibility (Node's built-in `crypto.createHash("sha256")`, no new
  dependency needed). This is the one new file, `src/lib/hash.ts`, so the
  hash-and-normalize step is a named, tested, pure function
  (`hashEmail`, `hashPhone`) rather than inlined in `bin/audiences.ts` where a
  future edit could accidentally log the pre-hash value.
- **No eslint config exists in this package** (`skills/adkit/scripts/`) — only
  `typecheck` and `test` scripts. No new lint gate to satisfy; typecheck +
  vitest are the enforced gates.

### Phase 1: Design

**Schema (`src/lib/schema.ts`)**:

```ts
// New — mirrors KeywordSchema's one-identity-field-plus-strict shape (line 77-83)
export const AudienceSegmentSchema = z
  .object({
    audienceId: z.number().int().gt(0),
  })
  .strict();
export type AudienceSegment = z.infer<typeof AudienceSegmentSchema>;

// NETWORK_SETTINGS (line 175) widened:
export const NETWORK_SETTINGS = [
  "search-only",
  "search-partners-display",
  "display-remarketing",
] as const;

// AdGroupSchema (line 380-398) gains one field:
audienceSegments: z.array(AudienceSegmentSchema).default([]),

// BriefSchema.superRefine (line 415-424) gains a second check alongside the
// existing adGroup-name-uniqueness check:
if (
  b.campaign.networkSettings === "display-remarketing" &&
  !b.adGroups.some((ag) => ag.audienceSegments.length > 0)
) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'campaign.networkSettings "display-remarketing" requires at least one ' +
      "adGroups[].audienceSegments entry",
    path: ["campaign", "networkSettings"],
  });
}
```

This is FR-009's enforcement point — rejection happens at `parseBrief()`,
before `bin/create.ts` ever calls the Google Ads API, satisfying SC-004
("0 `display-remarketing` campaigns are ever created without at least one
attached audience segment... rejected before any API call is made").
FR-004/FR-010/SC-002 (no behavior change for existing briefs) hold because
`audienceSegments` defaults to `[]` and the new `superRefine` branch is only
reachable when `networkSettings === "display-remarketing"`, a value no
existing brief uses.

**Create path (`src/ads/entities.ts`, `src/bin/create.ts`)**:

1. `createSearchCampaign` takes the already-validated `brief.campaign` (whose
   `networkSettings` the schema has already constrained) and branches
   `network_settings.target_content_network` /
   `advertising_channel_type` on `networkSettings === "display-remarketing"`.
2. `createAdGroup` similarly branches `ad_group.type` on the same condition
   (read from the parent campaign, passed down the same way `aiMax` already
   flows from campaign to ad-group creation).
3. After `createKeywords`, `bin/create.ts` calls a new
   `createAudienceSegments(client, customerId, adGroup, adGroupRn)` —
   `AdGroupCriterion.create` ops, one per `audienceSegments` entry, resolving
   `audienceId` to the correct oneof (`user_list`/`custom_audience`/
   `combined_audience`) by resource-name prefix (Google Ads resource names are
   self-describing, e.g. `customers/{id}/userLists/{id}` vs
   `customers/{id}/customAudiences/{id}` — the same disambiguation
   `audiences list` already needs to label each entry's `type`).

**Update path (`src/fixes/plan.ts`, `src/bin/apply-fixes.ts`)**:

New `audiences` plan-lever shape (mirrors `keywords`):

```yaml
audiences:
  - adGroupId: 1789
    add: [123456789]
    remove: [987654321]
```

- `coerceAudienceSegment(item)`: numeric/numeric-string → `{ audienceId:
  Number(item) }` validated against `AudienceSegmentSchema`.
- `segKey(audienceId)`: identity is just the numeric ID (no match-type axis).
- `liveAudienceSegments`: new `applyAudienceSegmentsQuery(adGroupIds)` in
  `gaql/builders.ts`, filtering `ad_group_criterion` on
  `type IN (USER_LIST, CUSTOM_AUDIENCE, COMBINED_AUDIENCE) AND status !=
  'REMOVED'`, reduced into the same `Map<adGroupId, Map<audienceId,
  criterionResourceName>>` shape `livePositiveKeywords` produces.
- `newAudienceSegments`: filters `add` items already live — this is FR-007's
  add-side idempotency (re-adding an already-attached segment is silently
  dropped before any mutate call, not an error).
- `audienceSegmentsErrors`: validates `adGroupId` presence, non-empty
  add/remove, and — the one deliberate deviation from `keywordsErrors`'
  strict `rpErrors` precedent — a `remove` targeting a segment **already
  absent** is treated as a no-op success, not a validation error (FR-007
  requires idempotency in *both* directions: "re-removing one already absent
  MUST NOT error"; `keywordsErrors`' stricter behavior for `remove`/`pause`
  reflects `keywords`' own FR set, which this feature does not inherit).
- Mutate loop: new block in `apply-fixes.ts` mirroring "4b) positive keyword
  edits" (lines 1216-1240), calling `buildAudienceSegmentOps`.
- `FixesPlan.audiences?: Array<Record<string, unknown>>` alongside
  `FixesPlan.keywords`.

**`ads.sh audiences` subcommand (`src/bin/audiences.ts`)**:

- `list [--customer <id>] [--type <in-market|affinity|custom-intent|user-list>]`
  — GAQL against `user_list`/`custom_audience`/`combined_audience`/
  `audience` resources (whichever the SDK's read services expose per Phase 0
  item 8), printing `{ id, name, type }` per row (FR-001). Empty result is a
  valid, non-error empty array (spec Edge Cases).
- `create-custom-intent --keywords <csv> --urls <csv>` — accepts keyword
  and/or URL seeds together in one call (Clarifications: "both... in a single
  call"), calls `CustomInterestService.create` (or `CustomAudienceService`,
  whichever proto maps to "custom-intent" vs "custom-segment" terminology —
  resolved during implementation against the exact enum values Phase 0
  surfaced) (FR-002).
- `upload-customer-match --file <path.csv>` — reads a CSV with `email`/`phone`
  columns (Clarifications: CSV format), maps each row through
  `src/lib/hash.ts`'s `hashEmail`/`hashPhone` (SHA-256, Google's
  lowercase/trim-email and E.164-phone normalization) before constructing any
  `IUserIdentifier`, skips and counts malformed rows (spec Edge Cases: "skipped
  with a clear count... rather than the whole upload failing"), rejects the
  whole upload pre-flight if zero valid rows remain after hashing (spec Edge
  Cases), then drives `OfflineUserDataJobService.createOfflineUserDataJob` →
  `addOfflineUserDataJobOperations` → `runOfflineUserDataJob` (FR-003). No
  plaintext identifier is ever logged: `bin/audiences.ts` only ever holds a
  parsed `{ hashedEmail?, hashedPhone? }` value past the `hash.ts` boundary,
  never the raw CSV cell, in any variable that could reach a log/error
  message.

**Audit path (`src/audit/rows.ts`, `src/gaql/builders.ts`, `src/bin/audit.ts`)**:

- `auditCampaignsQuery` gains `campaign.advertising_channel_type`;
  `CampaignRow`/`ServingRow` gain a normalized `channelType: "SEARCH" |
  "DISPLAY" | ...` field.
- `bin/audit.ts`'s RSA-count check, keyword-inclusion check, and
  ad-strength-scoring calls each gain a guard: skip entirely when
  `channelType === "DISPLAY"` (FR-011, SC-005; per Clarifications, no adapted
  display-specific equivalent in v1 — display-creative authoring itself is
  out of scope).

**Test plan** (extends existing suites, one new suite):

- `lib/schema.test.ts`: `AudienceSegmentSchema` accepts/rejects; `AdGroup`
  parses with/without `audienceSegments` (default `[]`); `BriefSchema`
  rejects `display-remarketing` with no segment anywhere, accepts it with one,
  accepts existing `networkSettings` values unchanged (SC-002).
- `ads/entities.test.ts`: `createSearchCampaign`/`createAdGroup` branch
  correctly on `display-remarketing` vs existing values (Display fields
  unchanged for non-remarketing briefs — SC-002); `createAudienceSegments`
  produces the right `ad_group_criterion` oneof per audience type;
  `buildAudienceSegmentOps` produces correct add/remove op batches.
- `fixes/plan.test.ts`: `audienceSegmentsErrors` — missing `adGroupId`, empty
  add/remove rejected; `remove` of an already-absent segment is NOT an error
  (FR-007); `newAudienceSegments` filters an already-live `add` to empty
  (FR-007, no mutate call — verified at the `apply-fixes.test.ts` level too).
- `bin/apply-fixes.test.ts`: end-to-end fake-`AdsClient` — add produces one
  `ad_group_criterion` create op per new segment; re-running the same add is a
  zero-op no-op; remove produces a remove op; re-running the same remove
  after it's gone is a zero-op no-op (not a thrown error).
- `bin/create.test.ts`: a brief with `audienceSegments` creates the expected
  criteria after ad-group creation; a brief without them behaves identically
  to today (SC-002); a `display-remarketing` brief with no segments is
  rejected before any `client.mutate` call is made (SC-004 — asserted via a
  spy that must see zero mutate invocations).
- `bin/audiences.test.ts` (new): `list` prints `{id,name,type}` rows,
  including an empty-account case; `create-custom-intent` accepts keywords,
  URLs, or both; `upload-customer-match` — a fixture CSV's hashed payload is
  asserted to contain zero plaintext substrings from the input file (SC-003),
  a malformed row is skipped and counted, an all-invalid file is rejected
  pre-flight with zero network calls.
- `audit/rows.test.ts`: `channelType` normalization for `SEARCH`/`DISPLAY`
  raw enum values.
- `bin/audit.test.ts`: a `DISPLAY`-channel campaign's ad groups produce zero
  RSA-count/keyword-inclusion/ad-strength findings; a `SEARCH`-channel
  campaign's checks are unaffected (SC-005).

## Parse Boundaries

This is a TypeScript feature (`skills/adkit/scripts`, `.ts`).

1. **Trust boundaries**:
   - The existing brief-file boundary (`parseBrief`, `schema.ts:428-430`) is
     unchanged in kind — `audienceSegments` and the widened `NETWORK_SETTINGS`
     value flow through the same single `BriefSchema.parse` call; no new
     boundary is introduced for the create path.
   - The existing update-plan YAML boundary (`loadPlan`, parse-only, per the
     `keywords`/`bidding` precedent) gains one more untyped
     `Record<string, unknown>[]` section (`audiences`), parsed the same way
     every other plan-lever section already is — no `any`, kept as
     `unknown`/`Record<string, unknown>` until `coerceAudienceSegment` narrows
     each item.
   - Two genuinely new trust boundaries: (a) the Google Ads API's audience
     *list* response (`audiences list` — third-party SDK response, kept as the
     SDK's own typed proto shape and mapped through a small row-normalizer,
     mirroring how `audit/rows.ts` normalizes raw GAQL rows today, never
     treated as pre-trusted `any`); (b) the customer-match upload CSV file
     (`upload-customer-match --file` — file/CLI input), parsed row-by-row
     through a dedicated CSV-row parser that either yields a validated
     `{ email?: string; phone?: string }` or a per-row skip reason — never a
     bare boolean, never a silent `try/catch` that swallows the row.
2. **Domain types**:
   - `AudienceSegment` (`AudienceSegmentSchema` inference) — the branded-enough
     "one identity field, `.strict()`" shape already used for `Keyword`; an
     `audienceId: number` is not confusable with any other numeric ID in this
     codebase's schema (`campaignId`/`adGroupId`/`adId` are always carried as
     `z.coerce.string()` per the `CampaignStatusChangeSchema`/
     `AdGroupStatusChangeSchema` precedent in the fixes-plan schemas, so
     `audienceId: number` is already distinguishable by type, not just by
     name).
   - A new `HashedIdentifier` domain type (`{ hashedEmail?: string; hashedPhone?:
     string }`) produced only by `lib/hash.ts` — the type itself does not
     prevent misuse (TypeScript has no way to brand "already hashed" against
     "plaintext string" without a nominal wrapper), so the actual guarantee is
     structural: no function outside `lib/hash.ts` ever receives the raw CSV
     string past the boundary — `bin/audiences.ts` calls `hashEmail`/
     `hashPhone` immediately upon reading each row and discards the raw value
     in the same expression (destructure-and-hash, not store-then-hash),
     which is enforced by code review / the constitution-audit scan rather
     than the type system, since Node's `crypto` module returns a plain
     `string` for a hex digest with no library-level branding available.
3. **Parsers**:
   - `BriefSchema.parse` / `parseBrief` (existing, `schema.ts:428-430`) —
     unchanged entry point, now also the parser for `audienceSegments`.
   - `coerceAudienceSegment` (new, `fixes/plan.ts`, mirrors `coerceKeyword`
     lines 81-102) — `(item: unknown) => [AudienceSegment | null, string |
     null]`, the update-plan boundary's parser for one `add` item.
   - A new `parseCustomerMatchRow` (new, `bin/audiences.ts` or a small
     `lib/customer-match-csv.ts` if it grows past a few lines) —
     `(row: Record<string, unknown>) => { ok: true; value: HashedIdentifier } |
     { ok: false; reason: string }`, a discriminated result, never a bare
     boolean, matching the constitution-audit's expected parser shape.
   - A new row-normalizer for the audience `list` response (new, likely
     `audit`-adjacent or inline in `bin/audiences.ts` given its small surface)
     mapping the SDK's raw proto row to `{ id: number; name: string; type:
     string }`.
4. **Library choice**: Zod (already the project's sole schema library) for
   every brief/plan-lever addition — no new schema library introduced. The
   customer-match CSV row parser and the audience-list row normalizer are
   small enough (a handful of fields, no nested unions) that hand-rolled
   parsers matching the existing `coerceKeyword`/row-normalizer idiom are
   preferred over introducing Zod for a one-off CSV shape, consistent with
   "prefer an existing project dependency over new hand-rolled casts" only
   where a schema-library encoding would actually add value — here, the two
   result variants (`ok`/`err`) are simple enough that Zod would add ceremony
   without a real safety gain over the discriminated-union return already
   used by `coerceKeyword`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No constitution violations — no constitution is defined (see Constitution
Check above). Every new file (`bin/audiences.ts`, `lib/hash.ts`) is justified
by a distinct new capability with no existing home (a new CLI subcommand, a
hashing boundary that must stay isolated and testable); every other change
widens an existing function, constant, schema, or query in its existing role,
matching the precedent set by `046-bid-strategy-edits`/`048-bid-strategy-lever`
of extending rather than restructuring.
