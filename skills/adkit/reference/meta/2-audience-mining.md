# Audience Mining

Meta has no keywords. Its equivalent is building the audiences an ad set targets. On Meta, **the creative does most of the targeting**: the delivery system decides who sees an ad based on who engages with it, so audience mining is about supplying strong **signals** (seed lists, conversion events, exclusions), not drawing tight fences around who can see the ad. There are two starting points that use the same process: **first-party** sources are the best signal and work from day one if you have a CRM, and **on-platform** sources become useful once the pixel and pages have traffic.

## Sources

Ranked by signal strength. A list of people who actually paid you beats any interest Meta guesses.

### First-party (use at launch)

- **Customer list Custom Audience**: hashed emails and phones from your CRM (paying customers, SQLs, closed-won). This is the strongest seed. Split lists by value, e.g. a list of your top-LTV accounts works better than a list of every signup.
- **Conversions API (CAPI) + pixel events**: `Lead`, `StartTrial`, `Subscribe`, `Purchase`. Send server-side events alongside the pixel so events survive browser blocking. Beyond targeting, these events are what the ad set optimizes for.
- **Suppression lists**: current customers, open opportunities, employees. **Exclude these through Custom Audience exclusions.** That is the only way to exclude people now.

### On-platform (add once there's traffic)

- **Website visitors**: pixel audiences such as all visitors, pricing-page visitors, and people who started a trial but didn't activate, with a retention window of up to 180 days.
- **Engagement audiences**: people who watched your video, submitted or opened a lead form, or engaged with your Page or Instagram account. These are warm prospects who haven't visited the site yet.
- **Lookalikes**: built from a customer list or a high-intent event audience. The source needs **at least 100 people from one country**, and Meta recommends 1,000–5,000.

### Detailed targeting (interests, behaviors, demographics)

Treat these as a weak signal. **Detailed-targeting exclusions were removed in 2025**, and many niche interests were merged into broader ones. Ad sets still using retired options stopped delivering on January 15, 2026. Job-title, employer and industry options are unreliable or gone for B2B: confirm in targeting search before you plan around them. Sensitive topics (health, religion, politics, sexual orientation) have been gone since 2022.

---

## Broad vs Interest vs Lookalike vs Advantage+ Audience

| Approach | What you set | Use when |
| --- | --- | --- |
| **Advantage+ audience** (the default) | Optional **audience suggestions** (Custom Audiences, lookalikes, age, gender, interests) + hard **audience controls** | Most prospecting. Pixel/CAPI already reports conversions |
| **Broad** | Location, age and language only | Enough conversion volume that the algorithm needs no hints |
| **Lookalike** (original audience) | A 1–10% lookalike of a seed | Testing whether a particular seed list performs better |
| **Interest / detailed** (original audience) | Interests and behaviors, with expansion often applied | Niche B2B with thin pixel data. Use as a short test, not a long-term setup |
| **Custom Audience only** | A retargeting or customer list | Retargeting, upsell, and re-engaging stalled trials |

**Suggestions are soft, controls are hard.** In an Advantage+ audience, suggestions are starting hints and Meta will deliver beyond them. Only these **audience controls** actually restrict delivery: location, minimum age, language, and Custom Audience exclusions. Lookalikes under Advantage+ also expand past the percentage you pick. If your budget must never reach a group, express that as a control or an exclusion. Never rely on a suggestion for it.

---

## Screening Audience Size

1. **Estimated audience size**: Ads Manager and the API's reach estimate show a range, not an exact count. For prospecting, a range in the low millions or more in the target country gives the algorithm room. For retargeting, small is fine, but a list too small to deliver steadily is a sign to pool it with another list.
2. **Seed minimums**: a lookalike needs 100 people and works better at 1,000 or more. A customer list also needs a good match rate: upload email + phone + name + country to raise it. Work emails match poorly because most Facebook accounts are registered with personal emails, so include every identifier you have.
3. **Overlap**: run the Audience Overlap tool on candidate audiences in Ads Manager. **If two ad sets share a large part of their audience, merge them.** Otherwise they bid against each other in the same auctions.

---

## Group into Ad Sets

One funnel stage and one signal per ad set: prospecting, website retargeting, and trial re-engagement. Each ad set gets the creative that fits its stage. Keep the number of ad sets low so each one gets enough conversions to leave the learning phase. Splitting a thin budget across many overlapping ad sets is Meta's version of cramming 50 keywords into one ad group. Always exclude customers from prospecting ad sets.

---

## Quick Reference

- **First-party sources:** CRM customer lists · CAPI + pixel events · suppression lists (available at launch)
- **On-platform sources:** website visitors · engagement audiences · lookalikes (once traffic exists)
- **Detailed targeting:** a weak signal · no interest exclusions since 2025 · B2B job-title/industry options unreliable or removed
- **Default:** Advantage+ audience · suggestions are soft · controls (location, min age, language, CA exclusions) are hard
- **Screening:** reach estimate range · seed ≥100 (aim for 1,000+) · overlap tool, merge overlapping ad sets
- **Grouping:** one funnel stage per ad set · few ad sets · customers always excluded from prospecting
