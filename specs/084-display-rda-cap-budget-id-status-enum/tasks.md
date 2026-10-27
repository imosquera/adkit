# Tasks: Display RDA combined image cap, quoted plan ids, numeric live status

**Input**: Design documents from `specs/084-display-rda-cap-budget-id-status-enum/`

**Prerequisites**: plan.md, spec.md, research.md, quickstart.md

**Tests**: Requested — spec FR-007 requires regression tests for all three defects.

All paths are relative to `skills/adkit/scripts/`.

## Phase 1: Setup

- [x] T001 Install dependencies in the worktree (`npm ci` in skills/adkit/scripts) and confirm the `npm run typecheck` / `npm test` baseline is green

## Phase 2: Foundational

None — the three stories touch disjoint code and share no prerequisite.

## Phase 3: User Story 1 — Dry run rejects a display ad with too many images (P1)

**Goal**: the combined caps (15 images, 5 logos) are enforced when the brief is parsed.

**Independent Test**: 10 + 10 images rejected, 8 + 7 accepted, 3 + 3 logos rejected.

- [x] T002 [P] [US1] Add failing tests for the combined image cap (10+10 rejected naming 15, 8+7 accepted) and combined logo cap (3+3 rejected naming 5) in src/ads/display.test.ts (depends on T001)
- [x] T003 [US1] Add a `superRefine` enforcing `marketingImages + squareMarketingImages <= MAX_RDA_IMAGES` and `logoImages + squareLogoImages <= MAX_RDA_LOGOS` to `ResponsiveDisplayAdSchema` in src/lib/schema.ts, dropping the now-redundant per-field `.max` calls (depends on T002)

## Phase 4: User Story 2 — Update plans accept quoted ids in every section (P1)

**Goal**: a quoted digit-string id behaves exactly like the unquoted id in every plan section.

**Independent Test**: a quoted `budgets.campaignId` finds the live budget; `normalizePlanIds` leaves non-canonical ids alone.

- [x] T004 [P] [US2] Add failing tests for `normalizePlanIds` (quoted → number across sections; `"0123"`, `"abc"`, unsafe-integer strings and top-level `customerId` untouched) and for `validate` with a quoted budgets `campaignId` finding its budget, in src/fixes/plan.test.ts (depends on T001)
- [x] T005 [US2] Implement and export pure `normalizePlanIds(raw: unknown): unknown` in src/fixes/plan.ts (depends on T004)
- [x] T006 [US2] Call `normalizePlanIds` from `loadPlan` in src/bin/apply-fixes.ts, and update its doc comment (depends on T005)
- [x] T007 [P] [US2] Add a `loadPlan` test with a YAML plan carrying quoted ids, asserting they load as numbers, in src/bin/apply-fixes.test.ts (depends on T006)

## Phase 5: User Story 3 — Already-enabled campaigns and ad groups are skipped (P2)

**Goal**: live campaign/ad-group status is decoded to its name, so the idempotent skip and the live-spend warning work.

**Independent Test**: live status `2` + target ENABLED → skipped, no live-spend warning; `3` → `PAUSED -> ENABLED`.

- [x] T008 [P] [US3] Add failing tests: `liveCampaignStatuses` / `liveAdGroupStatuses` decode numeric status (`2` → ENABLED, `3` → PAUSED) and pass string names through, using a fake client, in src/bin/apply-fixes.test.ts (depends on T001)
- [x] T009 [US3] Decode with `enumName(enums.CampaignStatus | enums.AdGroupStatus, …)` in `liveCampaignStatuses` / `liveAdGroupStatuses`, widen `CampaignStatusRow` / `AdGroupStatusRow` status to `string | number`, and correct the stale "arrives as string" comments in src/bin/apply-fixes.ts (depends on T008)

## Phase 6: Polish

- [x] T010 Run `npm run typecheck`, `npm test`, lint, and the parse-dont-validate scanner; fix any findings (depends on T003, T007, T009)

## Execution Wave DAG

- **Wave 1**: T001
- **Wave 2**: T002, T004, T008 (parallel — different stories and files)
- **Wave 3**: T003, T005, T009
- **Wave 4**: T006
- **Wave 5**: T007
- **Wave 6**: T010

Note: T007 and T008 both edit src/bin/apply-fixes.test.ts. They're in different waves, so no file sees two concurrent writers.

## Dependencies

US1, US2 and US3 are independent; each depends only on Setup. Polish depends on all three.

## Implementation Strategy

All three are small; ship them together as one PR. US1 is the MVP: it's the only defect that does wasted live work (uploaded orphan images).
