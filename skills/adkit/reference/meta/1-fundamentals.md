# Meta Ads Fundamentals

## Contents

- [Interruption vs Search Advertising](#interruption-vs-search-advertising)
- [How Meta's Auction Works](#how-metas-auction-works)
- [The Learning Phase](#the-learning-phase)
- [Advantage+ and Automated Bidding](#advantage-and-automated-bidding)
- [Conversion Tracking](#conversion-tracking)
- [The Feedback Loop](#the-feedback-loop)

---

## Interruption vs Search Advertising

Meta (Facebook, Instagram, Messenger, Audience Network) is **interruption-based**: ads appear between content the user chose to consume. Nobody opened Instagram looking for your product. This makes it fundamentally different from Google Search.

|                     | Interruption (Meta)                                  | Search (Google)                              |
| ------------------- | ---------------------------------------------------- | -------------------------------------------- |
| **When ads show**   | In feeds, Stories, Reels — between organic content   | When the user types a relevant query         |
| **Audience intent** | Low — wasn't looking for you                         | High — actively seeking a solution           |
| **Conversion rate** | Lower (cold traffic)                                 | Higher (warm/hot traffic)                    |
| **Reach ceiling**   | Massive — limited only by platform users and budget  | Capped by search volume for your keywords    |
| **Core challenge**  | Creative: stop the scroll, then earn the click       | Relevance: keyword → ad → landing page       |

**Use Meta when:** your buyers don't search for the category yet, or search volume is too small to scale. A new "AI meeting notes for sales teams" product has little search demand, but plenty of sales managers scroll Instagram.

**Use both when:** budget allows. Meta creates new demand; Google captures the demand that follows.

---

## How Meta's Auction Works

Meta's auction is not purely a price war. The winning ad maximizes **total value** to both the advertiser and the user:

```
Total Value = Advertiser Bid × Estimated Action Rate + Ad Quality
```

- **Advertiser bid:** what you're willing to pay for the optimization event (set explicitly or by the bid strategy)
- **Estimated action rate:** Meta's prediction that *this* person takes *your* optimization event
- **Ad quality:** feedback signals — hides, reports, engagement bait, low-quality landing pages

A relevant ad with a high estimated action rate beats a bigger bid on a weak ad. **Creative and audience fit lower your costs; bidding more does not fix a bad ad.**

**Relevance diagnostics** (ad-level, compared against ads competing for the same audience):

| Diagnostic                  | What Meta compares                                         |
| --------------------------- | ---------------------------------------------------------- |
| **Quality ranking**         | Perceived quality vs other ads for the same audience       |
| **Engagement rate ranking** | Expected engagement (clicks, reactions, shares)            |
| **Conversion rate ranking** | Expected conversion rate for your optimization goal        |

These are diagnostics, not auction inputs. Use them to find *why* an ad underperforms (e.g. high engagement ranking + low conversion ranking → the landing page or offer is the problem, not the hook). They need a minimum number of impressions (roughly 500) before they appear.

---

## The Learning Phase

Every time an ad set launches or is significantly edited, delivery enters the **learning phase** while the system explores who converts. Performance is volatile and CPA is usually higher during it.

**Exit condition:** roughly **50 optimization events per ad set within 7 days** of the last significant edit. Meta has been experimenting with lower thresholds for some objectives, but plan around 50.

**What resets learning (a "significant edit"):**
- Changing targeting, placements, optimization event, or bid strategy
- Adding a new ad or making creative changes to an ad
- Pausing the ad set for 7+ days
- Large budget or bid changes (big jumps, not small incremental ones)

**"Learning limited"** means the ad set isn't projected to reach ~50 events a week. For B2B SaaS this is the default state when optimizing for demo requests at $300+ CPA. Fixes, in order: consolidate ad sets, broaden the audience, raise budget, or optimize for a higher-volume event further up the funnel (Lead or CompleteRegistration instead of a qualified demo).

**Rule: batch your edits.** Five small changes over five days means five resets. One consolidated change means one.

---

## Advantage+ and Automated Bidding

Meta's delivery is automated by default. The choice is how much control to keep.

| Bid strategy              | What it does                                                   | Use when                                        |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| **Highest volume**        | Spends the full budget for the most results; no cost control   | Launch default; gathering data                  |
| **Cost per result goal**  | Keeps average cost per result around a target (formerly Cost Cap) | You have a stable, known CPA                 |
| **ROAS goal**             | Targets a minimum return on ad spend (needs value data)        | Purchase value is passed with events            |
| **Bid cap**               | Caps the bid in each auction                                   | Strict per-auction control; accepts less volume |

**Never launch on a tight cost goal.** A target set below what the market bears simply stops delivery. Start on highest volume, learn your real CPA, then set a goal near it.

**Advantage+ layers:**
- **Advantage+ campaigns:** automation-first setup for Sales, Leads, and App Promotion objectives (Advantage+ Shopping was renamed Advantage+ sales campaigns in 2025; Meta has since folded manual and Advantage+ setup into one flow)
- **Advantage+ audience:** your targeting becomes a *suggestion*; Meta expands beyond it when it predicts better results
- **Advantage+ placements:** delivery across all eligible placements instead of a hand-picked list

For B2B SaaS, automation expands into consumer audiences unless the conversion signal is strong. Feed it qualified events, not just raw form fills.

---

## Conversion Tracking

Meta's optimization is only as good as the events it receives. Tracking is non-negotiable.

- **Meta Pixel:** browser-side JavaScript. Loses signal to ad blockers, cookie restrictions, and iOS privacy changes.
- **Conversions API (CAPI):** server-side events sent directly from your backend. Recovers lost signal and can send offline events (e.g. a lead that became an opportunity in your CRM).
- **Run both, deduplicated.** Send the same `event_name` and a shared `event_id` from Pixel and CAPI so Meta counts the conversion once.

**Event Match Quality (EMQ):** Meta's 0–10 score for how well event customer data (hashed email, phone, IP, user agent, `fbp`/`fbc`) matches Meta users. Higher EMQ → more attributed conversions → better optimization. Send hashed email with every lead event.

**Standard events for B2B SaaS:**

| Event                    | Typical use                                  |
| ------------------------ | -------------------------------------------- |
| `Lead`                   | Demo request, contact sales, gated content   |
| `CompleteRegistration`   | Account created / free signup                |
| `StartTrial`             | Free trial started                           |
| `Subscribe`              | Paid conversion (pass `value` and `currency`) |

**Aggregated Event Measurement (AEM):** Meta's privacy protocol for measuring web events from opted-out iOS users. Since mid-2025 Meta aggregates eligible web events automatically — the old manual 8-event ranking in Events Manager is gone for web. Domain verification in Business Manager is still worth doing.

---

## The Feedback Loop

Meta runs on a creative-driven feedback loop: **Launch → Analyze → Refine.**

- Every week, break down results by ad: which hooks, formats, and angles earn cheap results
- You decide: scale the winner / iterate on its angle / turn off the loser
- Better creative → higher estimated action rate → lower cost per result
- Stronger conversion signal (CAPI, qualified events) → better audience expansion

The loop doesn't stop. **Creative fatigue is constant** — frequency climbs, CTR falls, and CPA drifts up as the same audience sees the same ad. Refresh creative on a schedule, not just when results collapse, and batch changes to protect the learning phase.
