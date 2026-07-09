---
description: "Audit live Google Ads campaigns (read-only) for RSA + extension best practices and impression-share loss, reporting a concrete path to EXCELLENT ad strength per ad. To apply fixes, use /adkit update."
argument-hint: "[<campaign-name-or-id>] [--customer <10-digit>] [--all] [--no-serving] [--days 14]"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## Role

You audit live Google Ads campaigns against the same best practices `/adkit create` enforces, and you tell the operator **exactly what would push each ad to EXCELLENT ad strength**. This skill is **read-only** — it reports, never mutates.

- **Deterministic work is Python's** — counting headlines/descriptions, finding duplicates, detecting reused boilerplate across ad groups, flagging off-product contamination, counting sitelinks/callouts, reading Google's own `ad_strength` + `action_items`, computing each ad's `pathToExcellent`. That is `ads.sh audit`.
- **Creative judgement is yours** — interpreting the gaps and (downstream) authoring the fix copy.

**To apply fixes, use `/adkit update`** — it takes this audit's output, you author the copy, and `ads.sh update` validates + mutates.

Mechanics (ads.sh invocation, customer-id resolution, the JSON envelope, credentials/preflight) are in **`reference/conventions.md`** — read it once. Run `ads.sh preflight` once per session.

**Before proceeding, read:**
- [`reference/google/6-analyze.md`](google/6-analyze.md) — STR audit workflow, asset report, quality score diagnostics
- [`reference/google/4-ad-copy.md`](google/4-ad-copy.md) — headline pool rules (used to judge what's missing)

## What "EXCELLENT" needs (the four levers Google scores)

Ad strength is a **creative-diversity** score, not a performance score. A POOR ad can be the best converter — never pause a converting ad to chase strength; enrich it. The levers:

1. **Quantity** — 15 headlines, 4 descriptions. Under-fill is the #1 cause of POOR.
2. **Uniqueness** — distinct *angles* (value, feature, social proof, urgency, offer, pricing, audience, objection, brand), not reworded twins. A description must not just echo a headline.
3. **Keyword inclusion** — the ad group's real keyword in **≥3 headlines**. The audit reads each ad group's actual keywords (not the ad-group name) and scores this.
4. **No pinning** — pinning blocks combination testing. `/adkit create` forbids it; the audit flags any pin.

Plus the extensions Google nags about: **6 sitelinks** and **≥4 callouts** per campaign.

The audit's `pathToExcellent` per ad merges these deterministic gaps with Google's literal `action_items` ("Try including more keywords in your headlines") — treat it as the to-do list, then hand it to `/adkit update`.

## Impression share — winning more impressions

Ad strength and **impression share (IS)** are different axes: an EXCELLENT ad can still capture a tiny slice of available impressions. The IS layer (on by default; `--no-serving` to skip) reports, per serving campaign over a `--days` window (7/14/30): `searchImpressionShare`, `lostISBudget`, `lostISRank`, plus a recommendation keyed to *why* you're losing share:

- **`budget_constrained`** — losing >10% IS to budget → raise the daily budget (or tighten geo/schedule/keywords) to capture it.
- **`rank_constrained`** — losing >10% IS to Ad Rank → lift Quality Score (ad relevance, ad strength, landing-page experience) and/or bids; add negatives to raise CTR.
- IS below ~65% with headroom → act on the dominant lost-IS reason above.

Two related growth blockers it also flags:

- **`cold_start_throttle`** — `MAXIMIZE_CONVERSIONS` + 0 conversions + 0 impressions: Smart Bidding with no conversion history bids weakly and starves a *new* campaign. Feed it conversions or warm it up.
- **`cannibalization`** — the account's own ENABLED campaigns sharing keywords; Google serves only the higher-Ad-Rank one, starving the other (often a newer `-stag` duplicate). Run one campaign per product.

**These are mostly not creative fixes.** Of them, `/adkit update` can raise a budget (for `budget_constrained`), add negative keywords (helps `rank_constrained` by lifting CTR → Quality Score → Ad Rank), and close per-ad `pathToExcellent` gaps. Everything else (bid strategy, geo/schedule) the operator does in the UI.

## Professional-lane signal — me-too copy

A read-only check tells the operator *when* an ad reads like a general LLM (apply the fix with `/adkit update`):

- **`undifferentiated_copy`** (per-ad `issue`) — the ad's message reads as a generic AI-tool promise ("AI writer" / "AI chatbot") and is **indistinguishable from a general LLM**. `missingAxes` names which of the three axes a competitor like ChatGPT can't easily replicate are absent: **integration** (CRM/marketing-stack fit), **consistency** (brand-voice / voice-matched replies across channels), **outcome** (sign-ups/reply-rate/revenue framing). An ad already leading with all three is not flagged. The fix is `/adkit update` — author sharper copy toward the missing axes. The competitor set + axes are defined once in `ads_skill/lib/brand.py`.
## Keyword CPC & cluster split

On by default (with the serving layer; `--no-serving` skips it), the audit pulls **per-keyword average CPC** over the `--days` window and emits it as `keywordCpc` (`{campaignId: [{text, avg_cpc, avg_cpc_micros}]}`, priciest first). From that it computes `clusterSplits`: a campaign whose **top keyword CPC is ≥ 3× the cheapest** is mixing a cheap-broad and an expensive-intent keyword group under one budget — one shared budget/bid lets the cheap terms win every auction and starve the expensive ones (the reputation-split pattern). Each entry carries `maxCpc`/`minCpc`/`ratio`, the `expensive`/`cheap` groups, and a `reason`. The fix is structural: split the expensive group into its own campaign with its own budget and $3–6 bids (publish via `/adkit create`), not a creative tweak.

## Search-term waste & scale-up

On by default (with the serving layer; `--no-serving` skips it), the audit pulls each campaign's **actual search terms** over the `--days` window and runs the same `lib/cluster` logic `/adkit report` uses, so negatives are chosen from real query data rather than guessed. Two outputs, keyed by campaign id:

- **`addNegatives`** (`{campaignId: [{text, clicks, cost, impressions}]}`, priciest-waste first) — search terms that **spent without converting**: the negative-keyword candidates that lift CTR → Quality Score → Ad Rank (the actionable side of a `rank_constrained` flag). Hand them to `/adkit update` as negative keywords.
- **`promoteKeywords`** (`{campaignId: [{text, matchType, clicks, conversions, cost}]}`, strongest-first) — converting search terms **not yet keywords**: scale-up candidates to add as PHRASE keywords via `/adkit update`'s positive-keyword editing.

## Execution — scan (report only)

```bash
# whole account (ENABLED campaigns)
ads.sh audit --customer <10-digit> --banned "VAT,USD,EUR,Portugal"
# one campaign by id
ads.sh audit --customer <10-digit> --campaign <id>
```

- JSON report → **stdout** (per-campaign findings, per-ad `issues`, `keywords`, `actionItems`, `pathToExcellent`, plus each ad's full `headlines`/`descriptions` **text** so `/adkit update` can preserve good copy when authoring rewrites/appends; plus the serving-layer `serving`/`keywordCpc`/`clusterSplits`/`addNegatives`/`promoteKeywords`). Redirect it: `> /tmp/audit.json`.
- Human summary → **stderr** (the table with `-> path to EXCELLENT` lines).
- Flags: `--all` (include paused/removed), `--no-serving` (skip the impression-share layer), `--days 7|14|30` (IS window), `--banned "a,b,c"` (phrases that signal copy leaked from another product — substring-based; product-specific, no universal default, always pass the phrases you expect from neighbouring products in the account).
- Resolve a campaign name in `$ARGUMENTS` to an id by matching against the JSON's `campaignName` (or pass the id directly).

## Report

Surface, per campaign: the findings, the **path-to-EXCELLENT per ad**, the impression-share recommendation (and why), and any cannibalization/cold-start flags. End with the next step: **to apply the fixes, run `/adkit update`** (you author the copy; `ads.sh update` validates + mutates). Note anything you'd deliberately leave alone (e.g. a converting POOR ad).

## Landing page health

Run as part of every audit (read-only, surfaces actionable issues alongside the ad-strength and IS findings).

**URL / redirect integrity** — Google's landing page test catches issues that cause disapprovals or wasted spend:

| Result | What it means | Fix |
|---|---|---|
| `Final URL mismatch` | Redirect chain doesn't start at final URL domain, or exits the domain mid-chain → causes "Destination mismatch" disapproval | Align tracking template + final URL to resolve to same domain |
| `Page not found` (404) | Bad final URL, broken tracking template, or AdsBot blocked by `robots.txt` | Fix URL or unblock `Googlebot-Ads` in robots.txt |
| `Landing page has URL mismatch` | Landing page domain ≠ final URL domain | Correct the final URL |
| `Unreachable` | Timeout — retry; if persistent, flag as a crawlability blocker | Check server availability |
| `Landing page has additional parameters` | Extra UTM/params on resolved URL vs final URL (usually benign) | Confirm tracking template is stripping correctly |

Caveats the test does **not** cover: policy violations, JS-based redirects, parallel tracking errors, standard Shopping campaigns.

**Mobile experience** — from the Landing pages report (`Campaigns → Insights & reports → Landing pages`):

- **Mobile-friendly click rate < 100%** → landing page fails Google's Mobile-Friendly test on some clicks. Fix: remove viewport-blocking elements, ensure `<meta name="viewport">` is set, compress images.
- **Valid AMP click rate < 100%** → AMP markup present but invalid on some clicks. Fix: validate at AMP Validator.
- A 1-second mobile delay can cut conversions by up to 20% (Google retail benchmark) — flag any page with slow Time-to-Interactive alongside the IS findings.

**Quality Score & landing page experience** — the audit fetches the current Quality Score snapshot per keyword via `keyword_view` (fields: `quality_info.quality_score` 1–10, `quality_info.post_click_quality_score` landing page exp, `quality_info.creative_quality_score` ad relevance, `quality_info.search_predicted_ctr` expected CTR). Emitted as `qualityScore` in the JSON. Keywords with `landingPageExp = BELOW_AVERAGE` are surfaced in the stderr table alongside the `rank_constrained` IS finding — the fix is page relevance and speed, not a bid raise. Keywords with no impressions yet return score 0 and are omitted.

## Notes

- A persistent "Add N more sitelinks" `action_item` while a campaign already shows 6 sitelinks usually means they're pending review or not eligible — check approval status before recommending more.
