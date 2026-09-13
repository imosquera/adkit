---
description: "Download Google Ads metrics (down to keyword/search-term) — or Meta Ads metrics (down to ad, placement, age/gender) when platform is meta — for a trailing window or the account's whole history, then write a markdown analysis + a Chart.js HTML dashboard to ads/output/reports/."
argument-hint: "--customer <id> [--manager <id>] [--days 14] [--all-time] [--include-paused]  (a bare positional <customer> also works; default 14 days; BOTH the customer and the manager/login id are resolved from flag -> env -> adkit.yaml, never defaulted to a placeholder)"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

**Before proceeding, read:**
- [`reference/google/6-analyze.md`](google/6-analyze.md) — scaling signals, auction insights, and the three-way STR decision framework
- **Meta** (`platform: meta` in `adkit.yaml`, `ADKIT_PLATFORM=meta`, or `--platform meta`): [`reference/meta/6-analyze.md`](meta/6-analyze.md) instead — breakdown audit, creative fatigue, attribution windows, scaling signals. Then follow the [Meta](#meta) section below, which overrides steps 1–3.

## Execution

You are generating a Google Ads performance report (for a Meta ad account, the
same three steps apply with the changes in [Meta](#meta)). Three steps: pull, analyze,
visualize. Do not invent numbers — every figure must come from the pulled report.

### 1. Pull the data

Run the data pull, passing through `$ARGUMENTS` verbatim (may be empty):

```bash
bash ads.sh report $ARGUMENTS
```

This prints the path to a raw YAML file under `ads/output/reports/` named
`<YYYY-MM-DD>-<customer>-raw.yaml`. If the command exits non-zero (bad
credentials → run `ads.sh render-yaml`; or no enabled campaigns matched), stop
and report the error to the user — do not fabricate a report.

**Customer.** There is no default customer id either — a placeholder default used
to send a bare `ads.sh report` at an account nobody owns. It resolves the same way
every other command resolves it, first non-blank wins: `--customer <id>` (or a bare
positional id) → `GOOGLE_ADS_CUSTOMER_ID` → `target_customer_id` in `adkit.yaml` →
a one-time prompt on a terminal, which saves the answer. With none of those, the
run fails naming the field and the file rather than querying a made-up account.

**Window and status.** By default the report covers the last `--days N` (14)
complete days over ENABLED campaigns only. Two flags widen that:

- `--all-time` — the account's entire history instead of a trailing window. Use it
  for "what has this account ever done", e.g. an account with dormant campaigns.
- `--include-paused` — drop the ENABLED-only filter so paused campaigns are
  reported too. Dormant history is invisible without this at any window size.

They compose: `bash ads.sh report --all-time --include-paused` is the everything
view.

**Manager / mcc-customer-id.** There is no default manager id. The login header
is resolved through this precedence chain, first non-blank wins:

1. `--manager <id>` on the command line,
2. the `GOOGLE_ADS_LOGIN_CUSTOMER_ID` environment variable,
3. the `mcc_customer_id` in `adkit.yaml` (set by `ads.sh init` or a hand-edit —
   it is an account number, not a secret) — inherited, the same source `audit`
   and `preflight` use.

If neither the flag nor the variable supplies a value, the run inherits whatever
`adkit.yaml` carries: an MCC login when the file has one, and no login header
at all when it does not — which is exactly what a directly-accessible account
needs. Ids may be given in dashed form (`222-222-2222`) and are normalised to 10
digits; a malformed id is rejected up front, naming the tier it came from
(`--manager` or `GOOGLE_ADS_LOGIN_CUSTOMER_ID`). Blank or whitespace-only values
count as absent, so an exported-but-empty variable falls through rather than
clearing an MCC login.

The `manager_id` field in the raw YAML records the id actually used — including
one inherited from `adkit.yaml` — and is `null` when no login header was sent
(or, rarely, when the credentials could not be read back to name it). If a query
fails, the error text names the manager the run actually went through, or says the
login came from `adkit.yaml`, so you can see which tier supplied it.

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

## Meta

When the resolved platform is `meta` (`--platform` → `ADKIT_PLATFORM` →
`platform` in `adkit.yaml`; absent means Google), `ads.sh report` pulls from the
Meta Graph API instead. The three steps and the three output files are the same;
what changes is below. Everything not mentioned here (no invented numbers, the
recommendations-first dashboard layout, the report-back step) still applies.

### 1. Pull the data — Meta flags and fields

```bash
bash ads.sh report $ARGUMENTS                  # adkit.yaml already says platform: meta
bash ads.sh report --platform meta $ARGUMENTS  # otherwise
```

- **Ad account.** `--ad-account <id>` → `META_AD_ACCOUNT_ID` →
  `meta_ad_account_id` in `adkit.yaml` → a one-time prompt on a terminal (saved).
  `123` and `act_123` are both accepted and normalised to `act_123`; that
  `act_<digits>` form is the `<customer>` in every output file name. There is no
  manager: `--manager` does not apply and `manager_id` is always `null`.
- **`--days`, `--all-time`, `--include-paused`** behave as for Google, with one
  limit: Meta keeps at most **37 months** of insights, so `--all-time` is clamped
  and `window.start`/`window.days` report the clamped span — say so in the
  analysis rather than calling it the account's whole history.
- **`--result-action <action_type>`** (default `lead`; e.g.
  `offsite_conversion.fb_pixel_lead`, `complete_registration`) picks which Meta
  action counts as a conversion. `conversions` is the sum of that action's value;
  `cost_per_conversion` is spend over it. A different action means different
  numbers — state which one the run used.
- **`--attribution <windows>`** (default `7d_click,1d_view`; allowed `1d_click`,
  `7d_click`, `28d_click`, `1d_view`, `1d_ev`). `7d_view` and `28d_view` were
  removed by Meta on 2026-01-12 and are **refused** with an error explaining the
  removal — do not retry with them; pick an allowed window (see
  [Attribution Windows](meta/6-analyze.md#attribution-windows)).

**Errors.** On success the report path is the only thing on stdout (exit 0). On
any failure (bad flags, credentials, a Graph API error, or no campaigns with
activity in the window, in which case nothing is written) the Meta report exits 1
and writes a JSON envelope **on stdout**, not free text on stderr:
`{ "ok": false, "message": "...", "step": "..." }`. `step` names where it stopped
(`args`, `credentials`, `report-account`, a `report-*` insights read, `report`
for the zero-campaign case, or `write`). Stop and relay `message`; do not
fabricate a report.

The raw YAML keeps the Google shape so the same reading applies, with these
differences:

- Top level adds `platform: meta`, `currency` (money fields are plain decimal
  amounts in that currency, not micros), `attribution` (the windows used), and
  `result_action`. `recommendations` is always `[]` — keyword clustering is
  Google-only.
- `ad_groups` are **ad sets** (`campaign_id` joins as before). `ads[].type` is
  `META_AD` and `ads[].ad_strength` is `UNSPECIFIED` — Meta has no ad-strength
  grade, so ignore the field. `keywords` and `search_terms` are always `[]`.
- **Every** metric row (`campaigns`, `campaign_daily`, `ad_groups`, `ads`, `geo`,
  `geo_regions`, `placements`, `demographics`) also carries `reach`,
  `frequency`, `cpm`, and `link_clicks`. `ctr` is a fraction (clicks /
  impressions) as for Google, not Meta's percentage.
- **`geo`** — account-level rows from Meta's `country` breakdown. The ISO 3166-1
  alpha-2 code (e.g. `US`) sits in `country_criterion_id` (the Google field name,
  kept so the same tooling reads it) **and** is repeated as `country`; it is not a
  Google criterion id, so don't look it up as one. Sorted by spend.
- **`geo_regions`** — account-level rows from Meta's `region` breakdown, keyed by
  `region` name (e.g. `California`). Sorted by spend.
- **`placements`** — account-level rows keyed by `publisher_platform`
  (facebook, instagram, audience_network, messenger) and `platform_position`
  (feed, story, reels, …).
- **`demographics`** — account-level rows keyed by `age` bucket and `gender`.
- A breakdown value Meta left blank is keyed `(unknown)`.
- `campaign_daily` **ends at `window.end` (yesterday), not today**: unlike
  Google, the Meta daily rows cover the same complete days as the aggregates and
  have no partial trailing day. `window.partial_day` is still set (today's date)
  but no row carries it, so don't mark a trailing day partial and don't use
  `campaign_daily` to judge whether the account is serving right now.

### 2. Write the analysis — Meta

Same file name (`<YYYY-MM-DD>-act_<id>-analysis.md`) and header, plus the
currency, the `result_action`, and the attribution windows. Keep the per-campaign
table (label it with the result action, e.g. "leads" and "cost/lead").

**Omit** the Google-only sections: Cluster analysis (`promote_keywords`,
`add_negatives`, `split`), the ad-strength findings, and any keyword/search-term
findings — the data is empty by construction, so never write "no keywords found".

**Add**, citing specific entities and dollar figures, judged with
[`reference/meta/6-analyze.md`](meta/6-analyze.md):

- **Placement findings** — placements taking a meaningful share of spend with no
  results or cost/result well above the account (see
  [Breakdown Report Audit](meta/6-analyze.md#breakdown-report-audit)). Remember
  breakdowns describe where Meta delivered, not a lever to micro-manage; exclusions
  go through [`reference/meta/5-exclusions.md`](meta/5-exclusions.md#placement-exclusions--block-lists).
- **Demographic findings** — age/gender buckets with outsized spend and weak
  results, and whether they match the intended buyer.
- **Geo findings** — countries (`geo[].country`) or regions (`geo_regions`)
  taking spend outside the intended market, or with cost/result well above the
  account.
- **Frequency** — read `frequency` on `placements`/`demographics` and on the ad
  set (`ad_groups`) and `ads` rows; high frequency alongside falling link CTR or rising
  CPM marks
  [creative fatigue](meta/6-analyze.md#creative-fatigue); for per-ad fatigue
  run `/adkit audit`, and recommend a new concept, not a recolour.
- **Attribution note** — one short paragraph: the windows used, that view-through
  and engage-through credit inflate B2B results, and that Meta's lead count will
  not match the CRM.
- **Anomalies** as for Google — ACTIVE campaigns spending nothing (often an ad set
  stuck in review or [learning](meta/1-fundamentals.md#the-learning-phase)),
  zero-impression days, spend spikes.

Recommendations stay **3–6** spend moves ranked by dollars at stake; before
recommending more budget, check the
[Scaling Signals](meta/6-analyze.md#scaling-signals).

### 3. Build the dashboard — Meta

Same self-contained Chart.js file (`<YYYY-MM-DD>-act_<id>-dashboard.html`) and
the same pinned **Recommendations & flags** card, with money shown in `currency`.

**Omit** the Top keywords / search terms chart, the Ad strength chart, the
`ad_strength` badges, and match-type tags. The drill-down tree becomes
`campaign → ad set → ad` (no keyword level); keep the sortable headers and the
cost/result colouring.

**Keep** Spend over time and CTR by campaign. **Add**:

- **Placements** — bar chart over `placements` (label
  `publisher_platform / platform_position`), spend with results or cost/result
  alongside, top ~15 by spend.
- **Demographics** — grouped bar chart over `demographics`: x = `age`, one series
  per `gender`, y = spend (and a second view or tooltip for results).
- **Frequency** — bar chart of `frequency` by placement and by age/gender bucket
  (plus per ad set or ad from `ad_groups` / `ads`), with a reference line
  at 3.5 — the level `/adkit audit` treats as a fatigue signal.
- **Attribution note** — a small caption under the summary stats naming the
  attribution windows and `result_action`, e.g. "Leads counted at 7-day click,
  1-day view".
