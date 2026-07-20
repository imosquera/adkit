---
description: "Apply deterministic updates from an /adkit audit to a live campaign via a validated plan: RSA/extension/negative/budget edits, positive-keyword editing, adding whole new ad groups, and campaign on/off (ads.sh update). Dry-run unless --apply."
argument-hint: "[--customer <10-digit>] [--apply]  (author an update plan JSON from an /adkit audit, then validate + apply it)"
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
- **The CLI validates and mutates** — you write an update plan (JSON); `ads.sh update` re-validates it against the RSA rules and applies it. **Dry-run unless `--apply`.**

Mechanics (ads.sh invocation, customer-id resolution, the JSON envelope, credentials/preflight) are in **`reference/conventions.md`** — read it once. Run `ads.sh preflight` once per session.

**Before proceeding, read:**
- [`reference/google/4-ad-copy.md`](google/4-ad-copy.md) — headline pools and pinning rules (used when authoring replacement copy)
- [`reference/google/5-negative-keywords.md`](google/5-negative-keywords.md) — negative categories and starter buckets (used when adding negatives)

## Inputs

Start from an `/adkit audit` run (JSON on stdout: per-ad `issues`, `keywords`, `actionItems`, `pathToExcellent`; per-campaign sitelink/callout counts and impression-share recommendations). The audit's `pathToExcellent` is the to-do list this skill closes.

## 1. Author the update copy (your job)

For every ad with `headlines_under`, `descriptions_under`, `duplicate_headlines`, `description_echoes_headline`, `banned_phrase`, or a keyword-inclusion gap: write a full **15 headlines / 4 descriptions** set (or, to preserve good existing copy, a list of headlines to *append*). Tune to that ad group's `keywords` from the audit report. Follow the RSA rules in `create.md` — ≤30-char headlines, ≤90-char descriptions, no pins, the keyword in ≥3 headlines, distinct angles, bottom-of-funnel + ROI/margin language.

## 2. Write the update plan

The `update` validator accepts this shape (all sections optional — include only what you're changing):

```json
{
  "customerId": "8911925499",
  "landingUrl": "https://www.example.com/ideas/<slug>",
  "rewrites":        [{"adId": 813530865969, "headlines": ["…15…"], "descriptions": ["…4…"], "finalUrl": "https://…"}],
  "appendHeadlines": [{"adId": 813624796200, "add": ["Affordable Close Add-On", "No Full-Suite Lock-In"]}],
  "sitelinks":       [{"campaignId": 23966750362, "add": [{"text": "Book a Demo", "finalUrl": "https://…", "description1": "…≤35…", "description2": "…≤35…"}]}],
  "callouts":        [{"campaignId": 23966750362, "add": ["No new portal", "Live in 30 days", "Built for SMB", "Free to start"]}],
  "negatives":       [{"campaignId": 23955052962, "add": ["free", {"text": "talk to ai", "matchType": "PHRASE"}]}],
  "keywords":        [{"adGroupId": 1789, "add": ["ai customer reply tool", {"text": "brand voice ai", "matchType": "EXACT"}], "remove": [{"text": "ai writing", "matchType": "BROAD"}], "pause": [{"text": "ai chatbot", "matchType": "PHRASE"}]}],
  "adGroups":        [{"campaignId": 23955052962, "adGroup": {"name": "ai close assistant", "defaultBidMicros": 2000000, "responsiveSearchAd": {"headlines": ["…15…"], "descriptions": ["…4…"], "finalUrl": "https://…"}, "keywords": ["ai close assistant", {"text": "ai deal closer", "matchType": "EXACT"}]}}],
  "budgets":         [{"campaignId": 23955052962, "dailyMicros": 50000000, "maxRaisePct": 100}],
  "campaignStatus":  [{"campaignId": "23955052962", "status": "ENABLED"}],
  "adGroupStatus":   [{"adGroupId": "200325112680", "status": "PAUSED"}],
  "adStatus":        [{"adId": "816978549834", "status": "ENABLED"}],
  "searchPartners":  [{"campaignId": "23955052962", "enabled": false}],
  "languages":       [{"campaignId": 23969397981}]
}
```

- **`rewrites`** replace *all* assets on an ad; **`appendHeadlines`** merge with the live headlines (preserve the good ones, top up to 15). An optional **`finalUrl`** (https) on a rewrite **repoints the ad's landing page**; it may accompany the 15/4 copy or stand alone — a rewrite carrying only `finalUrl` is a **URL-only repoint** that leaves the live copy untouched (the fix for a new ad group's ad pointing at the wrong page). An empty rewrite (no copy and no `finalUrl`) is rejected.
- **`sitelinks`** — text ≤25 chars; descriptions are **both-or-neither** (one line alone is rejected by Google), each ≤35 chars; `finalUrl` https.
- **`callouts`** — plain phrases ≤25 chars, no URL, distinct/non-repetitive.
- **`negatives`** add **campaign-level negative keywords** — the direct fix for "spending on clicks you don't need" / search-term waste. Each `add` item is a bare string (defaults to **PHRASE**) or `{"text","matchType"}` with matchType `EXACT`/`PHRASE`/`BROAD`. Negatives already on the campaign are skipped, so a plan is **safe to re-run**. (Campaign-scoped here; for a list shared across many campaigns, build it once in the UI under *Tools → Shared library*.) To find candidates, pull search terms with `ads.sh report <customer> --days 30` and target the zero-conversion queries.
- **`keywords`** edit the **positive keywords on an ad group** — the lever for a horizontal→vertical pivot. `add` items are bare strings (PHRASE) or `{"text","matchType"}`; `remove`/`pause` are `{"text","matchType"}` identifying a *live* criterion (the match type is part of the identity). A **match-type change is a remove + add** of the same text (match type is immutable on a live criterion — Google has no in-place update). The validator **rejects the whole plan** if a `remove`/`pause` target isn't present on the ad group; ADDs already live are skipped, so re-running is **idempotent**. Find the `adGroupId` and live keywords in the audit report's per-ad `keywords`.
- **`adGroups`** add a **whole new ad group to an existing campaign** — the lever for a coverage gap the audit surfaces (a Keyword Theme with no ad group, or a horizontal group that should split into a tighter vertical one). `campaignId` is digits-only; `adGroup` is the **same shape a `/adkit create` brief ad group uses**: `name`, `defaultBidMicros` (≤ $15 CPC), a full `responsiveSearchAd` (**15 headlines / 4 descriptions**, `finalUrl` https, optional `path1`/`path2`), and 1–30 `keywords`. Headlines/descriptions are bare strings and keywords are bare strings (PHRASE) or `{"text","matchType"}` — the same ergonomics as the rest of the plan. The validator enforces the **identical RSA/keyword rules** `/adkit create` does (author the copy per §1: keyword in ≥3 headlines, distinct angles, no pins), so a bad ad group is **rejected at dry-run**, not mid-apply. **Idempotent** — an ad-group name already live in the campaign (case-insensitive) is reported **skipped**, never duplicated. Each new group is created with its **RSA PAUSED**, so it **cannot serve (no live spend) until you enable its ad** — flip it on in the UI or with a later status change once vetted.
- **`budgets`** set a campaign's **daily budget** (`dailyMicros`) — the lever for `budget_constrained` impression-share loss. Because this spends real money it carries a hard guardrail: a raise **above 50%** over the current budget is **rejected** (a plan's `maxRaisePct` can only *lower* that ceiling, never raise it); lowering is always allowed. Bid *strategy* is intentionally **not** editable here — graduate `maximize-clicks` → `maximize-conversions` in the UI.
- **`campaignStatus`** flip a campaign **on (`"ENABLED"`) or off (`"PAUSED"`)**. `campaignId` is digits-only; `status` is `ENABLED`/`PAUSED`. **Idempotent** — each campaign's live status is read first and a flip into the status it is already in is reported **skipped**, not mutated. **PAUSE is always safe; ENABLE starts live spend**, so it is surfaced loudly: a `WARNING:` line and a distinct `enableStartsLiveSpend` key in the JSON envelope — never silent. `/adkit create` always publishes **PAUSED**, so this is how a vetted campaign goes live (and how you pause one that's overspending).
- **`adGroupStatus`** flip a whole **ad group on/off** — the lever for a dead-weight ad group (wrong-intent keywords dragging CTR → Quality Score → Ad Rank): pause the group in one line instead of pausing its keywords one by one, and it stays reversible without having to re-add anything. `adGroupId` is digits-only; `status` is `ENABLED`/`PAUSED`. Same contract as `campaignStatus` one level down: **idempotent** (no-op flips reported **skipped**), **PAUSE always safe** (stops the group's keywords from serving without touching the keywords), **ENABLE resumes live spend** and is surfaced loudly (`WARNING:` line + `adGroupEnableStartsLiveSpend` key). Prefer this over `keywords`+`pause` when the intent is to shut off the *entire* ad group.
- **`adStatus`** flip a **single ad (ad_group_ad) on/off** — the lever for the **PAUSED ad every new `adGroups` group ships with**: enable it to make the group serve. `adId` is digits-only; `status` is `ENABLED`/`PAUSED`. The ad's parent ad-group id is **resolved from live state** (an ad_group_ad resource name needs both ids, but you only carry the `adId` from the audit). Same contract as `adGroupStatus` one level down: **idempotent** (no-op flips reported **skipped**), **PAUSE always safe**, **ENABLE starts live serving** and is surfaced loudly (`WARNING:` line + `adEnableStartsLiveSpend` key). This is how a vetted new ad group goes live.
- **`languages`** set a campaign's **language targeting to English only** — the lever for a campaign inadvertently serving in every language (Google's default). `campaignId` is digits-only; there are no other fields. It **adds the English language criterion and removes any other live language criteria** so the campaign is English-exclusive (Google's default is an implicit "all languages" with no criteria — adding one narrows it). **Idempotent** — a campaign already targeting English only is reported **skipped**, never duplicated. Narrowing language only reduces reach, so it is always safe (no live-spend warning).
- **`searchPartners`** toggle a campaign's **Google Search Partners** setting (`network_settings.target_search_network`) — use this to restrict a campaign to Google Search results only. `campaignId` is digits-only; `enabled` is a boolean. **Idempotent** (a flip into the setting it's already at is reported **skipped**, never mutated). Turning it **off** (`enabled: false`) only narrows reach and is always safe; turning it **on** (`enabled: true`) increases reach (and potential spend), so it's surfaced loudly (`WARNING:` line + `searchPartnersEnableIncreasesReach` key). `enabled: true` is **rejected at validation** (not left to fail live) if the campaign's `target_google_search` is off — Google Ads requires Google Search targeting to be on before Search Partners can be. The Display Network (`target_content_network`) stays off regardless, per existing convention — this only ever touches the Search Partners bit.

## Local brief (`adbriefs/`) — source of truth + review gate

Each campaign has a persisted brief at `adbriefs/<slug>.yaml` (written by `/adkit create`), the local **source of truth** for its full state — see `reference/conventions.md` → *`adbriefs/` — the local source of truth + diff-before-apply gate* for the format and the write-brief → diff → apply flow. The review-the-change gate for an update is the **`--dry-run` (default) → `--apply`** two-step below: dry-run shows the planned actions and mutates nothing; `--apply` performs the live change. After a successful apply, restage the campaign's brief so `adbriefs/<slug>.yaml` reflects the new live state (re-run `/adkit create` from the updated brief, or edit the brief to match), keeping the local record in sync.

> **In flight:** teaching `ads.sh update` to stage the plan into the campaign's `adbriefs/` brief and print the *brief diff* automatically (so the update-side gate mirrors `create`'s) is the next increment — the shared `src/adbriefs/` machinery (`store.ts`/`diff.ts`) it needs already exists. Until then, use the `--dry-run` → `--apply` gate and keep the brief in sync by hand.

## 3. Dry-run, then apply

```bash
ads.sh update /tmp/plan.json            # dry-run: validates + prints planned actions
ads.sh update /tmp/plan.json --apply     # mutate live
```

(`ads.sh apply-fixes` is a **deprecated alias** for `ads.sh update` — prefer `update`.)

`update` re-validates against the RSA rules and **refuses a bad plan**. Always dry-run first and confirm the planned actions match intent. Edits are in-place (`mutate_ads`), so ad ids and history are preserved; `ad_strength` shows `PENDING` until Google recomputes (minutes–hours).

## 4. Report

Surface, per campaign: what you changed, and what you deliberately left (e.g. a converting POOR ad — never pause a converting ad to chase ad strength; enrich it). If you flipped any campaign to `ENABLED`, call out that it now spends. All edits are live-account mutations — the account and Google's change history are the record; there are no local record files to update.

## Notes

- `update` can change budgets (`budgets`), add negatives (`negatives`), add whole new ad groups (`adGroups`), flip a campaign on/off (`campaignStatus`) or an ad group on/off (`adGroupStatus`), and it improves ad strength (which feeds Ad Rank) by closing `pathToExcellent` gaps. It **cannot** change a bid strategy or geo/schedule — the operator does those in the UI. For `rank_constrained` IS loss, adding negatives to cut junk clicks (or pausing a whole wrong-intent ad group) lifts CTR → Quality Score → Ad Rank.
- A persistent "Add N more sitelinks" `action_item` while a campaign already shows 6 sitelinks usually means they're pending review or not eligible — check approval status, don't blindly add more.
