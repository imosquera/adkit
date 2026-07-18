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

- **Deterministic work is the CLI's** — counting headlines/descriptions, finding duplicates, detecting reused boilerplate across ad groups, flagging off-product contamination, counting keywords (flag campaigns under 25), counting sitelinks/callouts, reading Google's own `ad_strength` + `action_items`, computing each ad's `pathToExcellent`. That is `ads.sh audit`.
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

- **`undifferentiated_copy`** (per-ad `issue`) — the ad's message reads as a generic promise indistinguishable from a general LLM. This check is **dynamic, driven per run** by a **differentiation profile** you author from the campaign, its landing page, and the idea, and pass via `--differentiation-profile <path.json>`. The JSON shape is `{ "competitors": string[], "genericPhrases": string[], "axes": [{ "name": string, "triggers": string[] }] }` — `competitors`/`genericPhrases` are the me-too signals to detect, and each `axis` is a differentiator (with the `triggers` that count as "present"). `missingAxes` names which axes the ad fails to lead with; an ad already covering every axis is not flagged. An **empty or absent profile flags nothing**. The fix is `/adkit update` — author sharper copy toward the missing axes.

## Message match — keyword alignment across the funnel

A tightly-themed ad group points every part of itself at the same searches: the ad group **name**, its **keywords**, the **ad copy** (headlines + descriptions), and the **landing page** all share the keyword theme. When they drift apart, Quality Score and relevance suffer.

- **`keyword_alignment`** (per-ad `issue`) — deterministic message-match check across the four levels of an ad group, using the ad group's own keyword theme words (the >2-char tokens of its keywords) as the reference:
  1. the **ad group name** shares a theme word with the keywords,
  2. the **headlines** carry the theme (≥3 headlines, matching the "keyword inclusion" lever),
  3. the **descriptions** carry it (≥1 description), and
  4. the **landing page** carries it — judged against the ad's **final-URL slug** (domain labels + path words, minus the TLD, common public-suffix labels like `com`/`co`/`net` so a `.com.br` suffix isn't read as copy, and structural noise like `www`/`html`), the only landing-page verbiage the Ads API exposes. There is no page body in the audit data and the scorer stays IO-free, so the URL slug is the deterministic proxy for the landing page's topic (e.g. `/ai-chatbot-crm` aligns to a "chatbot" theme). Judging the page copy itself would need a live fetch — out of scope for the pure scorer.

  Matching is on a **left word boundary with open suffix**: a theme word must begin a word (so `app` does not match `happy`), but any ending is allowed so inflections still count (`chatbot` covers `chatbots`).

  `misaligned` names each level that drifts off the theme (`"ad group name"`, `"headlines"`, `"descriptions"`, `"landing page"`); `themeWords`, `nameAligned`, `headlinesWithKeyword`, `descriptionsWithKeyword`, and `landingPageAligned` (`true`/`false`/`null` when there's no URL to judge) show the evidence. An ad group with **no keywords is never flagged** (nothing to align to), a level with **no evidence** (an absent final URL) is skipped rather than flagged, and an ad aligned on every present level is silent. The fix is `/adkit update` — reword the drifting level toward the keyword theme (or rename the ad group / re-point the ad at the on-theme landing page if those are the odd ones out).

## Keyword CPC & cluster split

On by default (with the serving layer; `--no-serving` skips it), the audit pulls **per-keyword average CPC** over the `--days` window and emits it as `keywordCpc` (`{campaignId: [{text, matchType, adGroupId, avg_cpc, avg_cpc_micros}]}`, priciest first). Each row carries its numeric `adGroupId` and keyword `matchType` (EXACT/PHRASE/BROAD; both `null` only in the shouldn't-happen case where the API omits the field), so a keyword pause/update plan (`{customerId, keywords:[{adGroupId, pause:[{text, matchType}]}]}`) is authorable straight from one audit run — no `/adkit report` round-trip. From that it computes `clusterSplits`: a campaign whose **top keyword CPC is ≥ 3× the cheapest** is mixing a cheap-broad and an expensive-intent keyword group under one budget — one shared budget/bid lets the cheap terms win every auction and starve the expensive ones (the reputation-split pattern). Each entry carries `maxCpc`/`minCpc`/`ratio`, the `expensive`/`cheap` groups, and a `reason`. The fix is structural: split the expensive group into its own campaign with its own budget and $3–6 bids (publish via `/adkit create`), not a creative tweak.

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

- JSON report → **stdout** (per-campaign findings, per-ad `issues`, `keywords`, `actionItems`, `pathToExcellent`, plus each ad's full `headlines`/`descriptions` **text** so `/adkit update` can preserve good copy when authoring rewrites/appends; plus the serving-layer `serving`/`keywordCpc`/`clusterSplits`/`addNegatives`/`promoteKeywords`/`qualityScore`/`landingPageHealth`/`psi`). Redirect it: `> /tmp/audit.json`.
- Human summary → **stderr** (the table with `-> path to EXCELLENT` lines).
- Flags: `--all` (include paused/removed), `--no-serving` (skip the impression-share layer), `--days 7|14|30` (IS window), `--banned "a,b,c"` (phrases that signal copy leaked from another product — substring-based; product-specific, no universal default, always pass the phrases you expect from neighbouring products in the account), `--differentiation-profile <path.json>` (the per-run me-too/differentiation profile that drives `undifferentiated_copy` — absent ⇒ nothing flagged; see *Professional-lane signal* above), `--psi-key <key>` (operator-supplied PageSpeed Insights API key; env `PAGESPEED_API_KEY` is used when the flag is absent — see *Landing page health* below).
- Resolve a campaign name in `$ARGUMENTS` to an id by matching against the JSON's `campaignName` (or pass the id directly).

## Report

Surface, per campaign: the findings, the **path-to-EXCELLENT per ad**, the impression-share recommendation (and why), and any cannibalization/cold-start flags. End with the next step: **to apply the fixes, run `/adkit update`** (you author the copy; `ads.sh update` validates + mutates). Note anything you'd deliberately leave alone (e.g. a converting POOR ad).

## Landing page health

`ads.sh audit`'s JSON already carries `landingPageHealth` (URL/redirect policy findings + windowed mobile/AMP/speed findings) and `qualityScore` (per-keyword CTR/relevance/landing-page-experience). Per SKILL.md's "use subagents aggressively" rule, **spawn a subagent** to do this analysis in parallel with the rest of the report: hand it [`reference/audit-landing-page.md`](audit-landing-page.md) plus the run's `landingPageHealth` and `qualityScore` slices, and fold its output into the final report as the landing-page-health section. See that file for the full detection table, the Quality-Score-driven prioritization rules, and the write-up format.

**PageSpeed Insights auto-diagnosis (`psi`)**: when any keyword shows a below-average landing-page experience (`landingPageExp = BELOW_AVERAGE`, Google's "≤ 2" bucket) **and** an operator PSI key is available (`--psi-key` or `PAGESPEED_API_KEY`), the audit runs PageSpeed Insights (mobile) once per distinct ad final URL and emits `psi` (`{skipped, results:[{ok, url, lcpMs, renderBlocking[], unusedJs[]} | {ok:false, url, error}]}`) — LCP, render-blocking, and unused-JS signals that close the loop from "your LP score is low" to "here's the exact fix". Without a key, `psi.skipped` names the reason and no external call is made; with no below-average score, PSI is skipped silently. The key is operator-supplied — the audit never creates or deletes a GCP key (a temp create→use→delete key lifecycle, if you want one, is an operator step outside the audit).

## Notes

- A persistent "Add N more sitelinks" `action_item` while a campaign already shows 6 sitelinks usually means they're pending review or not eligible — check approval status before recommending more.
