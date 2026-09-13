---

description: "Task list for 077 Meta Ads parity"
---

# Tasks: Meta Ads parity — init, create, audit, update, report for Meta ad accounts

**Input**: Design documents from `specs/077-meta-ads-parity/` (spec.md, plan.md, research.md, quickstart.md)

**Tests**: Required — FR-019 (Meta behaviour covered by automated tests with fake Graph API responses, no network) and FR-018/SC-005 (Google suite unchanged). Each implementation task owns its co-located `*.test.ts`.

**Conventions for every task** (from `CLAUDE.md` and plan.md):
- All paths below are relative to `skills/adkit/scripts/` unless they start with `skills/` or `specs/`.
- Run tooling only from `skills/adkit/scripts`: `npm run typecheck`, `npx vitest run <path>`.
- Functional style: pure functions, no mutation, no classes except error types. Parse untrusted input once (plan.md → Parse Boundaries); parsers return `{ kind: "ok", value } | { kind: "err", message }`.
- Imports use `.js` suffixes (ESM, `verbatimModuleSyntax`), matching existing files.
- Tests never touch the network: inject a fake `MetaClient` (T012) or `vi.stubGlobal("fetch")`.
- Plan section references (D1–D10) point at `specs/077-meta-ads-parity/plan.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other ready tasks (different files, dependencies met)
- **[Story]**: Which user story this task belongs to (US1–US5)

## Phase 1: Setup

- [x] T001 Merge the `meta-playbook` branch (PR #76, `skills/adkit/reference/meta/*.md`) into this branch with `git merge origin/meta-playbook` so the playbook docs that audit findings and command docs link to exist; resolve no code (docs-only merge)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: platform switch, Meta config, ids, client, schemas and the generic brief store that every story uses.

- [x] T002 [P] Create `src/cli/platform.ts` per plan D1: `type Platform = "google" | "meta"`; `parsePlatform(raw: unknown, source: string): Result<Platform>` (blank/undefined → `google`, unknown value → err naming source); `resolvePlatform(argv: readonly string[], env: NodeJS.ProcessEnv, config: { platform?: string }): Platform` with tiers `--platform` / `--platform=` > `ADKIT_PLATFORM` > config > google (throw `MetaConfigError`-style `Error` subclass `PlatformError` with `step: "platform"` on err); `stripPlatformFlag(argv): string[]`; plus `src/cli/platform.test.ts` covering defaults, each tier, both flag spellings, invalid values
- [x] T003 [P] Create `src/meta/ids.ts` per plan Parse Boundaries: zod `.brand()` schemas and types `MetaAdAccountId` (canonical `act_<digits>`), `MetaCampaignId`, `MetaAdSetId`, `MetaAdId`, `MetaCreativeId`, `MetaPageId`, `MetaPixelId`, `MetaCustomAudienceId`, `MetaVideoId`, `ImageHash`, `MetaAccessToken`; `parseMetaAdAccountId(raw: unknown, source: string): Result<MetaAdAccountId>` accepting `123`/`act_123` with trimming and rejecting anything else with the source named; shared `Result<T>` type exported from here; plus `src/meta/ids.test.ts`
- [x] T004 [P] Create `src/meta/errors.ts`: `MetaApiError` (fields `step`, `code: number | "schema"`, `subcode?`, `message`, `userTitle?`, `userMessage?`, `fbtraceId?`, `issues?`), `MetaConfigError` (`step`, `message`, `field?`, `path?`), and pure `formatMetaError(exc: unknown): string` that redacts any `access_token=` value; plus `src/meta/errors.test.ts` for formatting and redaction
- [x] T005 [P] Create `src/meta/money.ts` per plan D4: `ZERO_DECIMAL_CURRENCIES` (CLP COP CRC HUF ISK IDR JPY KRW PYG TWD VND) with a `// ponytail:` comment naming the ceiling, `toMinorUnits(amount: number, currency: string): number` (rounded integer), `fromMinorUnits(value: number | string, currency: string): number`; plus `src/meta/money.test.ts` (USD, EUR, JPY, string input)
- [x] T006 [P] Generalise `src/adbriefs/store.ts` and `src/adbriefs/diff.ts` per plan D7: introduce `export type StorableBrief = { name: string; campaign: { name: string } }`; make `slugForCampaign`, `briefPathForCampaign`, `serializeBrief`, `writeBrief`, `diffBriefs` generic over `B extends StorableBrief`; give `loadBriefIfExists` and `assertNoForeignBrief` an optional trailing `parse: (data: unknown) => B` defaulting to `parseAnyBrief`. Google call sites must compile without edits; existing `src/adbriefs/*.test.ts` must pass unchanged; add one test in `src/adbriefs/store.test.ts` using a custom parser
- [x] T007 [P] Reword Google-specific messages in `src/lib/secrets-guard.ts` (e.g. "Google Ads secrets" → "ads credentials") so the guard reads correctly for Meta tokens; update any string assertions in `src/lib/secrets-guard.test.ts` accordingly (message text only, no behaviour change)
- [ ] T008 Extend `src/lib/config.ts` per plan D2: add `platform`, `meta_ad_account_id`, `meta_page_id`, `meta_pixel_id` to `AdkitConfig` + `PREFERENCE_FIELDS`, and `meta_access_token` (sensitive), `meta_app_id`, `meta_app_secret` (sensitive) to `CREDENTIAL_FIELDS`; add `credentialFieldsFor(platform)`, `preferenceFieldsFor(platform)`, `secretsYamlShapeFor(platform)`, `projectYamlShapeFor(platform)` where the `google` result equals today's arrays/shapes exactly (byte-identical YAML); env overrides `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_APP_ID`, `META_APP_SECRET`; extend `src/lib/config.test.ts` for the new fields, platform-scoped shapes and the google-unchanged guarantee (depends on T002)
- [ ] T009 Create `src/meta/graph.ts` per plan D3/D5/D6/D7: zod schemas for `GraphErrorSchema` (`error{message,type,code,error_subcode,error_user_title,error_user_msg,fbtrace_id,is_transient}`), generic `pageSchema(item)` (`{ data: item[], paging?: { next?: string } }`), `AdAccountSchema`, `MeSchema`, `PermissionsSchema`, `CampaignSchema`, `AdSetSchema` (incl. `targeting`, `learning_stage_info`, `promoted_object`, `advantage_state_info`), `AdSchema`, `AdCreativeSchema` (incl. `asset_feed_spec`, `object_story_spec`, `degrees_of_freedom_spec`), `InsightsRowSchema` (money/number fields as decimal strings coerced to numbers, `actions`/`cost_per_action_type` arrays, breakdown keys optional), `CreatedIdSchema` (`{ id }`), `ImageUploadSchema`, `VideoStatusSchema`; unknown extra keys allowed (`.passthrough()` not required — use default strip) but required keys enforced; plus `src/meta/graph.test.ts` with realistic sample payloads (depends on T003)
- [ ] T010 Create `src/meta/client.ts` per plan D3: `GRAPH_API_VERSION = "v26.0"`; `MetaClient` interface (`get`, `getAll`, `post`, `uploadImage`, `uploadVideo`); `createMetaClient({ token, appSecret?, fetch?, version?, sleep? })` using injected `fetch`; params encoding (objects/arrays JSON-stringified, `fields` joined); `appsecret_proof` via `node:crypto` HMAC-SHA256 when `appSecret` given; pure `classifyGraphError(body, status): "retry" | "fatal"` and `retryDelayMs(attempt, headers)` (codes 1, 2, `is_transient`, 4, 17, 32, 613, 80000–80014, HTTP 5xx retry; subcode 1487632 fatal; honour `X-Business-Use-Case-Usage.estimated_time_to_regain_access` and `X-Ad-Account-Usage.reset_time_duration`); max 4 attempts; `getAll` follows `paging.next` until absent, not stopping on empty pages; non-2xx → `MetaApiError`, 2xx failing schema → `MetaApiError` code `"schema"`; `uploadImage` multipart `FormData`/`Blob` to `act_<id>/adimages` → `ImageHash`; `uploadVideo` rejects > 1 GB locally, single `source` multipart to `act_<id>/advideos`, then polls `GET /<id>?fields=status` until `video_status: "ready"` (bounded attempts, injected sleep) → `MetaVideoId`; plus `src/meta/client.test.ts` with `vi.fn` fetch covering pagination incl. empty middle page, retry then success, fatal 1487632, schema failure, error mapping, token redaction, appsecret_proof, image upload, video polling (depends on T004, T009)
- [ ] T011 Create `src/meta/config.ts` per plan D2: `MetaContext` type and `resolveMetaContext(flags: { adAccount?: string }, env, config, deps: { isTty: boolean; prompt: (q: string) => Promise<string>; save: (field: string, value: string) => void }): Promise<MetaContext>` — token from secrets/env (missing → `MetaConfigError` step `credentials` naming `meta_access_token`, the secrets path and `ads.sh init`), ad account via `--ad-account` > `META_AD_ACCOUNT_ID` > `meta_ad_account_id` parsed with `parseMetaAdAccountId`, prompting once on TTY and saving to `adkit.yaml`, else `MetaConfigError` step `ad-account`; page/pixel ids optional; plus `src/meta/config.test.ts` with injected deps (depends on T003, T004, T008)
- [ ] T012 Create `src/meta/fake-client.ts` (test support, not imported by production code): `fakeMetaClient({ get?: (path, params) => unknown, post?: (path, body) => unknown, failOn?: (call) => MetaApiError | null, readOnly?: boolean })` returning a `MetaClient` that records every call in an exposed `calls` array, parses responses through the caller's schema like the real client, throws on any `post`/upload when `readOnly`, and auto-assigns incrementing ids for `post` responses without one; plus a small self-test `src/meta/fake-client.test.ts` (depends on T010)

**Checkpoint**: platform, config, ids, client and fakes ready — story work can start.

---

## Phase 3: User Story 1 - Configure a project for a Meta ad account (Priority: P1) 🎯 MVP

**Goal**: `init` scaffolds a Meta project; `preflight` proves the token can reach the ad account.

**Independent Test**: `npx vitest run src/bin/init.test.ts src/meta/bin/preflight.test.ts src/bin/preflight.test.ts` — Meta init writes token only to secrets, account id only to `adkit.yaml`; preflight returns `ok:true` for good fakes and `ok:false` with the right step for rejected token / missing permission / disabled account; Google init and preflight behave as before.

- [ ] T013 [US1] Update `src/bin/init.ts` per plan D9: prompt `platform (google/meta) [google]` first, parse with `parsePlatform`, then prompt only `credentialFieldsFor`/`preferenceFieldsFor` that platform and write with the platform-scoped shapes (secrets 0600, project 0644, `platform` key written only when `meta`); update `src/bin/init.test.ts` answer arrays with one leading `""` for Google cases and add Meta cases (token lands only in `.adkit.secrets.yaml`; `platform: meta` and `meta_ad_account_id` land only in `adkit.yaml`; invalid platform answer re-prompts or errors) (depends on T002, T008)
- [ ] T014 [US1] Create `src/meta/bin/preflight.ts` per plan D9: `main(argv, env, clientFactory = createMetaClient)` running steps `credentials` (resolveMetaContext) → `auth` (`GET me?fields=id,name`) → `access` (`GET act_<id>?fields=name,account_status,currency,disable_reason`, `account_status !== 1` → err naming status) → `permissions` (`GET me/permissions`, missing `ads_read`/`ads_management` named); emits `ok({ platform: "meta", adAccountId, accountName, currency })` or `errorEnvelope(message, { step })`, exit 0/1; plus `src/meta/bin/preflight.test.ts` using `fakeMetaClient` (depends on T010, T011, T012)
- [ ] T015 [US1] Add the plan D1 delegation snippet at the top of `main` in `src/bin/preflight.ts` (resolve platform, `meta` → dynamic import `../meta/bin/preflight.js` with `stripPlatformFlag(argv)`); add a test in `src/bin/preflight.test.ts` that `--platform meta` delegates and that Google runs never import the Meta module (depends on T002, T014)

**Checkpoint**: US1 independently testable.

---

## Phase 4: User Story 2 - Report on Meta performance (Priority: P1)

**Goal**: `report` writes a `MetaReport` raw YAML the model turns into the markdown + dashboard.

**Independent Test**: `npx vitest run src/meta/report src/meta/bin/report.test.ts src/bin/report.test.ts` — paged insights fully fetched, totals/breakdowns correct, removed windows refused, Google report output unchanged.

- [ ] T016 [US2] Create `src/meta/report/fetch.ts` per plan D5: `AttributionWindow` literal union; `parseAttribution(raw?: string): Result<readonly AttributionWindow[]>` (default `["7d_click","1d_view"]`; `7d_view`/`28d_view` → err explaining Meta stopped returning them on 2026-01-12; unknown → err); `clampAllTime(start, today)` to Meta's 37-month max; `fetchMetaReportRows(client, ctx, window, opts: { includePaused; attribution; resultAction })` issuing the eight `getAll` insights reads + campaigns read listed in D5 in parallel and returning parsed rows; plus `src/meta/report/fetch.test.ts` asserting request paths/params (levels, breakdowns, `time_increment=1`, `action_attribution_windows`, effective_status filter only without `--include-paused`) (depends on T010, T011, T012)
- [ ] T017 [P] [US2] Create `src/meta/report/shape.ts` per plan D5: pure `shapeMetaReport(rows, meta: { adAccountId; currency; attribution; resultAction; window; generatedAt }): MetaReport` mapping campaigns/campaign_daily/ad_groups (ad sets)/ads (`type: "META_AD"`, `ad_strength: "UNSPECIFIED"`)/geo/geo_regions, `keywords: []`, `search_terms: []`, `recommendations: []`, `placements`, `demographics`; `conversions` = sum of `actions` matching `resultAction`; `cost_per_conversion` via `safeRatio` from `src/lib/report.ts`; `MetaMetricDict` adds reach/frequency/cpm/link_clicks; export `MetaReport` type; plus `src/meta/report/shape.test.ts` with hand-built rows (depends on T009)
- [ ] T018 [US2] Create `src/meta/bin/report.ts` per plan D5: `main(argv, env, clientFactory = createMetaClient)` reusing `parseArgs` from `src/bin/report.ts` for `--days/--all-time/--include-paused` after pulling out `--result-action`, `--attribution`, `--ad-account`; reads account currency; zero campaigns → exit 1 with envelope like Google; writes YAML to `reportPath(cwd, generatedAt, adAccountId, resolveReportsDir())` and prints the path; errors → `errorEnvelope` with step; plus `src/meta/bin/report.test.ts` (temp cwd, fake client, file contents) (depends on T016, T017)
- [ ] T019 [US2] Add the plan D1 delegation snippet at the top of `main` in `src/bin/report.ts`; add a delegation test in `src/bin/report.test.ts` and confirm the existing Google report tests pass unchanged (depends on T002, T018)

**Checkpoint**: US1 + US2 = read-only MVP.

---

## Phase 5: User Story 3 - Audit live Meta campaigns (Priority: P2)

**Goal**: read-only audit producing severity-ranked findings linked to the playbook.

**Independent Test**: `npx vitest run src/meta/audit src/meta/bin/audit.test.ts` — one finding per seeded issue, read-only fake never receives a write.

- [ ] T020 [P] [US3] Create `src/meta/audit/rows.ts` per plan D6: parsed input types `AuditCampaign`, `AuditAdSet` (learning status, weekly result events, targeting inclusions/exclusions, optimization goal, pixel id, advantage state), `AuditAd` (current/previous window frequency, link CTR, spend, destination links, enhancement enroll statuses), `AuditBreakdownRow`; pure `toAuditRows(raw parsed graph objects + insights) → AuditInput`; plus `src/meta/audit/rows.test.ts` (depends on T009)
- [ ] T021 [US3] Create `src/meta/audit/scoring.ts` per plan D6 table: named threshold constants; one pure rule per issue (`learningLimited`, `stillLearningLowVolume`, `fragmentedBudget`, `creativeFatigue`, `wastedBreakdownSpend`, `missingCustomerExclusion`, `weakConversionSignal`, `advantageCreativeEnhancementsOn`) each `(input: AuditInput) → MetaFinding[]`; `scoreMetaAccount(input) → { campaignId → MetaFinding[] }` sorted high → low severity; each finding has `entityId`, `entityName`, `severity`, `detail`, `evidence`, `fix`, `playbook` (`reference/meta/<file>#<anchor>`); plus `src/meta/audit/scoring.test.ts` with one firing and one non-firing case per rule (depends on T020)
- [ ] T022 [US3] Create `src/meta/audit/render.ts`: pure `renderMetaAudit(campaigns) → string[]` using `ljust`/`rjust`/`pct` from `src/audit/render.ts` and the `  ! issue: detail` line format, grouped by campaign then severity; plus `src/meta/audit/render.test.ts` (depends on T021)
- [ ] T023 [US3] Create `src/meta/bin/audit.ts` per plan D6: `main(argv, env, clientFactory = createMetaClient)`; `--days` 7/14/30 (default 14), `--psi-key`, `--ad-account`; reads campaigns/ad sets/ads/creatives and two insights windows + breakdowns via `getAll`; builds `AuditInput`, scores, renders to stderr with `emitLines`; landing page URLs from creative links fed to the existing PSI helpers (`buildPsiRequestUrl`, `parsePsiResponse`, `renderPsi`, `renderLandingPageHealth`); emits `ok({ platform: "meta", adAccountId, window, campaigns, landingPageHealth, psi })`; plus `src/meta/bin/audit.test.ts` with `fakeMetaClient({ readOnly: true })` seeded with one of each issue and a `fetch` stub for PSI (depends on T010, T011, T012, T022)
- [ ] T024 [US3] Add the plan D1 delegation snippet at the top of `main`/`runAudit` in `src/bin/audit.ts` (before Google customer/MCC resolution); add a delegation test in `src/bin/audit.test.ts` (depends on T002, T023)

**Checkpoint**: US3 independently testable.

---

## Phase 6: User Story 4 - Publish a new Meta campaign from a brief (Priority: P2)

**Goal**: brief → staged diff → paused campaign/ad sets/creatives/ads, resumable.

**Independent Test**: `npx vitest run src/meta/brief.test.ts src/meta/state.test.ts src/meta/publish.test.ts src/meta/bin/create.test.ts` — invalid brief lists all problems with zero calls; dry run zero writes; publish order and `PAUSED`; failure then re-run creates no duplicates.

- [ ] T025 [P] [US4] Create `src/meta/brief.ts` per plan D7 YAML: `MetaBriefSchema` (`type: z.literal("meta")`, strict objects, campaign `budget` discriminated on `mode`, ad sets 1..10, ads 1..6, text pools with hard limits 1024/255/255 and 1..5 counts, enhancements record over the known feature keys `image_touchups text_optimizations add_text_overlay image_templates image_animation image_background_gen inline_comment text_translation enhance_cta image_uncrop` → `OPT_IN|OPT_OUT`) with `superRefine` for budget mode exclusivity, bid amount presence, objective ↔ optimization goal allow-list, OFFSITE_CONVERSIONS ↔ `conversion`, special-ad-category targeting restrictions, unique names; `parseMetaBrief(data: unknown, deps: { fileExists: (p: string) => boolean }): Result<MetaBrief>` collecting every issue (incl. missing media files) into one message list; pure `softWarnings(brief): string[]` for recommended lengths (125/40/30); `isMetaBriefData(data: unknown): boolean` (`type === "meta"`); plus `src/meta/brief.test.ts` (valid brief, each refinement, all-issues-at-once) (depends on T003, T005)
- [x] T026 [P] [US4] Create `src/meta/state.ts` per plan D7: `MetaStateSchema`, `parseMetaState`, `META_STATE_SUFFIX = ".meta-state.yaml"`, `metaStatePath(root, brief, dir)`, `emptyMetaState(brief, adAccountId)`, `readMetaState(path): MetaState | null`, `writeMetaState(path, state)` (atomic, reuse `writeYamlAtomic` if exported from `src/lib/config.ts`), `loadMetaStateIndex(root, dir): { byCampaignId; byAdSetId; byAdId }` mapping to `{ slug, campaignName, adSetName?, adName? }`; add a test in `src/meta/state.test.ts` that a `.meta-state.yaml` file is ignored by Google `loadStateIndex` (depends on T003)
- [ ] T027 [US4] Create `src/meta/publish.ts` per plan D7: pure builders `campaignParams(brief, currency)`, `adSetParams(brief, adSet, campaignId, currency)`, `creativeParams(brief, ad, pageId, media)`, `adParams(ad, adSetId, creativeId)` (all `status: "PAUSED"`, budgets via `toMinorUnits`, JSON-ready `targeting`, `targeting_automation`, `promoted_object`, `asset_feed_spec` with `optimization_type: "DEGREES_OF_FREEDOM"`, `degrees_of_freedom_spec.creative_features_spec`); `planPublish(brief, state) → PlannedObject[]` (pure, for dry run); `publishMeta(client, ctx, brief, state, deps: { readMedia; saveState }) → Promise<{ state; failure: { step; message; code? } | null }>` running steps `upload-media` → `create-campaign` → per ad set `create-ad-set` → per ad `create-creative` → `create-ad`, calling `saveState` after every successful step, skipping steps whose id is in state, and before creating an object without a state id looking it up by exact name under its parent (non-DELETED; >1 match → failure step `find-existing`); media reuse keyed by sha256; plus `src/meta/publish.test.ts` covering order, PAUSED on every post, CBO vs ABO budget placement, currency offset, failure at ad set 2 then re-run creating only the missing objects, "create succeeded but state not saved" recovered by name lookup, duplicate-name failure (depends on T010, T012, T025, T026)
- [ ] T028 [US4] Create `src/meta/bin/create.ts` per plan D7: `main(argv, env, clientFactory = createMetaClient)` for `<brief.yaml> [--dry-run] [--skip-url-check]`; parse brief (print all issues, exit 1, zero calls); print `softWarnings`; URL reachability via existing `unreachableUrls` unless skipped; `assertNoForeignBrief`/`loadBriefIfExists` with `parseMetaBrief` parser; `diffBriefs` to stderr; dry run → `ok({ platform: "meta", dryRun: true, briefDiff, planned: planPublish(...), willWriteBrief, willWriteState })` with zero client writes; publish → `writeBrief`, account currency read, `publishMeta`, envelope `{ platform: "meta", created, failure, briefSynced, stateSynced }`, exit 1 on failure; plus `src/meta/bin/create.test.ts` (temp cwd, fake client, dry run asserts no `post` calls) (depends on T006, T011, T027)
- [ ] T029 [US4] Add the plan D1 delegation to `src/bin/create.ts`: delegate to `../meta/bin/create.js` when the resolved platform is `meta` **or** the brief file's YAML has `type: meta` (checked with `isMetaBriefData` before `parseAnyBrief`); add delegation tests in `src/bin/create.test.ts` (extend its `vi.mock` setup only as needed) (depends on T002, T025, T028)

**Checkpoint**: US4 independently testable.

---

## Phase 7: User Story 5 - Apply an update plan to live Meta ads (Priority: P3)

**Goal**: dry-run-unless-`--apply` update with skip-if-unchanged, spend warnings and per-entry failure isolation.

**Independent Test**: `npx vitest run src/meta/plan.test.ts src/meta/apply.test.ts src/meta/bin/update.test.ts` — dry run zero writes; apply writes; third run all skipped; warning keys populated; one failing entry doesn't block others.

- [ ] T030 [P] [US5] Create `src/meta/plan.ts` per plan D8: `MetaPlanSchema` (strict; `platform: "meta"`, optional `adAccountId`, sections `budgets`, `status`, `exclusions`, `enhancements`, `textPools` with the brief's text limits and enhancement keys reused from `src/meta/brief.ts`); `parseMetaPlan(data: unknown): Result<MetaPlan>`; `LiveState` type; generic pure `splitChanges<E, L>(entries, live: ReadonlyMap<string, L>, key: (e: E) => string, equals: (e: E, l: L) => boolean): { changes: E[]; skips: E[] }`; `validateMetaPlan(changes, live): string[]` (unknown ids, budget raise > 50%, budget level vs campaign CBO mismatch); `metaWarnings(changes, live): { lines; enableStartsLiveSpend; budgetIncreases; learningResetRisk; exclusionIgnored }` per D8 step 5; plus `src/meta/plan.test.ts` (depends on T003, T005, T025)
- [ ] T031 [US5] Create `src/meta/apply.ts` per plan D8: `readLiveState(client, plan)` (multi-get `?ids=` for referenced campaigns/ad sets/ads with budget, status, targeting, learning_stage_info, advantage_state_info, creative fields); `resolveMetaPlanGroups(plan, index)` → per-slug groups + unresolved ids; pure `applyMetaPlanToBrief(brief: MetaBrief, group): MetaBrief`; appliers `applyStatus`, `applyBudget` (`toMinorUnits` with live currency), `applyExclusions` (merge add/remove into live `targeting.excluded_custom_audiences`, post full targeting), `applyCreativeSwap` (build new creative params from live creative + enhancement/text-pool change, `POST act/adcreatives`, then `POST /<ad-id>` with `creative: { creative_id }`); `runMetaApply(client, ctx, changes, order)` applying pause-status → budgets → exclusions → creative swaps → enable-status, each entry in its own try/catch collecting `{ step, entityId, message }` and continuing; plus `src/meta/apply.test.ts` with fake client and `failOn` (depends on T010, T012, T026, T030)
- [ ] T032 [US5] Create `src/meta/bin/update.ts` per plan D8: `main(argv, env, clientFactory = createMetaClient)` for `<plan.yaml> [--apply]`; parse plan; read live state; split/validate (errors → "VALIDATION FAILED", exit 1); warnings printed as `WARNING:` lines; stage via `loadMetaStateIndex` + `applyMetaPlanToBrief` + `diffBriefs` (unresolved ids reported, not fatal); dry run → envelope with all D8 step 9 keys and `applied: false`, zero writes; `--apply` → `runMetaApply`, write briefs/state only for slugs without failures, envelope incl. `errors[]`, exit 1 if any failure; plus `src/meta/bin/update.test.ts` covering dry run, apply, idempotent third run, warning keys, partial failure (depends on T006, T011, T031)
- [ ] T033 [US5] Add the plan D1 delegation to `src/bin/apply-fixes.ts`: delegate to `../meta/bin/update.js` when the resolved platform is `meta` **or** the plan YAML has `platform: meta` (checked right after reading the plan file, before any Google customer resolution); add delegation tests in `src/bin/apply-fixes.test.ts` (depends on T002, T032)

**Checkpoint**: all five stories functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [x] T034 [P] Refuse Meta in Google-only commands per plan D10: at the top of `main` in `src/bin/research.ts` and `src/bin/keyword-ideas.ts`, when `resolvePlatform(...) === "meta"` emit `errorEnvelope("<cmd> is Google-only; Meta has no keyword planner equivalent", { step: "platform" })` and return 1; add one test each in `src/bin/research.test.ts` and `src/bin/keyword-ideas.test.ts` (depends on T002)
- [ ] T035 [P] Add optional Meta secret specs (`META_ACCESS_TOKEN` → `meta_access_token`, `META_APP_SECRET` → `meta_app_secret`) to `src/bin/render-yaml.ts` and `src/bin/bootstrap-secrets.ts` so a missing Meta secret is skipped, not fatal, for Google-only projects; extend `src/bin/render-yaml.test.ts` and `src/bin/bootstrap-secrets.test.ts` (depends on T008)
- [x] T036 [P] Document the platform switch in `skills/adkit/SKILL.md` (description mentions Meta; routing note: commands follow `platform` in `adkit.yaml` or `--platform`; research/gtm Google-only) and `skills/adkit/reference/conventions.md` (new sections: `platform`, Meta credentials table rows, `act_` ad account id rules, Meta envelope/error steps, `.meta-state.yaml`) and `skills/adkit/reference/init.md` (Meta prompts) (depends on T001)
- [x] T037 [P] Add "Meta" sections to `skills/adkit/reference/report.md` (MetaReport fields, no keyword/search-term/ad-strength sections, placement + demographic + frequency charts, attribution note) and `skills/adkit/reference/audit.md` (Meta finding table with severity, links to `reference/meta/*`) (depends on T001)
- [x] T038 [P] Add "Meta" sections to `skills/adkit/reference/create.md` (Meta brief YAML from plan D7, authoring rules linking `reference/meta/2-audience-mining.md`, `3-account-structure.md`, `4-creative.md`, `5-exclusions.md`; paused + resumable publish) and `skills/adkit/reference/update.md` (Meta plan YAML from plan D8, warning keys, learning-reset guidance linking `reference/meta/6-analyze.md`) (depends on T001)
- [ ] T039 Run `npm run typecheck` and `npm test` in `skills/adkit/scripts`; fix any failure in the owning file; confirm no Google test expectation changed other than the documented `init.test.ts` leading platform answer and the T007 message wording; record results in the implement report (depends on T013, T015, T019, T024, T029, T033, T034, T035)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001)**: no dependencies; only the docs tasks need it.
- **Foundational (T002–T012)**: blocks every story.
- **US1, US2, US3, US4**: independent of each other once Foundational is done.
- **US5**: needs US4's brief (T025) and state index (T026).
- **Polish**: docs need T001; T039 needs every code task.

### User Story Dependencies

- **US1 (P1)**: Foundational only.
- **US2 (P1)**: Foundational only.
- **US3 (P2)**: Foundational only.
- **US4 (P2)**: Foundational (T006 store generalisation, T010–T012).
- **US5 (P3)**: Foundational + T025, T026.

### Within Each User Story

Pure modules (schemas, shaping, scoring) → client-driven module → `src/meta/bin/<cmd>.ts` → Google bin delegation. Each task's tests ship with the task.

## Execution Wave DAG

| Wave | Tasks (parallel within wave) | Waits on |
| --- | --- | --- |
| W1 | T001, T002, T003, T004, T005, T006, T007 | — |
| W2 | T008, T009, T025, T026, T034, T036, T037, T038 | T001, T002, T003, T005 |
| W3 | T010, T011, T013, T017, T020, T030, T035 | T003, T004, T008, T009, T025 |
| W4 | T012, T021 | T010, T020 |
| W5 | T014, T016, T022, T027, T031 | T010, T011, T012, T021, T025, T026, T030 |
| W6 | T015, T018, T023, T028, T032 | T014, T016, T017, T022, T027, T031, T006, T011 |
| W7 | T019, T024, T029, T033 | T018, T023, T028, T032 |
| W8 | T039 | all code tasks |

File ownership: no two tasks in the same wave edit the same file (Google bins are each touched by exactly one delegation task; `lib/config.ts` only by T008; `bin/init.ts` only by T013).

## Implementation Strategy

### MVP First

1. W1–W4 foundations.
2. US1 (T013–T015) + US2 (T016–T019): read-only Meta setup and reporting — **stop and validate** with quickstart §1.

### Incremental Delivery

3. US3 audit (read-only) → validate.
4. US4 create (paused, resumable) → validate dry run + re-run safety.
5. US5 update → validate dry run / apply / idempotent re-run.
6. Polish: docs, Google-only refusals, full suite (T039), then quickstart §3 live smoke test once a token exists.

## Notes

- [P] tasks touch different files with dependencies met.
- Commit after each wave; never mix unrelated slices in one commit.
- If a Graph API field name in plan.md turns out wrong against the pinned version's reference, fix it in the owning module and note it in the implement report — do not silently widen schemas.
