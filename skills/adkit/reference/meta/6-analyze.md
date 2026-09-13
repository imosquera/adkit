# Analyze & Scale

The audit workflow for a running account. The loop that keeps delivery, creative, and measurement honest as Meta's algorithm shifts spend around.

**Weekly for 60 days, then monthly.** No exceptions.

---

## Breakdown Report Audit

Pull `/{ad-account-id}/insights` at `level=adset` with one breakdown family per request:

- **Date range:** last 30 days (`date_preset=last_30d`)
- **Placement:** `breakdowns=publisher_platform,platform_position` — Facebook vs Instagram vs Audience Network vs Messenger, Feed vs Reels vs Stories
- **Demographics:** `breakdowns=age,gender`
- **Geography:** `breakdowns=region` (or `country` for multi-country ad sets)
- **Sort:** spend descending — act on where the money went, not on row count

Don't combine action breakdowns (`action_type`) with delivery breakdowns in one call — unsupported combinations often return empty rows instead of an error. Reach and unique fields broken down by age/gender/placement only go back 13 months.

### What to Act On

| Finding | When | What to do |
| --- | --- | --- |
| **Placement bleed** | A placement takes 20%+ of spend at 2x+ the ad set's cost per lead | Build placement-specific creative first; exclude the placement only if that fails |
| **Demographic skew** | Leads cluster in an age band that doesn't match your ICP (e.g. 18–24 for a VP-level tool) | Check lead quality in the CRM before narrowing — cheap leads can still be junk |
| **Regional waste** | A region spends with zero qualified pipeline over 30 days | Exclude it, or split sales-territory regions into their own ad set |
| **Ignore** | Small slices, few conversions, no pattern | No action. Advantage+ placements rebalance on their own. |

**Breakdowns describe delivery, they don't control it.** Meta shifts spend toward the cheapest results, so a segment that looks efficient may just be where the auction was cheap. Judge every slice against CRM outcomes (SQLs, pipeline), not on-platform leads alone.

---

## Creative Fatigue

Pull `frequency`, `ctr` (or `inline_link_click_ctr`), and `cpm` at `level=ad` with `time_increment=7` to see week-over-week trends.

Refresh an ad when **two or more** of these move together for 2+ consecutive weeks:

- [ ] Frequency keeps climbing on a fixed audience (prospecting audiences fatigue faster than retargeting)
- [ ] Link CTR declines against the ad's own first two weeks
- [ ] CPM rises while audience size and competition are unchanged
- [ ] Cost per lead rises with no change to landing page or offer

**Compare an ad to its own baseline, not to other ads.** A demo-request ad and a guide download have different normal CTRs. Refresh with a **new concept** (new hook, new proof point, new format) — a recolored version of the same image fatigues just as fast.

---

## Landing Page CVR Check

Track the funnel per ad set: **link click → landing page view → lead** (`inline_link_clicks` → `actions[landing_page_view]` → `actions[lead]` or your custom conversion).

- **Link click → LPV drop-off** is a load or tracking problem, not a creative problem. Meta counts a landing page view only after the pixel fires, so slow pages lose people before they count. Fix page speed before touching the ad.
- **LPV → lead drop-off** is a page problem. Ad sets below the account median with 50+ landing page views need a **dedicated landing page** whose headline matches the ad's promise.
- **In-app browser:** most Facebook and Instagram clicks open in Meta's in-app browser, where people aren't logged into your app, password managers and autofill are less reliable, and third-party cookies are limited. Test every form inside the Facebook and Instagram apps on iOS and Android, not just desktop Chrome. Long multi-step signup flows suffer most — consider Instant Forms for top-of-funnel offers.

---

## Attribution Windows

The default attribution setting is **7-day click, 1-day view**. Available windows (`action_attribution_windows`): `1d_click`, `7d_click`, `28d_click`, `1d_view`, `1d_ev`.

- **`7d_view` and `28d_view` were removed on January 12, 2026.** Requests for them return empty data, not an error — check that saved reports and scripts aren't silently reading blanks.
- **Click-through now means link clicks only** (rolled out March 2026). Conversions after likes, shares, saves, or comments moved to **engage-through attribution** (formerly engaged-view), which also covers video views of 5+ seconds followed by a conversion within 1 day.
- **View-through and engage-through inflate B2B numbers.** A decision-maker who scrolled past a video and later signed up after a sales email still counts. Report click-through conversions separately when deciding what to scale.

**Meta's lead count will never match the CRM.** Reconcile monthly: pull `7d_click` leads per campaign and compare against CRM leads with matching UTM source. A persistent gap above your normal baseline points to broken UTMs, a missing Conversions API event, or view-through credit — not to real leads.

---

## Scaling Signals

Do **all three** before increasing budget:

- [ ] Cost per qualified lead at or below target for 2+ consecutive weeks (CRM-verified, not on-platform)
- [ ] Ad set out of learning — about 50 optimization events in the 7 days since the last significant edit
- [ ] Frequency stable and no fatigue signals on the top ads

### Vertical Scaling (More Budget)

- Increase budget **about 20% at a time**. Wait 3–7 days before the next increase. Ads Manager sometimes shows the exact amount you can raise to without re-entering learning — use it when it appears.
- **Significant edits reset learning:** targeting changes, creative changes, adding new ads, changing the optimization event, changing bid strategy, large budget or bid changes, and pausing for 7+ days. Batch these into one edit instead of spreading them over the week.
- **Never change budget and creative simultaneously** — you can't diagnose what moved cost per lead.

### Horizontal Scaling (More Surface)

- **New audiences:** a lookalike built from closed-won customers, not all leads, or a new job-function or industry segment in its own ad set
- **New creatives:** add fresh concepts to a winning ad set in one batch rather than trickling them in
- **Duplication:** copy a winning ad set into a new campaign to test a new audience or region. Duplicates start learning from scratch and can compete with the original for the same people — exclude overlapping audiences.

If budget increases stop lowering cost per lead, the growth lever is **new audiences and new concepts** — not more budget.
