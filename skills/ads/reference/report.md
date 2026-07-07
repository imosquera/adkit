---
description: "Download last N days of ENABLED-campaign Google Ads metrics (down to keyword/search-term), then write a markdown analysis + a Chart.js HTML dashboard to ads/output/reports/."
argument-hint: "[<customer>] [--manager <id>] [--days 14]  (defaults: 891-192-5499 via 419-315-8021, 14 days)"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

**Before proceeding, read:**
- [`reference/google/6-analyze.md`](google/6-analyze.md) — scaling signals, auction insights, and the three-way STR decision framework

## Execution

You are generating a Google Ads performance report. Three steps: pull, analyze,
visualize. Do not invent numbers — every figure must come from the pulled report.

### 1. Pull the data

Run the data pull, passing through `$ARGUMENTS` verbatim (may be empty):

```bash
bash .claude/commands/ads/scripts/ads.sh report $ARGUMENTS
```

This prints the path to a raw YAML file under `ads/output/reports/` named
`<YYYY-MM-DD>-<customer>-raw.yaml`. If the command exits non-zero (bad
credentials → run `ads.sh render-yaml`; or no enabled campaigns matched), stop
and report the error to the user — do not fabricate a report.

Read that YAML. Its shape: `customer_id`, `manager_id`, `window`
(`start`/`end`/`days`/`partial_day`), `generated_at`, arrays `campaigns`,
`campaign_daily`, `ad_groups`, `ads`, `keywords`, `search_terms`, and a
precomputed `recommendations` array (per campaign: `promote_keywords`,
`add_negatives`, and a `split` cluster recommendation or null — see step 2). Each
metric row carries `cost`, `impressions`, `clicks`, `ctr`, `avg_cpc`,
`conversions`, `cost_per_conversion`. The aggregate arrays (`campaigns`,
`ad_groups`, `ads`, `keywords`, `search_terms`) cover complete days
`start`→`end`. `campaign_daily`
runs through `window.partial_day` (today), so its **trailing date is the partial
current day** — use it to report whether the account is serving *right now*, but
mark it partial in any trend chart so the incomplete day doesn't read as a real drop.
The hierarchy joins on ids: `ad_groups.campaign_id` → `campaigns.id`; `ads` and
`keywords` carry both `campaign_id` and `ad_group_id`. `ads` rows also carry `id`,
`name` (falls back to `Ad <id>` when blank), `type`, and `ad_strength` (Google's
creative grade: POOR/AVERAGE/GOOD/EXCELLENT/PENDING).

### 2. Write the analysis (markdown)

Write `ads/output/reports/<YYYY-MM-DD>-<customer>-analysis.md` (same date/customer
as the raw file). Include:

- A header noting the account, manager, and date window.
- A per-campaign performance table (spend, impressions, clicks, CTR, avg CPC,
  conversions, cost/conversion), sorted by spend descending.
- A **Cluster analysis** section driven by the precomputed `recommendations`
  block (one entry per campaign) — do not re-derive it by hand:
  - `promote_keywords` — search terms that earned clicks/conversions but aren't
    keywords yet (scale-up: add as PHRASE keywords),
  - `add_negatives` — search terms that spent with zero conversions (wasted
    spend → negative-keyword candidates),
  - `split` — when non-null, the campaign mixes a cheap-broad and an
    expensive-intent keyword group (CPC spread crosses the threshold); surface
    the `reason`, `expensive`/`cheap` groups, and recommend splitting the
    expensive group into its own campaign/budget (the reputation-split pattern).
- **Findings** that cite specific entities, not generic advice. Look for:
  - campaigns with meaningful spend and **zero conversions** (candidates to pause),
  - low-CTR campaigns/keywords relative to the account (creative/targeting issues),
  - **POOR/AVERAGE `ad_strength` ads carrying real spend** (fix-the-creative
    candidates — quantify how many ads and what share of spend sit below GOOD),
  - top keywords/search terms by conversions (scale-up candidates),
  - **anomalies to diagnose** — days with 0 impressions, campaigns ENABLED but
    spending $0 / serving 0 impressions, single-day spend spikes, impressions
    with no clicks. Explain the *likely cause* (not serving, budget exhausted,
    ads disapproved, just launched, paused), not just the observation.
- A **3–6 item** prioritized **recommendations** list, each a concrete ad-spend
  move (cut waste / reallocate budget / scale a converter) ranked by dollars at
  stake and tied to the findings above.

### 3. Build the dashboard (self-contained HTML)

Write `ads/output/reports/<YYYY-MM-DD>-<customer>-dashboard.html`: a single
self-contained file that opens directly in a browser with **no build step or
server**. Load Chart.js from a CDN `<script>` tag (e.g.
`https://cdn.jsdelivr.net/npm/chart.js`). Embed the data inline as a JS object
(do not fetch the data file at runtime). Render at minimum:

- **Recommendations & flags — pinned at the very top**, directly under the title
  and summary stats and ABOVE every chart, as a distinct callout card (e.g.
  left-accent border) so it's the first thing read. Two short lists:
  - **How to improve ad spend** (**3–6** prioritized moves, ranked by
    dollars at stake): each is a spend decision — cut waste (negative-keyword
    candidates + the $ they'd recover), reallocate budget away from high-CPA /
    zero-conversion campaigns toward the efficient ones, or scale a proven
    converter. Each item = one-line action + the specific campaign/keyword/term +
    the dollar figure that motivates it. Lead with the biggest dollar impact.
  - **Things worth a look** (anomalies/diagnostics): call out and *explain* odd
    data, e.g. **days with 0 impressions** (campaign paused or not serving that
    day, daily budget exhausted, ads disapproved, or only just launched),
    campaigns ENABLED but with $0 spend / 0 impressions over the whole window
    (likely not actually serving — check status, budget, approvals), single-day
    spend spikes, or impressions with no clicks. Give the likely cause, not just
    the observation. Also state **today's serving status** from the trailing
    `campaign_daily` row (`window.partial_day`) — e.g. "0 impressions so far today
    — serving may have stopped after the window or budget is exhausted".
- **Spend over time** — line chart from `campaign_daily` (x = date, y = cost),
  one series per campaign or a stacked total.
- **CTR by campaign** — bar chart over `campaigns`.
- **Top keywords / search terms** — bar chart of the top ~15 by spend (and/or
  conversions), so the view stays readable with large result sets.
- **Ad strength** — small bar/donut over `ads` counting POOR/AVERAGE/GOOD/
  EXCELLENT/PENDING, so the share of below-GOOD creative is visible at a glance.
- **Drill-down table** — below the charts, an expandable tree
  `campaign → ad group → ad → keyword`, built by joining `ad_groups`, `ads`, and
  `keywords` on their `campaign_id`/`ad_group_id`. Each row shows spend,
  impressions, clicks, CTR, conversions, and **cost/conversion**. Color
  cost/conversion against the account-average cost/conversion (green = at/below,
  red = above, "—" = zero conversions). Rows collapse by default; clicking a
  campaign, ad group, or ad toggles its children. Make the **column headers
  sortable**: clicking a header sorts every level of the tree by that metric,
  clicking again reverses; show an active-sort arrow on the header. Label ad rows
  by `name`, tag them with `type`, and show a color-coded **`ad_strength`** badge
  (red POOR / amber AVERAGE / green GOOD); tag keyword rows with their match type.

Keep it clean and legible: a title with the account + window, the charts in a
simple responsive grid, and a small summary stat row (total spend, clicks,
conversions). No external CSS/JS beyond the Chart.js CDN tag.

### 4. Report back

Tell the user the three output paths and a 2–3 sentence summary of the headline
findings (biggest spender, anything wasting money, best performer).
