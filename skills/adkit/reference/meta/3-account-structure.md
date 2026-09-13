# Account Structure

## Campaign, Ad Set & Ad Logic

**Campaigns by objective and budget. Ad sets by audience. Ads by message.**

The Marketing API splits control across three levels. Put each decision where it lives:

| Level        | What lives here                                                                                  | Key API fields                                                              |
| ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **Campaign** | Objective, budget type (campaign budget or ad set budgets), bid strategy when budget is at campaign | `objective`, `daily_budget` / `lifetime_budget`, `bid_strategy`, `special_ad_categories` |
| **Ad set**   | Audience, placements, optimization goal, conversion event, schedule, ad set budget (if not at campaign) | `targeting`, `optimization_goal`, `promoted_object`, `destination_type`, `start_time` / `end_time` |
| **Ad**       | Creative — image/video, primary text, headline, CTA, URL or instant form                         | `creative`, `status`                                                        |

- Split campaigns only when they need a different **objective, budget, conversion event, or reporting line**
- Split ad sets only when the **audience or optimization event** genuinely differs (e.g. cold prospecting vs. site retargeting)
- Test messages as **ads inside one ad set**, not as one ad set per creative

**Never mix cold and warm audiences in one ad set** — retargeting converts at a different cost and will soak up the budget, hiding how prospecting actually performs.

---

## Objectives — B2B SaaS

Meta's six outcome-based (ODAX) objectives map to `OUTCOME_*` values in the API:

| Objective         | API value               | Use for B2B SaaS                                                                                  |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| **Leads**         | `OUTCOME_LEADS`         | Default for demo requests, gated content, webinar signups. Core budget.                          |
| **Sales**         | `OUTCOME_SALES`         | Self-serve trials or paid signups tracked as website conversions via Pixel + Conversions API.   |
| **Traffic**       | `OUTCOME_TRAFFIC`       | Content distribution and warming audiences. Don't judge it on pipeline.                          |
| **Awareness**     | `OUTCOME_AWARENESS`     | Launches and category education at scale. Rarely worth it on a small budget.                     |
| **Engagement**    | `OUTCOME_ENGAGEMENT`    | Video views to build retargeting pools. Cheap, but not a lead source.                            |
| **App promotion** | `OUTCOME_APP_PROMOTION` | Only if the product is a mobile app. Skip for web SaaS.                                          |

**Instant forms vs. website conversions:** instant forms (`destination_type: ON_AD`) are frictionless and cheap per lead, but quality is usually lower — add qualifying questions and sync CRM outcomes back so Meta can optimize for conversion leads. Website conversions (Pixel + CAPI, `OFFSITE_CONVERSIONS`) cost more per lead but reuse your own form, enrichment, and routing. **Optimize for the event closest to revenue that still fires ~50 times a week.**

Leads and Sales campaigns become **Advantage+ leads / sales campaigns** (API `advantage_state`) when Advantage+ campaign budget, Advantage+ audience, and Advantage+ placements are all on. Turning off any of the three makes it a manual campaign.

---

## CBO vs ABO

| Scenario                                                    | Budget setting                         | Why                                                                                       |
| ----------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| New account, one audience, testing creative                 | Advantage+ campaign budget (CBO)       | Meta shifts spend to the ads and placements that convert. Fewest decisions to get wrong. |
| Ad sets with very different sizes (broad vs. small retarget) | Ad set budgets (ABO)                   | CBO will starve the small audience. ABO guarantees each pool gets spend.                 |
| Controlled audience or offer test                           | Ad set budgets (ABO)                   | Equal, fixed spend per variant keeps the comparison clean.                                |
| Proven winners, scaling                                     | Advantage+ campaign budget (CBO)       | Consolidate winners into one campaign and let delivery allocate.                         |
| Want Advantage+ leads/sales status                          | Advantage+ campaign budget (CBO)       | Required — ad set budgets turn Advantage+ off.                                           |

---

## Budget Split — New Account (Days 0–60)

Reference example at €5K/month:

| Campaign                | Budget       | Why                                                                |
| ----------------------- | ------------ | ------------------------------------------------------------------ |
| **Prospecting — Leads** | 70% · €3,500 | Primary volume driver. Broad or lookalike audience, demo/trial event |
| **Retargeting**         | 20% · €1,000 | Site visitors, video viewers, form openers who didn't submit       |
| **Creative testing**    | 10% · €500   | New hooks and formats before promoting them into prospecting       |

**After 60 days:** rebalance on the signal closest to revenue — trial→paid for self-serve SaaS, closed-won for sales-led B2B. Don't rebalance on cost per lead alone — instant forms will always win that and lose on pipeline.

---

## Consolidation Rules

**Fewer ad sets, each with enough budget to exit learning.** An ad set stays in the learning phase until it gets roughly 50 optimization events in 7 days; below that it shows **Learning limited** and delivery stays unstable.

- **Size the budget to the event:** daily ad set budget ≥ ~7 × target cost per event (50 events ÷ 7 days). At a €60 target CPL that's ~€420/day — more than most new B2B accounts have per ad set.
- **Can't afford it? Move up the funnel or consolidate** — optimize for a cheaper, more frequent event (lead instead of SQL), or merge ad sets until one clears the bar
- **Don't split audiences by interest** — one broad ad set usually beats five narrow ones competing in the same auction
- **Don't edit during learning** — significant changes to budget, targeting, creative, or optimization event restart it

---

## Naming Convention

Name every level so a report row explains itself:

```
Campaign: "LEADS | Prospecting | Demo | CBO"
Ad set:   "Broad US – Ops Leaders | Website Lead"
Ad:       "Missed Deadlines – Video 15s – v2"
```

Every ad set name should make the audience and the optimization event obvious. If it doesn't, the structure is off.
