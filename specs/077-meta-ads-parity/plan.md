# Implementation Plan: Meta Ads parity — init, create, audit, update, report for Meta ad accounts

**Branch**: `077-meta-ads-parity` | **Date**: 2026-09-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/077-meta-ads-parity/spec.md`

## Summary

Add a Meta (Facebook/Instagram) path to every lifecycle command except
`research` / `keyword-ideas`, selected by `platform: google | meta` in
`adkit.yaml` (absent = `google`) or `--platform` on the command line.

The approach is **a parallel `src/meta/` namespace that plugs into the existing
platform-agnostic seams**, not a rewrite of the Google bins:

- Each existing Google bin (`init`, `preflight`, `report`, `audit`, `create`,
  `apply-fixes`/`update`) gains a 2–3 line platform check at the top of `main`
  that delegates to `src/meta/bin/<cmd>.ts` when the resolved platform is
  `meta`. Every Google code path below that check is untouched (FR-018).
- One `MetaClient` (plain `fetch`, pinned Graph API version, pagination,
  bounded retry, zod-parsed responses) is the only thing that talks to Meta —
  the role `google-ads-api` + `gaql/` play for Google.
- Reused as-is or with a widened type only: `cli/output.ts` envelope helpers,
  `cli/entry.ts`, `lib/config.ts` tiers + two-file split, `lib/secrets-guard.ts`,
  `adbriefs/store.ts` + `adbriefs/diff.ts` (generalised over a structural brief
  type), `bin/report.ts` window helpers + `reportPath` + YAML writer,
  `audit/render.ts` text helpers + landing page / PSI sections.
- Meta-owned: ids/brands, client, Graph response schemas, Meta brief + state
  schemas, report fetch/shaping, audit rows/scoring, publisher, update plan +
  appliers.

## Technical Context

**Language/Version**: TypeScript 5.7, Node ≥ 24 (ESM, run via `tsx`, no build step)

**Primary Dependencies**: existing only — `zod` 3 (parsing), `yaml`, Node's
built-in `fetch`/`FormData`/`Blob` for the Graph API. No new runtime dependency.
See research.md — `facebook-nodejs-business-sdk` rejected (CJS-only, untyped,
class-based, npm `latest` pinned to expiring v24.0); `p-retry` rejected (saves
almost nothing over the Meta-specific classifier).

**Storage**: local files — `adkit.yaml`, `.adkit.secrets.yaml`,
`adbriefs/<slug>.yaml` (brief), `adbriefs/<slug>.meta-state.yaml` (Meta ids),
`<reports_dir>/<date>-<act id>-raw.yaml`.

**Testing**: vitest 2 (`npm test` in `skills/adkit/scripts`); an injected fake
`MetaClient` (object literal recording `calls[]`, optional `failOn`) for
command tests, `vi.stubGlobal("fetch")` for client tests. No network, no live
credentials (FR-019).

**Target Platform**: macOS/Linux CLI invoked through `ads.sh`

**Project Type**: CLI skill (single project)

**Graph API version**: `v26.0` (released 2026-07-29, expiry TBD), pinned in one
constant `GRAPH_API_VERSION` in `src/meta/client.ts`. See research.md → "Graph
API version"; fall back to `v25.0` if the first live smoke test rejects v26.0.

**Performance Goals**: a report over one ad account and a 30-day window
completes within Meta's standard rate limits using default page size; no
async-report-job support needed at this scale.

**Constraints**: every write path dry-run-able with zero write calls (SC-002);
every created object `PAUSED` (SC-003); re-run after partial failure creates no
duplicates (SC-004); Google test suite unchanged (SC-005).

**Scale/Scope**: one ad account per run; briefs up to 10 ad sets × 6 ads.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled
`speckit init` template — confirmed via
`python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py list`,
which reports zero matched principle headings (same result as the
`048-bid-strategy-lever` plan).

**No constitution defined** — there are no real principles to check against.
The repo's binding conventions live in `CLAUDE.md` and are honoured as follows:

- **Functional style** — all Meta core logic (brief/plan parsing, report
  shaping, audit scoring, diff/skip splitting, publish step ordering) is pure
  `input → output` functions. I/O is confined to `src/meta/client.ts` (network),
  `src/meta/bin/*.ts` (argv, env, files, stdout) and the thin publisher/applier
  shells that sequence client calls. No classes except `MetaApiError` /
  `MetaConfigError`.
- **Parse, don't validate** — every untrusted input is parsed once (see
  `## Parse Boundaries`); downstream functions take the branded / parsed types
  and never re-check.
- **Tooling location** — all `typecheck` / `test` commands run from
  `skills/adkit/scripts`.

Post-design re-check: the design adds no class, no mutable accumulator in core
logic (the publisher's partial-id record is built by returning new state from
each step), and no downstream re-validation. PASS against CLAUDE.md.

## Project Structure

### Documentation (this feature)

```text
specs/077-meta-ads-parity/
├── spec.md
├── plan.md
├── research.md
├── quickstart.md
└── tasks.md
```

### Source Code (repository root)

```text
skills/adkit/
├── SKILL.md                                  # EDIT: platform routing note, Meta commands
├── reference/
│   ├── conventions.md                        # EDIT: platform switch, Meta credentials, act_ ids
│   ├── init.md  report.md  audit.md          # EDIT: "Meta" sections linking reference/meta/*
│   ├── create.md  update.md                  # EDIT: Meta brief + Meta plan sections
│   └── meta/                                 # from PR #76 (merge main once #76 lands)
└── scripts/
    ├── ads.sh                                # unchanged (bins delegate internally)
    └── src/
        ├── cli/
        │   └── platform.ts                   # NEW: Platform type, parsePlatform, resolvePlatform, stripPlatformFlag
        ├── lib/
        │   ├── config.ts                     # EDIT: platform + meta_* fields, platform-aware yaml shapes
        │   └── secrets-guard.ts              # EDIT: wording only ("ads secrets", not "Google Ads secrets")
        ├── adbriefs/
        │   ├── store.ts                      # EDIT: generic over StorableBrief + injectable parser (defaults keep Google behaviour)
        │   └── diff.ts                       # EDIT: accept StorableBrief
        ├── bin/
        │   ├── init.ts                       # EDIT: ask platform first; prompt only that platform's fields
        │   ├── preflight.ts report.ts audit.ts create.ts apply-fixes.ts
        │   │                                 # EDIT: top-of-main delegation to src/meta/bin/*
        │   ├── research.ts keyword-ideas.ts  # EDIT: refuse when platform = meta (FR-016)
        │   └── render-yaml.ts bootstrap-secrets.ts  # EDIT: Meta secret specs (optional)
        └── meta/
            ├── ids.ts                        # branded ids + parsers
            ├── errors.ts                     # MetaApiError, MetaConfigError, formatMetaError
            ├── client.ts                     # MetaClient interface + createMetaClient(fetch-based)
            ├── graph.ts                      # zod schemas for Graph API responses
            ├── money.ts                      # currency offset ↔ minor units
            ├── config.ts                     # resolveMetaContext: token + ad account + page id
            ├── report/
            │   ├── fetch.ts                  # insights reads → raw parsed rows
            │   └── shape.ts                  # pure rows → MetaReport
            ├── audit/
            │   ├── rows.ts                   # parsed audit inputs
            │   ├── scoring.ts                # pure rules → MetaFinding[]
            │   └── render.ts                 # pure → string[]
            ├── brief.ts                      # MetaBriefSchema + parseMetaBrief
            ├── state.ts                      # MetaStateSchema, read/write .meta-state.yaml
            ├── publish.ts                    # step sequencing, resumable
            ├── plan.ts                       # MetaPlanSchema, splitChanges, validate, warnings
            ├── apply.ts                      # live reads + appliers + applyMetaPlanToBrief
            └── bin/
                ├── preflight.ts report.ts audit.ts create.ts update.ts
```

**Structure Decision**: `src/meta/` mirrors the Google layering (ids → client →
rows/schemas → pure logic → bin shell) so each command slice can be built and
tested independently. Google bins are not refactored into a shared
orchestrator: `apply-fixes.ts` `main` is ~860 hard-wired lines and
`audit.ts`/`report.ts` are Google-shaped end to end; extracting shared
orchestration first would risk FR-018 for no user-visible gain (see Complexity
Tracking).

## Design

### D1. Platform resolution (`cli/platform.ts`)

- `type Platform = "google" | "meta"`.
- `parsePlatform(raw: unknown, source: string): Platform` — `undefined`/blank →
  `"google"`; `"google" | "meta"` → itself; anything else throws
  `MetaConfigError` naming `source` (flag / `ADKIT_PLATFORM` / `adkit.yaml`).
- `resolvePlatform(argv, env, config): Platform` — tiers via existing
  `resolveTier`: `--platform` > `ADKIT_PLATFORM` > `adkit.yaml platform` > google.
- `stripPlatformFlag(argv): string[]` — removes `--platform <v>` /
  `--platform=<v>` so the Meta bins see a clean argv.
- Delegation snippet at the top of each Google bin `main`:
  `if (resolvePlatform(argv, env, loadConfig()) === "meta") return (await import("../meta/bin/<cmd>.js")).main(stripPlatformFlag(argv), env);`
  (dynamic import keeps Google runs from loading Meta modules).

### D2. Config & credentials (`lib/config.ts`, `meta/config.ts`)

- New preference fields (committed `adkit.yaml`): `platform`,
  `meta_ad_account_id`, `meta_page_id`, `meta_pixel_id`.
- New credential fields (`.adkit.secrets.yaml`, 0600): `meta_access_token`,
  `meta_app_id`, `meta_app_secret`.
- `credentialFieldsFor(platform)` / `preferenceFieldsFor(platform)` return the
  subset `init` prompts for and `buildConfigYamlBody` writes; Google's existing
  field arrays and shapes are the `google` subset, byte-identical output.
- Env overrides: `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_APP_ID`,
  `META_APP_SECRET`.
- `resolveMetaContext(flags, env, config): MetaContext` in `meta/config.ts`
  parses once into `{ token: MetaAccessToken; adAccountId: MetaAdAccountId;
  pageId: MetaPageId | null; pixelId: MetaPixelId | null; appSecret: string | null }`.
  Missing token/account → `MetaConfigError` (step `credentials` / `ad-account`)
  naming the field, file, and fix; on a TTY the ad account id is prompted once
  and saved to `adkit.yaml` (same behaviour as `target_customer_id`).
- When `meta_app_secret` is present, requests carry `appsecret_proof`
  (HMAC-SHA256 of the token) via `node:crypto`.

### D3. Graph client (`meta/client.ts`)

```ts
interface MetaClient {
  get<T>(path: string, params: Params, schema: z.ZodType<T>): Promise<T>;
  getAll<T>(path: string, params: Params, item: z.ZodType<T>): Promise<readonly T[]>; // follows paging.next
  post<T>(path: string, body: Params, schema: z.ZodType<T>): Promise<T>;
  uploadImage(account: MetaAdAccountId, file: { name: string; bytes: Uint8Array }): Promise<ImageHash>;
  uploadVideo(account: MetaAdAccountId, file: { name: string; bytes: Uint8Array }): Promise<MetaVideoId>;
}
createMetaClient(opts: { token; appSecret?; fetch?: typeof fetch; version?: string; sleep?: (ms) => Promise<void> }): MetaClient
```

- Base URL `https://graph.facebook.com/${GRAPH_API_VERSION}`; token sent as
  `access_token` param (never logged; `formatMetaError` redacts it).
- Object/array params JSON-encoded (Graph convention for `targeting`,
  `asset_feed_spec`, `fields` lists joined by comma).
- Retry (custom ~20-line helper — see research.md, `p-retry` rejected because
  the Meta-specific classifier and wait calculation must be written anyway):
  up to 4 attempts, exponential backoff with jitter (1s, 2s, 4s) for error codes
  1, 2 (or `is_transient: true`), 4, 17, 32, 613, 80000–80014, or HTTP 5xx; the
  wait honours `X-Business-Use-Case-Usage` `estimated_time_to_regain_access` /
  `X-Ad-Account-Usage` `reset_time_duration` when present. Budget-change quota
  subcode 1487632 (613) is **not** retried — it fails immediately with the
  "at most 4 budget changes per hour" message. Injected `sleep` makes tests instant.
- Pagination (custom — no maintained library, see research.md): follow
  `paging.next` until absent, never stopping on an empty page; cursors are never
  persisted.
- Every non-2xx body is parsed by `GraphErrorSchema` into `MetaApiError
  { step, code, subcode, message, userTitle, userMessage, fbtraceId }`; the bin
  shells convert it with `errorEnvelope` (FR-005). A 2xx body failing its schema
  throws `MetaApiError` with `code: "schema"` and the zod issues (FR-006).
- Uploads: `adimages` via multipart `FormData` with `Blob` → `images[name].hash`;
  `advideos` via single non-chunked multipart `source` upload (see research.md —
  the chunked `upload_phase` flow is deferred until large files appear; a local
  size check rejects files over 1 GB before any call);
  then poll `GET /{video-id}?fields=status` until `video_status: ready`
  (bounded, injected sleep).

### D4. Money (`meta/money.ts`)

Budgets/bids in briefs and plans are decimal currency (`dailyBudget: 50`). The
Graph API takes minor units. `toMinorUnits(amount, currency)` /
`fromMinorUnits(value, currency)` use offset 100 except the zero-decimal set
(`CLP COP CRC HUF ISK IDR JPY KRW PYG TWD VND`) → 1.
`// ponytail: static offset table; switch to Meta's currency list if a new zero-decimal currency appears.`
The account currency comes from `GET act_<id>?fields=currency,account_status,name,timezone_name`.

### D5. Report (`meta/report/*`, `meta/bin/report.ts`)

- Args: reuse `parseArgs` from `bin/report.ts` (`--days`, `--all-time`,
  `--include-paused`) plus `--result-action <action_type>` (default `lead`;
  also `offsite_conversion.fb_pixel_lead`, `complete_registration`, …) and
  `--attribution <windows>` (default `7d_click,1d_view`).
- `parseAttribution(raw)`: allowed `1d_click 7d_click 28d_click 1d_view 1d_ev`;
  `7d_view`/`28d_view` → `MetaConfigError` explaining removal on 2026-01-12
  (FR-008).
- Reads (`fetch.ts`, all `getAll` on `act_<id>/insights`, `time_range` from the
  reused `dateWindow`/`ALL_TIME_START` — all-time clamps to Meta's 37-month
  maximum and reports the clamped span):
  `level=campaign`; `level=campaign&time_increment=1`; `level=adset`; `level=ad`;
  `level=account&breakdowns=publisher_platform,platform_position`;
  `level=account&breakdowns=age,gender`; `level=account&breakdowns=country`;
  `level=account&breakdowns=region`.
  Fields: `campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,inline_link_click_ctr,cpm,cpc,actions,cost_per_action_type`.
  `--include-paused` absent → `filtering=[{field:"campaign.effective_status",operator:"IN",value:["ACTIVE"]}]`.
- Status/name per campaign: `getAll act_<id>/campaigns?fields=id,name,effective_status,objective`.
- `shape.ts` pure: rows → `MetaReport`:

```ts
interface MetaReport extends ReportData {        // ReportData reused from bin/report.ts
  platform: "meta";
  customer_id: string;                           // "act_<digits>" — the file-name key
  manager_id: null;
  currency: string;
  attribution: readonly AttributionWindow[];
  result_action: string;
  window: { start; end; days; partial_day };
  generated_at: string;
  recommendations: [];                           // keyword clustering is Google-only
  placements: readonly (MetaMetricDict & { publisher_platform; platform_position })[];
  demographics: readonly (MetaMetricDict & { age; gender })[];
}
type MetaMetricDict = MetricDict & { reach: number; frequency: number; cpm: number; link_clicks: number };
```
  Mapping: `ad_groups` = ad sets, `ads[].type` = `"META_AD"`, `ads[].ad_strength`
  = `"UNSPECIFIED"`, `keywords`/`search_terms` = `[]`, `conversions` = sum of
  `actions[action_type = result_action].value`, `cost_per_conversion` from
  `safeRatio`. Money fields arrive as decimal strings → numbers (no micros).
  Google `Report` output is unchanged (no `platform` key added to Google files).
- `reportPath(cwd, generatedAt, "act_<id>", reportsDir)` + existing YAML writer.
- `reference/report.md` gains a Meta branch: no keyword/search-term/ad-strength
  sections; adds placement + demographic charts, frequency, attribution note.

### D6. Audit (`meta/audit/*`, `meta/bin/audit.ts`)

- Reads (all read-only; the fake client throws on `post` in tests):
  campaigns (`id,name,objective,effective_status,daily_budget,lifetime_budget,bid_strategy,special_ad_categories`);
  ad sets (`id,name,campaign_id,effective_status,daily_budget,optimization_goal,promoted_object,targeting,learning_stage_info,is_dynamic_creative`);
  ads (`id,name,adset_id,effective_status,creative{id,degrees_of_freedom_spec,asset_feed_spec,object_story_spec}`);
  insights `level=ad` for two consecutive windows of `--days` (7/14/30, default 14)
  for fatigue; insights `level=adset` with `actions` for event volume;
  account breakdowns (`publisher_platform,platform_position`, `age,gender`).
- `scoring.ts` pure rules, each `(rows) → MetaFinding[]`, thresholds as named
  constants taken from `reference/meta/`:

| issue | fires when | severity | playbook |
| --- | --- | --- | --- |
| `learning_limited` | `learning_stage_info.status = FAIL` | high | 1-fundamentals#the-learning-phase |
| `still_learning_low_volume` | status `LEARNING` and weekly result events < 50 | medium | 3-account-structure#consolidation-rules |
| `fragmented_budget` | campaign has ≥ 3 active ad sets and median weekly events per ad set < 50 | medium | 3-account-structure#consolidation-rules |
| `creative_fatigue` | frequency ≥ 3.5 and link CTR down ≥ 25% vs previous window, spend > 0 | high | 6-analyze#creative-fatigue |
| `wasted_breakdown_spend` | segment spend share ≥ 20% and (0 results or cost/result ≥ 2× account) | medium | 6-analyze#breakdown-report-audit |
| `missing_customer_exclusion` | prospecting ad set (no custom audience in inclusions) with no `excluded_custom_audiences` | medium | 5-exclusions#existing-customers--converters |
| `weak_conversion_signal` | optimization goal is a conversion but `promoted_object.pixel_id` missing, or < 50 weekly events account-wide | high | 1-fundamentals#conversion-tracking |
| `advantage_creative_enhancements_on` | any `degrees_of_freedom_spec.creative_features_spec.*.enroll_status = OPT_IN` | low | 4-creative#dynamic--advantage-creative |

```ts
type MetaFinding = { level: "campaign" | "adset" | "ad"; entityId: string; entityName: string;
  issue: MetaIssue; severity: "high" | "medium" | "low"; detail: string; evidence: Record<string, number | string>;
  fix: string; playbook: string };
```
- Envelope: `ok({ platform: "meta", adAccountId, window, campaigns: [{ id, name, status, findings }], landingPageHealth, psi })`.
  Landing page URLs = unique ad destination links (from `asset_feed_spec.link_urls`
  / `object_story_spec.link_data.link`); PSI reuses `buildPsiRequestUrl`,
  `parsePsiResponse`, `renderPsi`, `renderLandingPageHealth`.
- `render.ts` pure `→ string[]` using the existing `ljust`/`rjust`/`pct`/`emitLines`
  and the `  ! issue: detail` line format.

### D7. Brief, publish, state (`meta/brief.ts`, `meta/publish.ts`, `meta/state.ts`, `meta/bin/create.ts`)

Meta brief (`adbriefs/<slug>.yaml`, parsed by `parseMetaBrief`, `.strict()` throughout):

```yaml
type: meta
name: <idea name>                 # slug source, as for Google
adAccountId: act_1234567890       # optional; falls back to resolveMetaContext
pageId: "1234567890"              # optional; falls back to meta_page_id
campaign:
  name: <campaign name>
  objective: OUTCOME_LEADS        # OUTCOME_LEADS | OUTCOME_SALES | OUTCOME_TRAFFIC | OUTCOME_AWARENESS | OUTCOME_ENGAGEMENT
  specialAdCategories: []         # [] | [CREDIT | EMPLOYMENT | HOUSING | ISSUES_ELECTIONS_POLITICS]
  budget:                         # discriminated on mode (FR-012: exactly one budget mode)
    mode: campaign                # campaign → dailyBudget required here, forbidden on ad sets
    dailyBudget: 100
    bidStrategy: LOWEST_COST_WITHOUT_CAP   # | COST_CAP | LOWEST_COST_WITH_BID_CAP | LOWEST_COST_WITH_MIN_ROAS
  startTime: 2026-10-01T00:00:00Z # optional
adSets:                           # 1..10
  - name: <ad set name>
    dailyBudget: 50               # required iff campaign.budget.mode = adset
    bidAmount: 40                 # required iff bidStrategy is COST_CAP / BID_CAP
    optimizationGoal: OFFSITE_CONVERSIONS  # pairing checked against objective
    conversion: { pixelId: "…", event: LEAD }   # required iff OFFSITE_CONVERSIONS
    audience:
      countries: [US]             # and/or regions / cities{key,radius,distance_unit}
      ageMin: 25
      ageMax: 65
      genders: []                 # [] = all
      locales: []
      customAudienceIds: []       # includes lookalikes
      excludedCustomAudienceIds: []
      interests: []               # [{id, name}]
      advantageAudience: false
    placements: advantage         # | { publisherPlatforms: [...], facebookPositions: [...], instagramPositions: [...] }
    ads:                          # 1..6
      - name: <ad name>
        link: https://…
        callToAction: LEARN_MORE  # LEARN_MORE | SIGN_UP | GET_QUOTE | BOOK_NOW | CONTACT_US | DOWNLOAD | SUBSCRIBE | APPLY_NOW
        primaryTexts: [ … ]       # 1..5, each ≤ 1024 chars (hard); warn > 125
        headlines: [ … ]          # 1..5, each ≤ 255 (hard); warn > 40
        descriptions: [ … ]       # 0..5, each ≤ 255 (hard); warn > 30
        media: { image: ./path.png }   # | { video: ./path.mp4, thumbnail: ./thumb.png }
        enhancements:             # explicit per key; unknown keys rejected
          enhance_cta: OPT_OUT
          text_optimizations: OPT_OUT
```

Cross-field refinements (all reported together, before any write — US4 AS4):
budget mode exclusivity; bid amount presence; objective ↔ optimization goal
allow-list; OFFSITE_CONVERSIONS ↔ conversion; special ad category forbids
`ageMin > 18`, `ageMax < 65`, gender narrowing, and interests; media files exist
and are readable; ad set / ad names unique within their parent.

Publish order (`publish.ts`), each step a pure `(state, result) → state`
transition around one client call, all created `status: PAUSED` (SC-003):

1. `upload-media` — images → hashes, videos → ids (skipped when the state
   already has a hash for the same file sha256).
2. `create-campaign` — `POST act/campaigns` (`buying_type AUCTION`, CBO budget
   when mode = campaign).
3. per ad set `create-ad-set` — `POST act/adsets` (`targeting`,
   `targeting_automation.advantage_audience`, `promoted_object`, budget when
   mode = adset).
4. per ad `create-creative` — `POST act/adcreatives` with `object_story_spec
   { page_id }` + `asset_feed_spec { bodies, titles, descriptions,
   link_urls, call_to_action_types, images|videos, optimization_type: DEGREES_OF_FREEDOM }`
   + `degrees_of_freedom_spec.creative_features_spec` from `enhancements`.
5. per ad `create-ad` — `POST act/ads { adset_id, creative: { creative_id } }`.

Resumability (FR-011, SC-004): `adbriefs/<slug>.meta-state.yaml` is written
**after every successful step** (not only on success — the Google path's gap is
not copied). On re-run each step is skipped when state holds its id; when state
lacks an id the publisher first looks the object up live by exact name under its
parent (`filtering=[{field:"name",operator:"EQUAL",value}]`, non-`DELETED`), which
covers "create succeeded, state write failed". >1 live match → `MetaApiError`
step `find-existing` naming the duplicates.

```ts
const MetaStateSchema = z.object({
  platform: z.literal("meta"),
  adAccountId: MetaAdAccountIdSchema,
  campaign: z.object({ name: z.string(), campaignId: MetaIdSchema.nullable() }).strict(),
  media: z.record(z.string() /* brief path */, z.object({ sha256: z.string(), imageHash: z.string().optional(), videoId: z.string().optional() }).strict()),
  adSets: z.array(z.object({ name: z.string(), adSetId: MetaIdSchema.nullable(),
    ads: z.array(z.object({ name: z.string(), creativeId: MetaIdSchema.nullable(), adId: MetaIdSchema.nullable() }).strict()) }).strict()),
}).strict();
```
The `.meta-state.yaml` suffix does not end in `.state.yaml`, so the Google
`loadStateIndex` never reads Meta state (no Google change). `loadMetaStateIndex`
builds `byCampaignId / byAdSetId / byAdId → { slug, names }` for `update`.

`create` CLI mirrors Google: `ads.sh create <brief.yaml> [--dry-run]
[--skip-url-check]`. Dry run prints the brief diff + planned objects and makes
zero `post`/upload calls (SC-002). Envelope: `{ ok, platform: "meta", created:
{ campaignId, adSets: [...] }, failure: { step, message, code? } | null,
briefDiff, briefSynced, stateSynced }`; exit 1 on failure.

`adbriefs/store.ts` / `diff.ts` change: functions become generic over
`StorableBrief = { name: string; campaign: { name: string } }` and
`loadBriefIfExists` / `assertNoForeignBrief` take an optional
`parse: (data: unknown) => B` defaulting to `parseAnyBrief`. Google call sites
compile and behave unchanged.

### D8. Update (`meta/plan.ts`, `meta/apply.ts`, `meta/bin/update.ts`)

Meta plan (`ads.sh update <plan.yaml> [--apply]`, `platform: meta` in the plan
also selects the Meta path):

```yaml
platform: meta
adAccountId: act_1234567890        # optional; falls back to resolveMetaContext
budgets:       [{ level: campaign | adset, id: "…", dailyBudget: 80 }]
status:        [{ level: campaign | adset | ad, id: "…", status: ACTIVE | PAUSED }]
exclusions:    [{ adSetId: "…", add: [customAudienceId…], remove: [customAudienceId…] }]
enhancements:  [{ adId: "…", features: { enhance_cta: OPT_OUT, … } }]
textPools:     [{ adId: "…", primaryTexts: [...], headlines: [...], descriptions: [...] }]
```

Flow (pure core, I/O shell):
1. `parseMetaPlan` (zod, strict, same text limits as the brief).
2. Live reads for referenced ids only (budgets, statuses, `targeting`,
   `learning_stage_info`, ad `creative{…}`), batched with `ids=` multi-get.
3. `splitChanges(entries, live, key, equals) → { changes, skips }` — one generic
   splitter used by every section (FR-013 skip-if-unchanged).
4. `validateMetaPlan(changes, live) → string[]`: unknown ids; budget increase
   > 50% rejected (mirrors Google's guardrail); CBO/ABO level mismatch (budget on
   an ad set whose campaign uses campaign budget); text limits.
5. `metaWarnings(changes, live) → { lines: string[]; enableStartsLiveSpend: Id[];
   budgetIncreases: Id[]; learningResetRisk: Id[]; exclusionIgnored: Id[] }`
   (FR-014): enable → spend; budget raise → spend; budget change > 20% or any
   targeting / creative swap on an ad set in `LEARNING` → learning reset;
   exclusions on Advantage+ (`advantage_state_info.advantage_state` ≠ `DISABLED`)
   → ignored.
6. Stage: `resolveMetaPlanGroups(plan, loadMetaStateIndex())` →
   `applyMetaPlanToBrief(brief, group) → MetaBrief` (pure) → `diffBriefs` →
   print; unresolved ids reported, not fatal.
7. Dry run → narration + `WARNING:` lines + envelope, exit 0, zero writes.
8. `--apply` → sections in order status(pause first) → budgets → exclusions →
   creative swaps (`enhancements` and `textPools` both create a new creative from
   the live creative + change, then `POST /{ad-id} { creative: { creative_id } }`)
   → status(enable last). Each entry isolated: a failure is recorded as
   `{ step, entityId, message }` and the loop continues (FR-015). Briefs and
   state are written only for slugs with no failure.
9. Envelope: `applied, budgetChanges/budgetSkipped, statusChanges/statusSkipped,
   exclusionChanges/exclusionSkipped, enhancementChanges/enhancementSkipped,
   textPoolChanges/textPoolSkipped, enableStartsLiveSpend, budgetIncreases,
   learningResetRisk, exclusionIgnored, briefs[], unresolvedPlanIds, errors[]`.

### D9. init / preflight

- `init`: first prompt `platform (google/meta) [google]`; then only that
  platform's fields (D2). The existing Google prompt order is preserved after
  the platform prompt, and the Google tests' answer arrays get one leading
  `""` (accepting the default) — the only expectation edit, which is input, not
  behaviour.
- `meta/bin/preflight.ts`: steps `credentials` (token + account resolved) →
  `auth` (`GET /me?fields=id,name`) → `access`
  (`GET act_<id>?fields=name,account_status,currency,disable_reason`;
  `account_status ≠ 1` → `ok:false` naming the status) → `permissions`
  (`GET /me/permissions`; missing `ads_read` / `ads_management` named).

### D10. Google-only commands

`research.ts` / `keyword-ideas.ts`: if the resolved platform is `meta`, emit
`errorEnvelope("research is Google-only; Meta has no keyword planner equivalent", { step: "platform" })`, exit 1.

## Parse Boundaries

**Trust boundaries** (raw input kept `unknown` until parsed):

| Raw input | Enters at | Parsed by |
| --- | --- | --- |
| `--platform`, `ADKIT_PLATFORM`, `adkit.yaml platform` | `cli/platform.ts` | `parsePlatform` |
| `--ad-account`, `META_AD_ACCOUNT_ID`, `meta_ad_account_id`, brief/plan `adAccountId` | `meta/config.ts`, `meta/brief.ts`, `meta/plan.ts` | `parseMetaAdAccountId` |
| `meta_access_token` / `META_ACCESS_TOKEN`, app id/secret, page/pixel ids | `meta/config.ts` | `resolveMetaContext` |
| `--result-action`, `--attribution`, `--days` | `meta/bin/report.ts`, `meta/bin/audit.ts` | `parseAttribution`, reused `parseArgs` |
| Meta brief YAML (`yamlParse` → `unknown`) | `meta/bin/create.ts` | `parseMetaBrief` |
| Meta plan YAML | `meta/bin/update.ts` | `parseMetaPlan` |
| `.meta-state.yaml` | `meta/state.ts` | `parseMetaState` |
| Graph API JSON (`res.json()` → `unknown`) | `meta/client.ts` | per-call zod schema in `meta/graph.ts`; errors via `GraphErrorSchema` |
| Local media bytes | `meta/publish.ts` | `readMedia` → `{ name, bytes, sha256 }` (existence/readability checked once, in brief refinement) |

**Domain types** (`meta/ids.ts`, nominal via zod `.brand()`):
`MetaAdAccountId` (`act_<digits>`, canonical form), `MetaCampaignId`,
`MetaAdSetId`, `MetaAdId`, `MetaCreativeId`, `MetaPageId`, `MetaPixelId`,
`MetaCustomAudienceId`, `MetaVideoId`, `ImageHash`, `MetaAccessToken`. All ids
that can be confused with one another are branded separately so an ad set id
cannot be passed where an ad id is expected. `Platform` is a closed union.
Also `MetaBrief`, `MetaPlan`, `MetaState`, `AttributionWindow` (literal union),
`CurrencyCode`.

**Parsers** (brand casts live only in the owning module):

- `parseMetaAdAccountId(raw: unknown, source: string): Result<MetaAdAccountId>`
  in `meta/ids.ts` — accepts `123`, `act_123`, trims; returns
  `{ kind: "ok", value } | { kind: "err", message }`.
- `parsePlatform(raw: unknown, source: string): Result<Platform>` in `cli/platform.ts`.
- `parseAttribution(raw: string | undefined): Result<readonly AttributionWindow[]>` in `meta/report/fetch.ts`.
- `parseMetaBrief(data: unknown): Result<MetaBrief>` in `meta/brief.ts` — collects
  every zod issue into one message list.
- `parseMetaPlan(data: unknown): Result<MetaPlan>` in `meta/plan.ts`.
- `parseMetaState(data: unknown): Result<MetaState>` in `meta/state.ts`.
- `parseGraph<T>(schema, body: unknown): Result<T>` in `meta/client.ts`; the
  client turns `err` into `MetaApiError` at the I/O edge, so pure code only ever
  sees parsed `T`.

The bin shells are the only place a `Result` `err` becomes an `ok:false`
envelope + exit code.

**Library choice**: zod 3 — already the project's parser for briefs, plans and
PSI responses; no new schema dependency.

## Delivery Waves

| Wave | Slice | Depends on |
| --- | --- | --- |
| W0 | platform + config + ids + errors + money + client + graph schemas + store/diff generalisation | — |
| W1 | init/preflight (US1) · report (US2) · audit (US3) · brief/state/publish/create (US4) · docs | W0 |
| W2 | plan/apply/update (US5) | W0, US4 (brief + state index) |
| W3 | Google-only refusals, full suite + typecheck, quickstart walk-through | W1, W2 |

## Risks

- **No live account**: request shapes (esp. `asset_feed_spec` + `DEGREES_OF_FREEDOM`
  on non-dynamic ad sets, `targeting_automation`, video upload status polling)
  are verified only against Meta's reference docs and mocks. Quickstart lists
  the live smoke test to run once a token exists.
- **Meta API churn**: one pinned version constant; a version bump is a one-line
  change plus fixture review.
- **PR #76 dependency**: `reference/meta/*` links resolve only after #76 merges;
  merge `main` into this branch before the docs tasks.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Separate `src/meta/bin/*` mains instead of branching inside each Google bin | Google bins (`apply-fixes.ts` 1.7k lines, `audit.ts` 1.4k) are Google-shaped end to end | Extracting a shared orchestrator first touches every Google path and risks FR-018 for no user-visible gain |
| `src/meta/money.ts` static currency table | Graph API has no currency-offset endpoint | Assuming cents would mis-spend 100× on JPY/KRW accounts |
