# Tasks: Retargeting/Remarketing Campaign Support

**Input**: Design documents from `specs/049-retargeting-remarketing-audiences/` (`plan.md`, `spec.md`)

**Prerequisites**: `plan.md` (required), `spec.md` (required for user stories)

**Tests**: Included — the source issue and spec's Success Criteria (SC-001..SC-005) require verifiable behavior (idempotency, zero-plaintext, pre-flight rejection), so every story includes test tasks alongside implementation.

**Organization**: Tasks are grouped by user story (spec.md) to enable independent implementation and testing of each story. Every file path is exact, per `plan.md`'s Project Structure section.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files or non-overlapping regions, no dependency ordering)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)

## Phase 1: Setup

**Purpose**: Register the new subcommand's entry points before any story-specific logic exists.

- [x] T001 Add `audiences)` to the `case` statement in `skills/adkit/scripts/ads.sh` (alongside the existing `init|preflight|create|keyword-ideas|research|report|audit|render-yaml|bootstrap-secrets` list, ~line 23) and update the usage strings (~lines 5, 16).
- [x] T002 [P] Scaffold `skills/adkit/scripts/src/bin/audiences.ts`: `parseArgs(argv)` skeleton (modeled on `keyword-ideas.ts:63`) recognizing the `list` / `create-custom-intent` / `upload-customer-match` subcommands (bodies stubbed, to be filled in Phases 3/6), `main(argv = process.argv.slice(2))` entry (modeled on `keyword-ideas.ts:294`), and the standard `isMainModule(import.meta.url)` run-guard every other bin uses.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the schema type, entity builders, and GAQL query that every user story depends on, before any story-specific wiring.

- [x] T003 Add `AudienceSegmentSchema` to `skills/adkit/scripts/src/lib/schema.ts` — `z.object({ audienceId: z.number().int().gt(0) }).strict()`, mirroring `KeywordSchema` (lines 77-83); export `AudienceSegment` type.
- [x] T004 Add `audienceSegments: z.array(AudienceSegmentSchema).default([])` to `AdGroupSchema` in `skills/adkit/scripts/src/lib/schema.ts` (lines 380-398) (depends on T003).
- [x] T005 Widen `NETWORK_SETTINGS` in `skills/adkit/scripts/src/lib/schema.ts` (line 175) from `["search-only", "search-partners-display"]` to include `"display-remarketing"`.
- [x] T006 Add `createAudienceSegments(client, customerId, adGroup, adGroupRn)` in `skills/adkit/scripts/src/ads/entities.ts` — create-path builder mirroring `createKeywords` (lines 662-679), producing `ad_group_criterion` create ops with `.user_list`/`.custom_audience`/`.combined_audience` resolved by resource-name prefix per `audienceId` (depends on T003).
- [x] T007 Add `buildAudienceSegmentOps(adGroupRn, adds, removeResources)` in `skills/adkit/scripts/src/ads/entities.ts` — update-path builder mirroring `buildKeywordOps` (lines 466-491), for add/remove `ad_group_criterion` ops (depends on T003).
- [x] T008 Add `applyAudienceSegmentsQuery(adGroupIds)` in `skills/adkit/scripts/src/gaql/builders.ts` — mirrors `applyPositiveKeywordsQuery` (lines 683-704), filtering `ad_group_criterion` on `type IN (USER_LIST, CUSTOM_AUDIENCE, COMBINED_AUDIENCE) AND status != 'REMOVED'` (depends on T003).
- [x] T009 Add `campaign.advertising_channel_type` to `auditCampaignsQuery` in `skills/adkit/scripts/src/gaql/builders.ts` (lines 369-379), and a normalized `channelType: "SEARCH" | "DISPLAY" | ...` field to `CampaignRow`/`ServingRow` in `skills/adkit/scripts/src/audit/rows.ts` (lines 38-40, 65-75).

**Checkpoint**: Schema, entity builders, and GAQL primitives exist. No story is wired yet — every user story below builds on this foundation.

---

## Phase 3: User Story 1 - Attach an existing remarketing/customer-match audience to a new campaign (Priority: P1) 🎯 MVP

**Goal**: An advertiser can list available audiences and attach one to a new ad group via a brief, in OBSERVATION mode, with zero behavior change for briefs that don't use it.

**Independent Test**: Run `ads.sh audiences list`, add an `audienceSegments` entry to an ad group in a brief, run `ads.sh create`, confirm the ad group carries an OBSERVATION-mode audience criterion — with no change to any other ad group's targeting.

- [x] T010 [P] [US1] Implement `audiences list` in `skills/adkit/scripts/src/bin/audiences.ts`: GAQL against `user_list`/`custom_audience`/`combined_audience` resources, printing `{ id, name, type }` per row; an account with zero audiences returns a valid empty array, not an error (depends on T002).
- [x] T011 [US1] Wire `skills/adkit/scripts/src/bin/create.ts` to call `createAudienceSegments` for each ad group's `audienceSegments` entries, immediately after the existing `createKeywords` call (depends on T006).
- [x] T012 [P] [US1] Unit tests in `skills/adkit/scripts/src/lib/schema.test.ts`: `AudienceSegmentSchema` accepts a valid `audienceId`, rejects a non-positive/non-integer one; `AdGroupSchema` parses with `audienceSegments` omitted (defaults to `[]`) and with entries present (depends on T003, T004).
- [x] T013 [P] [US1] Unit tests in `skills/adkit/scripts/src/ads/entities.test.ts`: `createAudienceSegments` produces the correct `ad_group_criterion` create op (resource shape) for each audience type (depends on T006).
- [x] T014 [US1] End-to-end test in `skills/adkit/scripts/src/bin/create.test.ts`: a brief with `audienceSegments` creates the expected criteria after ad-group creation; a brief without them behaves identically to today, byte-for-byte in the resulting mutate ops (SC-002) (depends on T011).
- [x] T015 [P] [US1] Tests in `skills/adkit/scripts/src/bin/audiences.test.ts`: `list` prints `{id,name,type}` rows including the empty-account case (depends on T010).
- [x] T016 [P] [US1] Write `skills/adkit/reference/audiences.md` (new skill reference doc) covering the `list` subcommand, and add an `audienceSegments` row to the `campaign.networkSettings` table area of `skills/adkit/reference/create.md` (depends on T010, T011).

**Checkpoint**: US1 is independently functional — an advertiser can attach an existing audience to a new campaign in observation mode. This is the MVP slice.

---

## Phase 4: User Story 2 - Attach or detach audiences on an existing live ad group (Priority: P2)

**Goal**: `ads.sh update` supports an `audiences` plan lever (add/remove), staged diff-before-apply, fully idempotent in both directions.

**Independent Test**: Stage an `audiences` update plan against a live ad group, confirm the diff preview before applying, confirm a second identical run is a no-op, confirm removing an already-absent segment is also a no-op (not an error).

- [x] T017 [US2] Add `coerceAudienceSegment(item)` and a `segKey(audienceId)` identity function in `skills/adkit/scripts/src/fixes/plan.ts`, mirroring `coerceKeyword`/`posKey` (lines 81-102, 110-112) — identity is the bare numeric ID (no match-type axis) (depends on T003).
- [x] T018 [US2] Add `newAudienceSegments(group, liveAudienceSegments)` filter in `skills/adkit/scripts/src/fixes/plan.ts`, mirroring `newPositiveKeywords` (lines 211-229) (depends on T017).
- [x] T019 [US2] Add `audienceSegmentsErrors(audienceBlocks, liveAudienceSegments)` validator in `skills/adkit/scripts/src/fixes/plan.ts`, mirroring `keywordsErrors` (lines 709-752) and wired into `validate()` (line ~1003) — **deviates from the `keywords` precedent**: a `remove` targeting an already-absent segment is a no-op, not a validation error (FR-007 requires bidirectional idempotency) (depends on T017).
- [x] T020 [US2] Add `liveAudienceSegments(client, customerId, adGroupIds)` fetcher in `skills/adkit/scripts/src/bin/apply-fixes.ts`, mirroring `livePositiveKeywords` (lines 404-422), backed by `applyAudienceSegmentsQuery` (depends on T008).
- [x] T021 [US2] Add a `FixesPlan.audiences?: Array<Record<string, unknown>>` key and a new mutate-loop block in `skills/adkit/scripts/src/bin/apply-fixes.ts`, mirroring the "4b) positive keyword edits" block (lines 1216-1240): compute adds via `newAudienceSegments`, resolve removes to resource names via the live map, call `buildAudienceSegmentOps`, `client.mutate`, log a summary line, and route failures through `recordFailure` (depends on T007, T018, T019, T020).
- [x] T022 [P] [US2] Unit tests in `skills/adkit/scripts/src/fixes/plan.test.ts`: `audienceSegmentsErrors` rejects missing `adGroupId`/empty add+remove, but treats `remove` of an already-absent segment as success (FR-007); `newAudienceSegments` filters an already-live `add` to empty (depends on T018, T019).
- [x] T023 [US2] End-to-end tests in `skills/adkit/scripts/src/bin/apply-fixes.test.ts` against a fake `AdsClient`: `add` produces one create op per new segment; re-running the identical `add` is a zero-op no-op; `remove` produces a remove op; re-running the same `remove` after it's already gone is a zero-op no-op (not a thrown error) (depends on T021).
- [x] T024 [P] [US2] Add an `audiences` plan-lever section to `skills/adkit/reference/update.md`, mirroring the existing `keywords` section (depends on T021).

**Checkpoint**: US2 is independently functional — audiences can be attached/detached on live ad groups, idempotently, via the staged update flow.

---

## Phase 5: User Story 3 - Launch a true remarketing campaign on the Display Network (Priority: P2)

**Goal**: `campaign.networkSettings: "display-remarketing"` enables the Display Network for that campaign only, and only when at least one ad group carries a non-empty `audienceSegments`; every other `networkSettings` value is unaffected. `ads.sh audit` recognizes Display campaigns and skips search-specific checks rather than false-flagging them.

**Independent Test**: Create a brief with `"display-remarketing"` and a non-empty `audienceSegments` on at least one ad group — campaign has Display enabled. A sibling brief with the same setting but no segments is rejected before any API call. Running `ads.sh audit` against an account with both campaign types produces zero false-positive search-specific findings on the Display campaign.

- [x] T025 [US3] Parameterize `createSearchCampaign` in `skills/adkit/scripts/src/ads/entities.ts` (lines 137-177): branch `network_settings.target_content_network` (line 159) and `advertising_channel_type` (line 149) on `brief.campaign.networkSettings === "display-remarketing"`, unchanged for every other value (depends on T005).
- [x] T026 [US3] Parameterize `createAdGroup` in `skills/adkit/scripts/src/ads/entities.ts` (lines 595-619): branch `ad_group.type` (line 609) the same way, reading the parent campaign's `networkSettings` (depends on T005).
- [x] T027 [US3] Add a `BriefSchema.superRefine` check in `skills/adkit/scripts/src/lib/schema.ts` (lines 415-424, alongside the existing adGroup-name-uniqueness check): reject when `campaign.networkSettings === "display-remarketing"` and no ad group has a non-empty `audienceSegments` (FR-009) (depends on T004, T005).
- [x] T028 [US3] Guard the RSA-count check (`rsaCountsByAdGroup`/`rsaCountMismatches`, `skills/adkit/scripts/src/bin/audit.ts` lines ~383-407), the keyword-inclusion check, and the ad-strength-scoring calls to skip entirely when `channelType === "DISPLAY"` (per Clarifications: skip, not adapt, for v1) (depends on T009).
- [x] T029 [P] [US3] Unit tests in `skills/adkit/scripts/src/lib/schema.test.ts`: `BriefSchema` rejects `"display-remarketing"` with no segment anywhere, accepts it with one, and every existing `networkSettings` value parses unchanged (SC-002) (depends on T027).
- [x] T030 [P] [US3] Unit tests in `skills/adkit/scripts/src/ads/entities.test.ts`: `createSearchCampaign`/`createAdGroup` branch correctly for `"display-remarketing"`; Display-related fields are unchanged for every other `networkSettings` value (SC-002) (depends on T025, T026).
- [x] T031 [US3] End-to-end test in `skills/adkit/scripts/src/bin/create.test.ts`: a `"display-remarketing"` brief with no segments is rejected before any `client.mutate` call (assert zero mutate invocations via spy, SC-004); one with segments creates a Display-enabled campaign (depends on T025, T026, T027).
- [x] T032 [P] [US3] Tests in `skills/adkit/scripts/src/audit/rows.test.ts` (channelType normalization) and `skills/adkit/scripts/src/bin/audit.test.ts` (a `DISPLAY`-channel campaign produces zero RSA-count/keyword-inclusion/ad-strength findings; a `SEARCH`-channel campaign's checks are unaffected, SC-005) (depends on T028).
- [x] T033 [P] [US3] Update the `campaign.networkSettings` row in `skills/adkit/reference/create.md` to document `"display-remarketing"` and its audience-segment requirement (depends on T025, T026, T027).

**Checkpoint**: US3 is independently functional — true Display-remarketing campaigns can be launched safely, and the audit no longer misfires against them.

---

## Phase 6: User Story 4 - Upload a customer-match list without ever exposing plaintext PII (Priority: P3)

**Goal**: `ads.sh audiences upload-customer-match` hashes every identifier before it leaves the machine; `ads.sh audiences create-custom-intent` accepts keyword and/or URL seeds.

**Independent Test**: Run `upload-customer-match` against a local sample CSV and confirm (a) the network payload contains only SHA-256 hashes, never plaintext, and (b) no plaintext identifier appears in any log line or on-disk artifact.

- [x] T034 Create `skills/adkit/scripts/src/lib/hash.ts` — `hashEmail(raw: string): string` and `hashPhone(raw: string): string`, using Node's built-in `crypto.createHash("sha256")` plus Google's normalization (lowercase/trim email, E.164 phone); the only module in the codebase that ever touches a plaintext identifier.
- [x] T035 [P] [US4] Implement `create-custom-intent` in `skills/adkit/scripts/src/bin/audiences.ts`: accepts keyword and/or URL seeds together in one call, calls the appropriate custom-audience/custom-interest create service (depends on T002).
- [x] T036 [US4] Implement `upload-customer-match` in `skills/adkit/scripts/src/bin/audiences.ts`: parse a CSV with `email`/`phone` columns via a `parseCustomerMatchRow` discriminated-result parser, hash each valid row through T034 immediately (destructure-and-hash, never store-then-hash), skip and count malformed rows, reject the whole upload pre-flight if zero valid rows remain, then drive `OfflineUserDataJobService` create → add-operations → run (depends on T002, T034).
- [x] T037 [P] [US4] Unit tests in `skills/adkit/scripts/src/lib/hash.test.ts`: `hashEmail`/`hashPhone` normalization and hashing correctness against known SHA-256 vectors (depends on T034).
- [x] T038 [P] [US4] Tests in `skills/adkit/scripts/src/bin/audiences.test.ts`: `create-custom-intent` accepts keywords-only, URLs-only, and both together (depends on T035).
- [x] T039 [US4] Tests in `skills/adkit/scripts/src/bin/audiences.test.ts`: `upload-customer-match` — a fixture CSV's resulting request payload contains zero plaintext substrings from the input file (SC-003); a malformed row is skipped and counted; an all-invalid file is rejected pre-flight with zero network calls (depends on T036).
- [x] T040 [P] [US4] Extend `skills/adkit/reference/audiences.md` with `create-custom-intent` and `upload-customer-match` sections, including the CSV column format (depends on T035, T036).

**Checkpoint**: All four user stories are independently functional and tested.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final verification across the whole feature.

- [x] T041 Run `npm run typecheck` from `skills/adkit/scripts` and confirm a clean pass with all new files included (depends on T001-T040).
- [x] T042 Run `npx vitest run` from `skills/adkit/scripts` and confirm a clean pass — all new tests plus the full existing suite (depends on T001-T040).
- [x] T043 [P] Cross-link the new `skills/adkit/reference/audiences.md` from `skills/adkit/reference/conventions.md`'s command index (if one exists), matching how other subcommands are indexed (depends on T016, T024, T033, T040).

---

## Dependencies & Execution Order

- **Phase 1 (Setup)** has no dependencies — the `ads.sh` dispatch entry and the `audiences.ts` scaffold can start immediately.
- **Phase 2 (Foundational)** blocks all four user stories — T003-T009 must complete first (the schema type, entity builders, and GAQL query every story reuses).
- **User Story 1 (P1)** depends on Foundational (T003, T004, T006); delivers the MVP.
- **User Story 2 (P2)** depends on Foundational (T003, T007, T008); independent of US1's create-path wiring, but shares the same `AudienceSegmentSchema`.
- **User Story 3 (P2)** depends on Foundational (T004, T005) and reuses the entity-creation parameterization pattern established alongside US1's builder work, but is otherwise independent of US1/US2's specific wiring.
- **User Story 4 (P3)** depends only on Phase 1's `audiences.ts` scaffold (T002) — fully independent of US1/US2/US3, can be built in parallel with any of them.
- **Polish** depends on all four user stories being complete.

## Execution Wave DAG

```
Wave 1 (parallel): T001, T002, T003, T005, T009, T034
Wave 2 (parallel): T004 (needs T003), T006 (needs T003), T007 (needs T003),
                   T008 (needs T003), T010 (needs T002), T017 (needs T003),
                   T025 (needs T005), T026 (needs T005), T028 (needs T009),
                   T035 (needs T002), T036 (needs T002, T034)
Wave 3 (parallel): T011 (needs T006), T012 (needs T003, T004),
                   T013 (needs T006), T015 (needs T010), T018 (needs T017),
                   T019 (needs T017), T020 (needs T008), T027 (needs T004, T005),
                   T030 (needs T025, T026), T032 (needs T028), T037 (needs T034),
                   T038 (needs T035)
Wave 4 (parallel): T014 (needs T011), T016 (needs T010, T011),
                   T021 (needs T007, T018, T019, T020), T029 (needs T027),
                   T031 (needs T025, T026, T027), T033 (needs T025, T026, T027),
                   T039 (needs T036)
Wave 5 (parallel): T022 (needs T018, T019), T023 (needs T021), T024 (needs T021),
                   T040 (needs T035, T036)
Wave 6 (parallel): T041, T042 (need T001-T040), T043 (needs T016, T024, T033, T040)
```

## Implementation Strategy

**MVP first**: Phase 2 (Foundational) + Phase 3 (US1) delivers the actual
motivating gap — an advertiser can attach an existing audience in observation
mode, the safest and most immediately useful slice. Phases 4-6 (update lever,
Display unlock, customer-match upload) each stand on their own once
Foundational is in place and can be built in any order, or in parallel by
separate work — none of them depend on each other. Given they're all part of
one autopilot implementation pass, they ship together in this PR rather than
as follow-ups, matching the issue's full proposed scope.
