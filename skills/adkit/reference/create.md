---
description: "Publish a fresh Google Ads search campaign from a processed idea markdown file. Calls google-ads-api directly — no MCP server. Publishes are not persisted locally; revise live ads with /adkit audit then /adkit update."
argument-hint: "path to processed idea markdown (for example: ideas/processed/chatbase-ai-customer-support-v1.md)"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## Preconditions

1. The processed idea file exists at `$ARGUMENTS` (under `ideas/processed/`).
2. That file has a `## Go To Market > ### Keyword Themes` section (the ad-group source of truth), plus `### Keywords` + `### Ad Copy`. If missing, run `/adkit gtm ideas/raw/<basename>.md` first (the `/adkit gtm` skill reads raw and writes the keywords, keyword-themes, and ad-copy sections into the matching processed file). A processed file authored before `### Keyword Themes` existed must be re-run through `/adkit gtm` to backfill it.
3. `GOOGLE_ADS_CUSTOMER_ID` is exported (or the brief sets `customerId`).

Mechanics — ads.sh invocation/build, customer-id resolution, the JSON envelope, and credentials (`ads.sh render-yaml` / `preflight`) — are in **`reference/conventions.md`**; read it once.

**Before proceeding, read:**
- [`reference/google/3-account-structure.md`](google/3-account-structure.md) — campaign types, budget splits, match type rules
- [`reference/google/4-ad-copy.md`](google/4-ad-copy.md) — headline pools, pinning strategy, asset checklist

## Authoring Rules — STAG + RSA

These rules are baked in. Apply them when filling the scaffolded brief.

### STAG: Single Theme Ad Group

- **One keyword theme per ad group.** Keywords are grouped by **semantic theme** — the 3–6 `### Keyword Themes` `/adkit gtm` authors (step 15c), e.g. *salon software*, *barber/stylist*, *free intent* — *not* one-keyword-per-group and *not* by the I/N/C/T intent tier. (The intent tiers still live in `### Keywords`, but only as a buyer-intent + offer-matching annotation; they no longer define ad groups.) Google's close-variant matching and Smart Bidding made micro-SKAGs obsolete: theme groups consolidate conversion data so the ML optimizes faster, and ad copy can mirror the theme for a better Quality Score.
- The scaffolder makes **one ad group per non-spend-trap theme**, packing up to 25 keywords from that theme's `### Keyword Themes` bullets — so a fresh campaign launches near **~100 keywords total** (the gtm target; well above the audit's 25-keyword floor). `--top-n N` caps keywords-*per-theme* (1 ≤ N ≤ 30, matching the brief schema's per-ad-group ceiling). **At most 10 ad groups** — gtm authors themes highest-potential-volume first, and the scaffold keeps only the **top 10**; the brief schema also rejects more than 10. Keywords are deduped **across themes** so each lands in exactly one ad group — no cross-group cannibalization. The scaffold prints the total and warns if it's outside 90–110.
- **The spend-trap theme is excluded.** The theme gtm flags `[spend-trap]` (generic, keep-but-don't-lead) gets **no ad group** — its terms feed the campaign negative-keyword list instead (that is *why* it's safe to negate them: they're no longer live ad-group keywords). Nothing to author for it.
- Keywords go in as **`PHRASE`**. Close-variant matching + AI Max cover plurals/typos/synonyms, so the SKAG-era PHRASE+EXACT pair is redundant. Add `EXACT`/`BROAD` on a keyword by hand only if a theme genuinely needs it.
- **One campaign → 3–6 theme ad groups → one RSA per theme → all that theme's keywords share one landing page and one ad message.** That shared copy/landing page *is* the STAG contract. All ad groups share the campaign budget.
- Write each theme's RSA to the **offer temperature gtm resolved for it** (the theme's `> Offer:` in `### Keyword Themes`, set to the theme's highest-actionable represented intent tier — Transactional > Commercial > Navigational > Informational): educate/lead-magnet at the cold end → act-now at the scalding end. Same product, one temperature per theme.

### STAG + Smart Bidding + AI Max (the modern combo)

This structure is what these features were built for:

- **Data consolidation.** A few themes (not 20 micro-groups) means each ad group accrues enough conversions for Smart Bidding to actually train (~30/mo per group is the target). Fewer groups → less learning-split → faster optimization.
- **AI Max** (`campaign.aiMax`, default on) expands reach *beyond* your literal keywords via broad-match tech + landing-page matching. With STAGs you **want** that: the theme defines intent, AI Max finds the long-tail you can't enumerate, and negatives keep it on-theme. (To block search-term matching on one ad group, the API exposes `AdGroup.ai_max_ad_group_setting.disable_search_term_matching` — not surfaced in the brief; add only if needed.)
- **Negative keywords** (`campaign.negativeKeywords`) are now the main relevance lever — not match-type surgery. They steer AI Max / close-variant expansion off the junk. The scaffolder **auto-seeds** them from the processed file's `#### Negative Keywords` section; review and extend before publishing.

Budget still matters: keep it matched to theme count. Six themes on $25/day ≈ $4/day each; four ≈ $6/day — both workable, but the more themes you run the thinner each is spread. Delete the lowest-priority theme ad groups (or raise the budget) if you want the money concentrated on the highest-intent themes gtm's ad-group-split recommendation named.

### Bid strategy — launch on `maximize-clicks`, graduate to `maximize-conversions`

**New campaigns publish on Maximize Clicks (`bidStrategy: "maximize-clicks"`, the default).** This escapes the Smart-Bidding cold start: a brand-new campaign on `maximize-conversions` with no conversion history bids weakly and can starve to ~0 impressions. Maximize Clicks buys traffic to seed conversion data. Add `cpcBidCeilingMicros` to cap what the warm-up pays per click so it can't overpay for junk.

**Graduate to Maximize Conversions once the campaign has ~15–30 conversions in 30 days.** That switch is a **manual UI action** (Campaign → Settings → Bidding) on the live campaign — re-running `create` won't do it (it reuses the existing campaign without changing its strategy), and each switch triggers a fresh ~1–2 week learning period, so do it once. Set `bidStrategy: "maximize-conversions"` at create time only when conversion volume is already assured (good budget + search volume + a low-friction conversion like the waitlist sign-up).

Only these two launch modes are honored by the executor; any other `bidStrategy` value falls back to Maximize Clicks. `targetCpaMicros`/`targetRoas` remain ignored at publish.

Either way, wire a conversion action (`Tools → Conversions → New conversion action`) and have it fire in production — Maximize Clicks needs it to *seed* data, Maximize Conversions needs it to *optimize*. For the lead-drop waitlist the conversion is the early-access signup: fire `gtag('event', 'conversion', {...})` from the modal-success path or upload via the Conversions API.

### RSA: Responsive Search Ad

Author **diversity**, not a single message. Every RSA must use the full asset set:

| Field          | Min | Max | Target  |
| ---            | --- | --- | ---     |
| `headlines`    | 15  | 15  | **15 unique** |
| `descriptions` | 4   | 4   | **4 unique** |

These rules exist to earn an **Excellent** ad strength. POOR strength is almost always under-filled assets, near-duplicate headlines, the keyword missing from the headlines, or pinning — the five rules below kill all four causes.

**Headline rules**

1. **Fill all 15.** Provide exactly 15 unique headlines — never publish fewer. POOR strength is usually "well under 15"; give Google the full set so it has combinations to test. All must stand alone (Google mixes them in any order; assume no neighbor context). ≤30 characters each (schema-enforced).
2. **Make them distinct — different *angles*, not reworded twins.** "AI Chatbot Tool" and "AI Chatbot Software" are the *same* headline and don't count as variety. Across the 15, cover: value prop, feature, social proof, urgency, offer/free, pricing, audience callout, objection, brand. Ad strength keys off lexical *and* angle diversity.
3. **Put the ad group's main keyword in the headlines — across ≥3 of them, not just headline 1.** Google explicitly rewards keyword inclusion. E.g. a *Best Ai Chatbot* ad group → ≥2-3 headlines containing "AI chatbot"; a *Conversational Ai* ad group → "conversational AI". Use the shared concept, not every literal phrase; small surface variants (singular/plural, modifier swaps) are fine. No keyword stuffing — connection > literal match.
4. Focus on bottom-of-funnel intent: include terms such as **software**, **platform**, or **demo**, and explicitly mention **ROI** or **margin protection** where it fits. Write to the action-ready buyer and the pain the software resolves.

**Description rules**

1. **Use all 4 — each unique.** Provide exactly 4 descriptions, never fewer (most POOR ads ship only 2). Each a different angle: offer, problem-solution, trust signal, CTA. ≤90 characters each.
2. Reinforce bottom-of-funnel intent, including the software/platform/demo language and an explicit ROI or margin-protection benefit where it fits naturally.
3. End each with a verb or call-to-action.

**Pinning — disabled. Never pin.** Pinning a headline/description to a fixed slot is the #1 silent ad-strength killer: it blocks Google from testing asset combinations. The schema locks `pin` to `"NONE"`, so any pinned asset is **rejected at validation** — there is no "pin for legal" escape hatch here. If a legal disclaimer truly must always show, put it in the landing page or a description that's safe in any combination, not a pin.

### Best practices

**Tailor every ad group's creative to its own keyword — never reuse one copy block across the campaign.** This is the single biggest cause of POOR strength, and it's an *authoring* mistake, not something to fix after launch. In a STAG campaign the ad groups share a budget and usually one landing page, but they must **not** share one keyword-agnostic creative. The trap: writing a single themed headline/description set once (e.g. a "voice-matched" story) and pasting it into every ad group. Every ad then grades POOR because none echo *their own* ad group's keyword. A *Best Ai Chatbot* group and an *Ai Powered Writing Assistant* group can sell the exact same product off the exact same landing page and still need different assets — "AI chatbot" carried across ≥3 headlines in one, "AI writing assistant" in the other. **Shared landing page, distinct assets.** Write each ad group's 15 headlines / 4 descriptions to *that group's keyword first*, then layer the shared product story on top — not the other way around.

### Diagnosing & fixing POOR after publish

Ad strength is recomputed asynchronously, so check it *after* the ad is live — and read Google's own verdict instead of guessing:

```
SELECT ad_group_ad.ad_strength, ad_group_ad.action_items,
       ad_group_ad.policy_summary.approval_status,
       ad_group_ad.ad.responsive_search_ad.headlines,
       ad_group_ad.ad.responsive_search_ad.descriptions
FROM ad_group_ad WHERE ad_group.id = <id>
```

`action_items` are Google's literal fix hints ("Try including more keywords in your headlines", "Add 6 more sitelinks") — treat them as the to-do list. The two real-world causes seen most:

- **Keyword-agnostic boilerplate reused across ad groups** — see **Best practices** above; the fix is per-ad-group keyword-tailored assets, not per-ad tweaking.
- **Under-fill** — fewer than 15 headlines / 4 descriptions. Top them up.

**Ad strength is a creative-diversity score, not a performance score.** A POOR ad can be the account's best converter. **Never pause a converting POOR ad to chase strength** — enrich its assets instead (more impressions for an already-efficient ad is upside; pausing it is pure loss).

**Editing in place:** `AdService.mutate_ads` with an update_mask of `responsive_search_ad.headlines` / `responsive_search_ad.descriptions` rewrites assets without minting a new ad id, but resets review (`ad_strength` shows `PENDING` until recomputed). Keyword **match types are immutable** — to tighten a broad keyword, pause it and add a phrase/exact version; you can't mutate the match type.

### Sitelinks (campaign-level, exactly 6)

Every campaign ships **exactly 6 sitelinks** — extra links shown under the ad. Authoring rules:

1. `text` (link label) ≤25 chars, action- or destination-oriented: "See Pricing", "How It Works", "Start Free Trial".
2. Each distinct — no two sitelinks saying the same thing.
3. `finalUrl` must be https. The same landing page across all sitelinks is fine (use section anchors if available); distinct destinations are better when they exist.
4. `description1` + `description2` are optional but recommended (each ≤35 chars). **Both or neither** — a sitelink with one description line is rejected by Google.

### Callouts (campaign-level, ≥4)

Every campaign ships **at least 4 callouts** — short benefit phrases (no link) shown under the ad, e.g. "No new integrations", "Live in 30 days", "Built for mid-market". Authoring rules:

1. Each ≤25 chars (schema-enforced). Plain phrase, no URL.
2. Each distinct — promote a different offer/benefit; no near-duplicates.
3. Non-promotional, no repetition of the same word across callouts (Google disapproves repetitive callouts).
4. Up to 20 allowed; Google shows up to 10. Scaffold emits 4 placeholders — fill them in.

| Brief field | Source |
| --- | --- |
| `name` | Processed file basename (sans `.md`); auto-truncated to ≤64 chars |
| `version` | Vestigial — set `1`. Publishes are not versioned or persisted; revise live ads with `/adkit audit` then `/adkit update`. |
| `campaign.name` | `<name>-search` |
| `campaign.networkSettings` | Default `"search-partners-display"` — serves on Google search **plus** search partner sites. The Display Network is always disabled (no Search-with-Display-Select), regardless of this value. Set `"search-only"` to restrict to Google search results only. |
| `campaign.aiMax` | **AI Max for Search.** Default `true` — Google AI expands beyond the theme's keywords (broad-match tech) and matches landing-page/asset content to more queries; search-term matching stays on. Set `false` for a strictly keyword-matched campaign. Pairs with `negativeKeywords` to stay on-theme. See *STAG + Smart Bidding + AI Max* above. |
| `campaign.negativeKeywords` | **Campaign-level negatives**, shared across all themes. Each: `text` (≤80 chars), `matchType` (`PHRASE` default / `EXACT` / `BROAD`). Auto-seeded by the scaffolder from the processed file's `#### Negative Keywords` section. The primary lever for keeping AI Max / close-variant expansion on-theme. |
| `campaign.devices` | **Device targeting.** Omit (default) = **mobile excluded at −100%** (`bid_modifier=0`); computer/tablet/tv serve. A subset of `["computer","mobile","tablet","tv"]` keeps those and **excludes the rest at −100%** — e.g. `["computer"]` = desktop-only; list all four to serve everywhere. Empty list is rejected (would exclude everything). Under Smart Bidding only the −100% exclusions are honored; non-zero device adjustments are ignored. |
| `campaign.bidStrategy` | **Launch strategy. Default `maximize-clicks`** (cold-start warm-up). Set `maximize-conversions` to launch straight on Smart Bidding when conversion volume is assured. Other values fall back to Maximize Clicks. Graduate clicks→conversions later in the UI, not via a brief edit. |
| `campaign.cpcBidCeilingMicros` | Optional max CPC ceiling (micros) for `maximize-clicks` — caps warm-up cost per click. Rejected with any other `bidStrategy`. |
| `campaign.targetCpaMicros` / `campaign.targetRoas` | Ignored at publish (the supported launch strategies use neither). |
| `campaign.budgetMicros` | **Operator-confirmed.** Scaffold default: `25_000_000` ($25/day) — shared across all theme ad groups in this campaign |
| `campaign.sitelinks` | Exactly 6 sitelinks. Each: `text` (≤25 chars), `finalUrl` (https), optional `description1`+`description2` (≤35 chars, both-or-neither). Scaffold emits 6 TODO placeholders. |
| `campaign.priceAsset` | Optional campaign-level price asset: 3–8 offerings with a ≤25-character header/description, positive `priceMicros`, and an https `finalUrl`. |
| `campaign.structuredSnippet` | Optional campaign-level structured snippet: a supported header and 3–10 distinct values (≤25 characters each). |
| `campaign.callouts` | **At least 4 callouts** (or none on legacy briefs). Each a plain phrase ≤25 chars, no URL — distinct benefit/offer, non-repetitive. Max 20. Scaffold emits 4 TODO placeholders. |
| `adGroups[].name` | The keyword theme name from `### Keyword Themes` (e.g. `Salon Software`, `Barber / Stylist`) — one ad group per non-spend-trap theme, **max 10** (top 10 by potential volume). Free-form string (schema imposes no enum). |
| `adGroups[].defaultBidMicros` | **Operator-confirmed.** Scaffold default: `1_500_000` ($1.50 CPC); **max `15_000_000` ($15.00)** — per ad group |
| `adGroups[].responsiveSearchAd.headlines` | Exactly 15 unique headlines **per ad group**, tuned to that theme's intent and containing top keywords across ≥3 headlines. |
| `adGroups[].responsiveSearchAd.descriptions` | Exactly 4 unique descriptions per ad group. |
| `adGroups[].responsiveSearchAd.finalUrl` | The published landing-page URL, always under **`https://www.example.com/ideas/<published-slug>`** (clean URL, no `.html`). The published slug is the timestamped name from `Idea HTML`, not the processed-file slug. Often the same URL across ad groups. **Pre-publish URL check rejects any finalUrl that 404s** (use `--skip-url-check` to bypass). |
| `adGroups[].responsiveSearchAd.path1` / `.path2` | **Optional "pretty URL" display paths.** Google shows the `finalUrl` *host* plus these two keyword-rich segments as the ad's visible (display) URL — e.g. `finalUrl` `.../ideas/tonewell-...?utm=...` with `path1: review-replies`, `path2: free-trial` displays as **`www.example.com/review-replies/free-trial`**, while the click still lands on the long, tracking-heavy `finalUrl`. Each **≤15 chars, no spaces or `/`**, **always lower case** (mixed case is coerced down at validation); **`path2` requires `path1`** (Google fills them in order). Per ad group, so each theme can show its own keyword. Omit both to show the bare host. A leftover scaffold `TODO` value is rejected at validation. |
| `adGroups[].keywords` | That theme's keywords, each `{text: <phrase>, matchType: "PHRASE"}` (deduped across themes; up to `--top-n`, default 25). Add `EXACT`/`BROAD` by hand only if a theme needs it. |

> Audience-segment attachment is a planned follow-up — see [issue #20](https://github.com/imosquera/lead-drop/issues/20) for scope (brief field, executor, locked-field invariant) and the design of a sibling `/adkit audiences` skill (list catalog, create custom-intent, upload customer-match).

### Quality checklist before publish

Per ad group (theme):
- [ ] One keyword theme (from `### Keyword Themes`); 3–30 related keywords as PHRASE (schema cap 30 per ad group; EXACT/BROAD by hand only if needed).
- [ ] **All 15 headlines filled** (exactly 15 unique), each ≤30 chars and able to stand alone.
- [ ] Headlines are **distinct angles**, not reworded twins; no two say substantially the same thing.
- [ ] The ad group's **main keyword appears across ≥3 headlines**, naturally phrased.
- [ ] Headlines/descriptions include bottom-of-funnel language (software, platform, or demo) and explicitly state ROI or margin protection.
- [ ] **All 4 descriptions filled** (exactly 4 unique), each ≤90 chars, each ending in a CTA or verb.
- [ ] **No pins anywhere** — pinning is disabled (schema rejects any non-`NONE` pin).

Per brief:
- [ ] 3–6 theme ad groups (one per keyword theme; spend-trap theme excluded); each `adGroups[].name` unique.
- [ ] `campaign.negativeKeywords` seeded (scaffold auto-fills from `#### Negative Keywords`); reviewed.
- [ ] Exactly 6 `campaign.sitelinks`, each `text` ≤25 chars and `finalUrl` live; descriptions both-or-neither.
- [ ] Optional `campaign.priceAsset` and `campaign.structuredSnippet` are complete and accurately describe the offer.
- [ ] ≥4 `campaign.callouts`, each ≤25 chars, distinct and non-repetitive (no URL).
- [ ] All `finalUrl`s (RSA + sitelinks) are under `https://www.example.com/ideas/<slug>` and resolve live (the skill HTTP-checks this before publishing; `--skip-url-check` bypasses).
- [ ] `campaign.budgetMicros` and each `adGroups[].defaultBidMicros` (≤ $15.00) confirmed by operator.
- [ ] New campaigns launch on `maximize-clicks` (cold-start warm-up); graduate to `maximize-conversions` in the UI after ~15–30 conversions/30d. Wire a live conversion action either way.

## Execution

### 0. Prepare the brief from the processed file

```bash
ads.sh create $ARGUMENTS
# or cap keywords-per-theme:
ads.sh create $ARGUMENTS --top-n 10
```

If no filled brief exists yet, the script scaffolds one to a **throwaway temp path** (`$TMPDIR/ads-briefs/<slug>.yaml`, not committed) with **one ad group per keyword theme** from the processed file's `### Keyword Themes` section (spend-trap themes excluded), packs each with up to 25 keywords, auto-seeds `campaign.negativeKeywords` from the `#### Negative Keywords` section, and exits 2. **If the file has no `### Keyword Themes` section** (e.g. a processed file authored before this section existed), the script dies asking you to re-run `/adkit gtm <path>` to (re)generate it — there is deliberately no fallback to intent-tier grouping. It prints the temp path; fill in the headlines, descriptions, and `finalUrl` per theme per the STAG + RSA rules above, then re-run with the same idea slug (it finds the filled temp brief) or pass the temp `.yaml` path directly.

### 1. Preflight

Run `ads.sh preflight` once per session (see `reference/conventions.md`). Non-zero exit ⇒ **stop**.

### 2. Dry run (no mutations) — verify the plan before spending money

```bash
ads.sh create $ARGUMENTS --dry-run
```

Emits the publish plan (ad-group count, sitelink/callout counts, the ordered step chain) without calling Google Ads. An existing campaign of the same name is reused, not duplicated. Confirm the plan matches what you intended.

### 3. Publish

```bash
ads.sh create $ARGUMENTS
```

The script:
1. Validates the brief against the zod schema.
2. Publishes against the Google Ads API via `google-ads-api`: one budget + one campaign + campaign-level sitelinks + campaign-level callouts + per ad group { ad-group, RSA, PHRASE+EXACT keywords }. An existing campaign/ad-group of the same name is **reused** (so a re-run won't duplicate it). Campaign and each RSA are created in **PAUSED** state — nothing serves until you flip status in the Ads UI.
3. Emits a JSON summary of what was created. **Nothing is written to disk** — the live account and Google's change history are the record (read live state with `/adkit audit`).

Exit non-zero ⇒ the JSON output includes `failure.step` and `failure.message`, plus the partial `created` ids so you can see how far it got.

### 4. Report

Surface the created campaign/ad-group ids, the `status`, and (if applicable) the failure step. Tell the operator the campaign is **paused**; they enable it in the Google Ads UI when ready. To revise a live ad later, use `/adkit audit` then `/adkit update` (not a re-publish).

## Implementation

Code under `scripts/`:

- `ads.sh` — wrapper. Resolves `node`, installs npm deps on first run, runs the entry point straight from TypeScript via `tsx` (no build, no `dist/`).
- `package.json` — declares `google-ads-api`, `zod`, `yaml`, `tsx`.
- `src/lib/schema.ts` — Brief + Failure types (zod); single source of truth.
- `src/lib/executor.ts` — google-ads-api wrappers for each step kind + `publishV1`.
- `src/bin/{preflight,create,audit,apply-fixes,keyword-ideas,report,render-yaml,bootstrap-secrets}.ts` — entry points (run directly by `tsx`).

## Reference

- Brief schema: `specs/009-ads-skill/contracts/brief.schema.json`
