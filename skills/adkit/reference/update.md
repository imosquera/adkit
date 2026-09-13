---
description: "Apply deterministic updates from an /adkit audit to a live campaign via a validated plan: RSA/extension/negative/budget edits, positive-keyword editing, adding whole new ad groups, and campaign on/off (ads.sh update). Dry-run unless --apply."
argument-hint: "[--customer <10-digit>] [--apply]  (author an update plan YAML from an /adkit audit, then validate + apply it)"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## Role

You apply the updates that an `/adkit audit` identified. The audit is read-only; this skill mutates. The split is deliberate (see `reference/conventions.md` → *Division of labor*):

- **You author the creative update** — when a gap needs new copy, *you* write the 15 headlines / 4 descriptions tuned to that ad group's real keyword (templated, keyword-agnostic copy is what grades POOR).
- **The CLI validates and mutates** — you write an update plan (YAML); `ads.sh update` re-validates it against the RSA rules and applies it. **Dry-run unless `--apply`.**

Mechanics (ads.sh invocation, customer-id resolution, the JSON envelope, credentials/preflight) are in **`reference/conventions.md`** — read it once. Run `ads.sh preflight` once per session.

**Before proceeding, read:**
- [`reference/google/4-ad-copy.md`](google/4-ad-copy.md) — headline pools and pinning rules (used when authoring replacement copy)
- [`reference/google/5-negative-keywords.md`](google/5-negative-keywords.md) — negative categories and starter buckets (used when adding negatives)

## Inputs

Start from an `/adkit audit` run (JSON on stdout: per-ad `issues`, `keywords`, `actionItems`, `pathToExcellent`; per-campaign sitelink/callout counts and impression-share recommendations). The audit's `pathToExcellent` is the to-do list this skill closes.

## 1. Author the update copy (your job)

For every ad with `headlines_under`, `descriptions_under`, `duplicate_headlines`, `description_echoes_headline`, `banned_phrase`, or a keyword-inclusion gap: write a full **15 headlines / 4 descriptions** set (or, to preserve good existing copy, a list of headlines to *append*). Tune to that ad group's `keywords` from the audit report. Follow the RSA rules in `create.md` — ≤30-char headlines, ≤90-char descriptions, no pins, the keyword in ≥3 headlines, distinct angles, bottom-of-funnel + ROI/margin language.

## 2. Write the update plan

The `update` validator accepts this shape (all sections optional — include only what you're changing). The plan is **YAML** — the same format `/adkit create` and the `adbriefs/<slug>.yaml` source of truth use, so there is one config format across the toolkit. (A legacy `.json` plan still works — JSON is a subset of YAML, parsed through the same front door — but author new plans in YAML.)

```yaml
customerId: "1111111111"
landingUrl: "https://www.example.com/ideas/<slug>"
rewrites:
  - adId: 813530865969
    headlines: ["…15…"]
    descriptions: ["…4…"]
    finalUrl: "https://…"
appendHeadlines:
  - adId: 813624796200
    add: ["Affordable Close Add-On", "No Full-Suite Lock-In"]
sitelinks:
  - campaignId: 23966750362
    add:
      - text: "Book a Demo"
        finalUrl: "https://…"
        description1: "…≤35…"
        description2: "…≤35…"
callouts:
  - campaignId: 23966750362
    add: ["No new portal", "Live in 30 days", "Built for SMB", "Free to start"]
    remove: ["Payment Plans Available"]
negatives:
  - campaignId: 23955052962
    add: ["free", { text: "talk to ai", matchType: "PHRASE" }]
keywords:
  - adGroupId: 1789
    add: ["ai customer reply tool", { text: "brand voice ai", matchType: "EXACT" }]
    remove: [{ text: "ai writing", matchType: "BROAD" }]
    pause: [{ text: "ai chatbot", matchType: "PHRASE" }]
adGroups:
  - campaignId: 23955052962
    adGroup:
      name: "ai close assistant"
      defaultBidMicros: 2000000
      responsiveSearchAds:
        - headlines: ["…15…"]
          descriptions: ["…4…"]
          finalUrl: "https://…"
        - headlines: ["…15…"]
          descriptions: ["…4…"]
          finalUrl: "https://…"
      keywords: ["ai close assistant", { text: "ai deal closer", matchType: "EXACT" }]
budgets:
  - campaignId: 23955052962
    dailyMicros: 50000000
    maxRaisePct: 100
campaignStatus:
  - campaignId: "23955052962"
    status: "ENABLED"
adGroupStatus:
  - adGroupId: "200325112680"
    status: "PAUSED"
adStatus:
  - adId: "816978549834"
    status: "ENABLED"
searchPartners:
  - campaignId: "23955052962"
    enabled: false
languages:
  - campaignId: 23969397981
```

- **`rewrites`** replace *all* assets on an ad; **`appendHeadlines`** merge with the live headlines (preserve the good ones, top up to 15). An optional **`finalUrl`** (https) on a rewrite **repoints the ad's landing page**; it may accompany the 15/4 copy or stand alone — a rewrite carrying only `finalUrl` is a **URL-only repoint** that leaves the live copy untouched (the fix for a new ad group's ad pointing at the wrong page). An empty rewrite (no copy and no `finalUrl`) is rejected.
- **`sitelinks`** — text ≤25 chars; descriptions are **both-or-neither** (one line alone is rejected by Google), each ≤35 chars; `finalUrl` https. A `remove` list retracts live sitelinks by text (a bare string or `{"text"}`); see the retraction note under `callouts`.
- **`callouts`** — plain phrases ≤25 chars, no URL, distinct/non-repetitive. A `remove` list (bare strings, matched against the live text case-insensitively) **retracts** a published callout. This is the supported way to withdraw a claim the source idea no longer backs — a callout like "Payment Plans Available" becomes a **false claim** the moment the offering changes, and the honest-use gate in `reference/google/4-ad-copy.md` is binding. The remove unlinks the asset **from that campaign** (the `campaign_asset` link), leaving the account-level asset intact for any other campaign using it. Like `keywords`, the validator **rejects the whole plan** if a `remove` names something not actually live on the campaign, so a typo fails at dry-run rather than silently doing nothing. `add` and `remove` may appear in the same block.
- **`negatives`** add **campaign-level negative keywords** — the direct fix for "spending on clicks you don't need" / search-term waste. Each `add` item is a bare string (defaults to **PHRASE**) or `{"text","matchType"}` with matchType `EXACT`/`PHRASE`/`BROAD`. Negatives already on the campaign are skipped, so a plan is **safe to re-run**. (Campaign-scoped here; for a list shared across many campaigns, build it once in the UI under *Tools → Shared library*.) To find candidates, pull search terms with `ads.sh report <customer> --days 30` and target the zero-conversion queries.
- **`keywords`** edit the **positive keywords on an ad group** — the lever for a horizontal→vertical pivot. `add` items are bare strings (PHRASE) or `{"text","matchType"}`; `remove`/`pause` are `{"text","matchType"}` identifying a *live* criterion (the match type is part of the identity). A **match-type change is a remove + add** of the same text (match type is immutable on a live criterion — Google has no in-place update). The validator **rejects the whole plan** if a `remove`/`pause` target isn't present on the ad group; ADDs already live are skipped, so re-running is **idempotent**. Find the `adGroupId` and live keywords in the audit report's per-ad `keywords`.
- **`adGroups`** add a **whole new ad group to an existing campaign** — the lever for a coverage gap the audit surfaces (a Keyword Theme with no ad group, or a horizontal group that should split into a tighter vertical one). `campaignId` is digits-only; `adGroup` is the **same shape a `/adkit create` brief ad group uses**: `name`, `defaultBidMicros` (≤ $15 CPC), **exactly 2** `responsiveSearchAds` (each **15 headlines / 4 descriptions**, `finalUrl` https, optional `path1`/`path2`, and genuinely distinct angles — same two-angle rule as `/adkit create`), and 1–30 `keywords`. Headlines/descriptions are bare strings and keywords are bare strings (PHRASE) or `{"text","matchType"}` — the same ergonomics as the rest of the plan. The validator enforces the **identical RSA/keyword rules** `/adkit create` does (author the copy per §1: keyword in ≥3 headlines, distinct angles, no pins), so a bad ad group is **rejected at dry-run**, not mid-apply. **Idempotent** — an ad-group name already live in the campaign (case-insensitive) is reported **skipped**, never duplicated. Each new group is created with its **RSA PAUSED**, so it **cannot serve (no live spend) until you enable its ad** — flip it on in the UI or with a later status change once vetted.
- **`budgets`** set a campaign's **daily budget** (`dailyMicros`) — the lever for `budget_constrained` impression-share loss. Because this spends real money it carries a hard guardrail: a raise **above 50%** over the current budget is **rejected** (a plan's `maxRaisePct` can only *lower* that ceiling, never raise it); lowering is always allowed.
- **`bidding`** set a campaign's **bid strategy** — `campaignId`, `strategy` (`maximize-clicks` / `maximize-conversions` / `target-cpa` / `target-roas`), and the matching optional field: `cpcBidCeilingMicros` (valid only with `maximize-clicks`), `targetCpaMicros` (valid only with `target-cpa`, required for it), or `targetRoas` (valid only with `target-roas`, required for it) — same rules `/adkit create` briefs already enforce. **Idempotent** — the campaign's live strategy (and target/ceiling value) is read first, and an entry that requests what's already live is reported **skipped**, not re-mutated; changing only the target/ceiling value while keeping the same strategy still counts as a real change — including on a spend-affecting strategy, where a target-only tweak (e.g. raising `targetCpaMicros` while staying on `target-cpa`) still triggers the same warning described below, not just an actual strategy switch. Graduating up into any strategy other than `maximize-clicks` (`maximize-conversions`, `target-cpa`, `target-roas`) is never *refused*, but it **is** surfaced loudly — a `WARNING:` line plus a distinct `bidStrategyChangeAffectsSpend` key (array of affected campaign ids) in the JSON envelope, since these strategies let the platform optimize spend and can behave unpredictably on low conversion volume (the same volume risk the `cold_start_throttle` audit finding warns about). Downgrading **specifically `maximize-conversions` → `maximize-clicks`** is additionally **refused** when the campaign has **≥30 conversions in the trailing 30 days**, unless the entry sets `acknowledgeStrategyDowngrade: true`; downgrading to `maximize-clicks` is otherwise always safe and never warns (no other direction is guarded). A `cpcBidCeilingMicros` below the campaign's own trailing-30-day average CPC prints a separate, non-blocking `WARNING:` (it would likely starve the campaign of traffic) but still applies.
- **`campaignStatus`** flip a campaign **on (`"ENABLED"`) or off (`"PAUSED"`)**. `campaignId` is digits-only; `status` is `ENABLED`/`PAUSED`. **Idempotent** — each campaign's live status is read first and a flip into the status it is already in is reported **skipped**, not mutated. **PAUSE is always safe; ENABLE starts live spend**, so it is surfaced loudly: a `WARNING:` line and a distinct `enableStartsLiveSpend` key in the JSON envelope — never silent. `/adkit create` always publishes **PAUSED**, so this is how a vetted campaign goes live (and how you pause one that's overspending).
- **`adGroupStatus`** flip a whole **ad group on/off** — the lever for a dead-weight ad group (wrong-intent keywords dragging CTR → Quality Score → Ad Rank): pause the group in one line instead of pausing its keywords one by one, and it stays reversible without having to re-add anything. `adGroupId` is digits-only; `status` is `ENABLED`/`PAUSED`. Same contract as `campaignStatus` one level down: **idempotent** (no-op flips reported **skipped**), **PAUSE always safe** (stops the group's keywords from serving without touching the keywords), **ENABLE resumes live spend** and is surfaced loudly (`WARNING:` line + `adGroupEnableStartsLiveSpend` key). Prefer this over `keywords`+`pause` when the intent is to shut off the *entire* ad group.
- **`adStatus`** flip a **single ad (ad_group_ad) on/off** — the lever for the **PAUSED ad every new `adGroups` group ships with**: enable it to make the group serve. `adId` is digits-only; `status` is `ENABLED`/`PAUSED`. The ad's parent ad-group id is **resolved from live state** (an ad_group_ad resource name needs both ids, but you only carry the `adId` from the audit). Same contract as `adGroupStatus` one level down: **idempotent** (no-op flips reported **skipped**), **PAUSE always safe**, **ENABLE starts live serving** and is surfaced loudly (`WARNING:` line + `adEnableStartsLiveSpend` key). This is how a vetted new ad group goes live.
- **`languages`** set a campaign's **language targeting to English only** — the lever for a campaign inadvertently serving in every language (Google's default). `campaignId` is digits-only; there are no other fields. It **adds the English language criterion and removes any other live language criteria** so the campaign is English-exclusive (Google's default is an implicit "all languages" with no criteria — adding one narrows it). **Idempotent** — a campaign already targeting English only is reported **skipped**, never duplicated. Narrowing language only reduces reach, so it is always safe (no live-spend warning).
- **`searchPartners`** toggle a campaign's **Google Search Partners** setting (`network_settings.target_search_network`) — use this to restrict a campaign to Google Search results only. `campaignId` is digits-only; `enabled` is a boolean. **Idempotent** (a flip into the setting it's already at is reported **skipped**, never mutated). Turning it **off** (`enabled: false`) only narrows reach and is always safe; turning it **on** (`enabled: true`) increases reach (and potential spend), so it's surfaced loudly (`WARNING:` line + `searchPartnersEnableIncreasesReach` key). `enabled: true` is **rejected at validation** (not left to fail live) if the campaign's `target_google_search` is off — Google Ads requires Google Search targeting to be on before Search Partners can be. The Display Network (`target_content_network`) stays off regardless, per existing convention — this only ever touches the Search Partners bit.

## Local brief (`adbriefs/`) — source of truth + review gate

Each campaign persists as **two sibling files** under `adbriefs/`, written by `/adkit create` (Terraform-style intent vs. state):

- **`adbriefs/<slug>.yaml`** — the **intent brief**: names + copy only, the account-independent source of truth. Portable and replayable; it deliberately carries **no live ids**.
- **`adbriefs/<slug>.state.yaml`** — the **state file**: the `name ↔ live id` map (`campaignId`, per-ad-group `adGroupId`/`adIds` — one entry per published RSA, RSAS_PER_AD_GROUP on a freshly-created ad group) Google assigned at publish time. This is what lets an id-keyed update plan be resolved back to the brief entity it names, with **no extra live queries**. Accepts either bare numeric ids or the full Ads resource-name format older state files predate (normalized to bare ids at parse time), and the pre-2-RSA singular `adId` key for state files written before this change.

See `reference/conventions.md` → *`adbriefs/` — the local source of truth + diff-before-apply gate* for the format and the write-brief → diff → apply flow. `ads.sh update` **stages every run** — dry-run and `--apply` alike — mirroring `create`'s review gate:

1. **Resolve.** Every `adId`/`adGroupId`/`campaignId` the plan touches is resolved back to its owning `adbriefs/<slug>.yaml` via that campaign's `<slug>.state.yaml` (the reverse id index) — **no extra live queries**. A plan touching more than one campaign resolves to more than one slug; each gets its own independent diff and (on `--apply`) its own independent write — never one combined diff across campaigns.
2. **Stage + diff.** The plan's already-computed changes (rewrites, `appendHeadlines` — merged with a **case-sensitive exact-match dedup** against the brief's existing headlines — negatives, keywords, sitelinks, callouts, budgets, bidding) are applied to a proposed in-memory copy of the resolved brief and diffed against what's on disk with `diffBriefs`. A staged `bidding` change that would produce an invalid `cpcBidCeilingMicros`/`bidStrategy` pairing is caught here too — the proposed brief is re-parsed through the same `BriefSchema` every other brief write goes through, so this rule is enforced once, not duplicated in the plan validator. The diff is printed on **every run**, before the planned-actions narration. A no-op plan shows an empty diff and is never rewritten.
3. **Apply.** On `--apply`, the live mutation runs first, exactly as before this feature; only once it completes successfully is the staged brief written to `adbriefs/<slug>.yaml`. A failed or partial `--apply` leaves every affected brief **byte-for-byte unchanged** and the JSON envelope reports `briefSynced: false` for it, plus an explicit "diverged" warning naming what didn't apply — the brief is never left asserting a state the live account doesn't actually have.

Several degrade paths, all loud, never silent — every one reports through the envelope as `briefStagingSkipped: true` with a `briefStagingSkipReason` naming which:

- **`"unresolvable-id"`** — an id the state file has no record of (a stale ad, or one created outside `adkit`) skips staging only for that entity, with a `WARNING:` line naming the unresolvable id; every other entity in the same plan that *does* resolve is still staged and diffed normally, and the live mutation for the unresolved entity proceeds unaffected.
- **`"no-state-file"`** — a campaign with no `adbriefs/<slug>.state.yaml` at all (predates this feature) skips brief staging entirely for that campaign — the live mutation still runs to completion as it always did.
- **`"collision"`** — the on-disk `adbriefs/<slug>.yaml` names a *different* campaign than the state index resolved (FR-007); staging is refused for that slug so it is never overwritten with the wrong campaign's data.
- **`"missing-brief"`** — a `<slug>.state.yaml` exists but its `adbriefs/<slug>.yaml` was deleted by hand; staging is skipped rather than fabricated, and live mutation still proceeds for that entity.
- **`"invalid-brief"`** — the on-disk `adbriefs/<slug>.yaml` fails to parse (corrupt YAML or a schema violation); staging is skipped for that campaign alone, an unrelated resolved campaign in the same plan is unaffected.
- **`"invalid-result"`** — staging the plan's changes onto the on-disk brief would itself produce a brief violating `BriefSchema` (e.g. more than 15 headlines after a dedup-survives append, or an empty `keywords` list after a remove-only edit); the result is never diffed or written, only skipped.
- **`"live-mutation-failed"`** — used specifically when a live-mutation step (or a subsequent brief write) throws; see `reference/conventions.md` → *Per-slug failure isolation* for exactly which slug(s) it's attributed to.

The envelope also carries a `briefs: [{ slug, briefPath, briefSynced, briefDiff }]` array — one entry per resolved slug, for both dry-run and apply.

## 3. Dry-run, then apply

```bash
ads.sh update plan.yaml            # dry-run: validates + prints planned actions
ads.sh update plan.yaml --apply     # mutate live
```

(`ads.sh apply-fixes` is a **deprecated alias** for `ads.sh update` — prefer `update`.)

`update` re-validates against the RSA rules and **refuses a bad plan**. Always dry-run first and confirm the planned actions match intent. Edits are in-place (`mutate_ads`), so ad ids and history are preserved; `ad_strength` shows `PENDING` until Google recomputes (minutes–hours).

## 4. Report

Surface, per campaign: what you changed, and what you deliberately left (e.g. a converting POOR ad — never pause a converting ad to chase ad strength; enrich it). If you flipped any campaign to `ENABLED`, call out that it now spends. `--apply` auto-syncs `adbriefs/<slug>.yaml` for every resolved brief (see §2), so `git status` should show exactly the brief changes the plan implies — call out any slug the envelope reports as unsynced (`briefSynced: false` or `briefStagingSkipped: true`) so the operator knows the local brief still needs attention.

## Meta plans (`platform: meta`)

Meta campaigns published by `/adkit create` (`type: meta` briefs) are updated through the same command. `platform: meta` in the plan selects the Meta path, as do `--platform meta`, `ADKIT_PLATFORM=meta`, and `platform: meta` in `adkit.yaml`. The Google sections above don't apply. Same contract: **dry-run unless `--apply`**, every section optional, and ids come from the Meta `/adkit audit` / `/adkit report` output.

**Before proceeding, read:**
- [`reference/meta/6-analyze.md`](meta/6-analyze.md): scaling signals, what resets learning, creative fatigue

```yaml
platform: meta
adAccountId: act_1234567890        # optional; falls back to --ad-account / META_AD_ACCOUNT_ID / meta_ad_account_id (a different --ad-account is refused)
budgets:
  - { level: campaign, id: "120210000000000001", dailyBudget: 80 }   # account currency, decimal
  - { level: adset, id: "120210000000000002", dailyBudget: 40 }
status:
  - { level: ad, id: "120210000000000010", status: PAUSED }        # campaign | adset | ad; ACTIVE | PAUSED
  - { level: campaign, id: "120210000000000001", status: ACTIVE }
exclusions:
  - adSetId: "120210000000000002"
    add: ["2384000000001"]         # custom audience ids to exclude
    remove: []
enhancements:
  - adId: "120210000000000010"
    features: { enhance_cta: OPT_OUT, text_optimizations: OPT_OUT }
textPools:
  - adId: "120210000000000011"
    primaryTexts: ["…1–5…"]
    headlines: ["…1–5…"]
    descriptions: ["…0–5…"]
```

- **`budgets`** set a daily budget at the level that owns it: `campaign` for a campaign budget (CBO), `adset` for ad set budgets (ABO). A budget on the wrong level is **rejected** (e.g. an ad set whose campaign uses campaign budget). As with Google, a raise **above 50%** is **rejected**. Any raise prints a `WARNING:` and lands in `budgetIncreases`.
- **`status`** pause or enable a campaign, ad set, or ad. **PAUSE is always safe. ACTIVE starts live spend**: `WARNING:` line + `enableStartsLiveSpend`. `/adkit create` publishes everything PAUSED, so this is how a vetted Meta campaign goes live. Enabling a campaign alone doesn't serve its paused ad sets and ads, so list every level you mean to turn on.
- **`exclusions`** add or remove excluded custom audiences on an ad set (customers, converters, employees; see [`reference/meta/5-exclusions.md`](meta/5-exclusions.md)). On an **Advantage+** campaign (`advantage_state` not `DISABLED`), ad-set exclusions are ignored by delivery: the entry still applies, but it warns and lands in `exclusionIgnored`. Use account controls there instead.
- **`enhancements`** set Advantage+ creative features per ad (`OPT_IN` / `OPT_OUT`). **`textPools`** replace an ad's primary texts / headlines / descriptions, with the same limits and angle rules as the brief (see *Meta campaigns* in `create.md`). Meta creatives are immutable, so both **create a new creative** from the live one plus your change and swap it onto the ad. That swap is a significant edit.
- **Skip-if-unchanged.** Every entry is compared to live state first, and an entry that asks for what is already live is reported in the section's `…Skipped` list, not mutated. Re-running a plan is safe.

**Learning resets.** The warning only concerns ad sets whose live `learning_stage_info.status` is `LEARNING`. For such an ad set, a budget change over **20%** (on the ad set, or on its campaign's budget), a targeting change (`exclusions`), or a creative swap on one of its ads (`enhancements`, `textPools`) may restart learning. It is never refused, but it prints `WARNING: ad set <id> is in LEARNING; <change> may reset learning` and the ad set id lands in `learningResetRisk`. Changes to ad sets that are not in `LEARNING` produce no such warning. Before applying, check [Scaling Signals](meta/6-analyze.md#scaling-signals). Raise budget about 20% at a time and wait 3–7 days between raises ([Vertical Scaling](meta/6-analyze.md#vertical-scaling-more-budget)). Batch significant edits into one plan rather than spreading them over the week, and never change budget and creative in the same plan if you want to know what moved cost per lead.

**Apply order and isolation.** `--apply` runs pauses first → budgets → exclusions → creative swaps → enables last, so nothing new spends before the rest has landed. Each entry is isolated: a failure is recorded in `errors[]` as `{ step, entityId, message, slugs }` (`step` is `status`, `budget`, `exclusions`, or `creative-swap`) and the run continues. Like Google, the plan is staged onto the owning brief via `adbriefs/<slug>.meta-state.yaml` and the diff is printed on every run. Ids with no state record are reported in `unresolvedPlanIds`, not fatal. On `--apply`:

- **Briefs are gated on failures.** A staged brief is written only when no failed entry touches its slug; otherwise it is left unchanged, `briefSynced: false`, and the narration lists it as `NOT updated (would have changed +A/-R)`.
- **Creative swaps are always recorded in state.** Every successful swap's new creative id is written to that slug's `.meta-state.yaml`, even when another entry for the same slug failed, so state keeps mirroring the live ads. If that write fails, it is an `errors[]` entry with `step: "write-state"` plus a `WARNING:` that the state file no longer matches the live ads and must be fixed before the next run. A failed brief write is `step: "write-brief"`.
- **Divergence is announced.** Any failure prints `WARNING: local brief(s) / .meta-state.yaml and the live account have diverged — N step(s) failed partway through this run:`, then one `  - <step> <entityId>: <message>` line per error with its affected brief(s).

**Validation.** After reading live state and dropping already-satisfied entries, the remaining changes are checked against live state as a whole: an id that isn't live at its level, a budget on the wrong level (CBO vs ABO) or on a lifetime-budget entity, and a raise above 50%. An id counts as "not live" only when Graph says the object does not exist or is not visible — code `803`, or code `100` with subcode `33`; that id is left out of the live read and reported here. Any other Graph error during the read (a bad field, a permission problem, a throttle that outlasts the retries) fails the run at `step: "read-live"`. (Shape problems such as text-pool limits are caught earlier, when the plan file is parsed: exit 2, `step: "plan"`.) Any violation blocks the entire run before anything is staged or written: stdout prints `VALIDATION FAILED:` with one `  - <reason>` line per problem, then the envelope `{ ok: false, message: "validation failed: …", step: "validate", errors: [<reason>, …] }` (here `errors` is a list of strings), exit 1. Fix the plan and re-run the dry run.

**Exit codes** (as for Google's `update`):

| Exit | Meaning | stdout envelope |
| --- | --- | --- |
| `0` | success, including every dry run | `ok: true` with the keys below |
| `1` | `VALIDATION FAILED` (`step: "validate"`), a credentials / live-read / local-state failure (`step: "credentials"`, `"ad-account"`, `"config"`, `"read-live"`, `"state"`, `"stage-briefs"`), at least one failed entry on `--apply` (`step: "apply"`, including `write-brief` / `write-state` errors), or an unexpected error (`step: "unexpected"`) | `{ ok: false, message, step, … }` |
| `2` | bad arguments (`step: "args"`: no plan path, `--ad-account` with no value, or a `--ad-account` that differs from the plan's `adAccountId`) or a plan file that is missing, not valid YAML, or fails the plan schema (`step: "plan"`) | `{ ok: false, message, step }` |

Narration (brief diffs, `validation ok. planned actions:`, `WARNING:` lines) is printed before the JSON envelope, which is the last thing on stdout.

Envelope keys (on success, and also on an `--apply` failure alongside `ok: false`, `message`, `step: "apply"`): `platform: "meta"`, `applied`, `budgetChanges` / `budgetSkipped`, `statusChanges` / `statusSkipped`, `exclusionChanges` / `exclusionSkipped`, `enhancementChanges` / `enhancementSkipped`, `textPoolChanges` / `textPoolSkipped`, the warning keys `enableStartsLiveSpend`, `budgetIncreases`, `learningResetRisk`, `exclusionIgnored`, plus `briefs[]` (`{ slug, briefPath, briefSynced, briefDiff: { changed, added, removed } | null, briefStagingSkipped, briefStagingSkipReason: "missing-brief" | "invalid-brief" | null }`), `unresolvedPlanIds`, and `errors[]` (`[]` on success; on `--apply` failure `{ step, entityId, message, slugs }`, where `step` may also be `write-brief` or `write-state`). `briefSynced` is always `false` on a dry run (nothing is written). Report every id in a warning key to the operator. A non-empty `errors[]` means the live account and the brief have diverged for the listed `slugs`.

## Notes

- `update` can change budgets (`budgets`), bid strategy (`bidding`), add negatives (`negatives`), add whole new ad groups (`adGroups`), flip a campaign on/off (`campaignStatus`) or an ad group on/off (`adGroupStatus`), and it improves ad strength (which feeds Ad Rank) by closing `pathToExcellent` gaps. It **cannot** change geo/schedule — the operator does that in the UI. For `rank_constrained` IS loss, adding negatives to cut junk clicks (or pausing a whole wrong-intent ad group) lifts CTR → Quality Score → Ad Rank.
- A persistent "Add N more sitelinks" `action_item` while a campaign already shows 6 sitelinks usually means they're pending review or not eligible — check approval status, don't blindly add more.
