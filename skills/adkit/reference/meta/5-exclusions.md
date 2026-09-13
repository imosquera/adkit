# Exclusions

Meta has no search terms, so there are no negative keywords. Exclusions are how you keep budget off people who cannot or should not buy: current customers, your own staff, job seekers, and placements that wreck lead quality.

## Exclusion Layers

Exclusions live in three places. Know which one wins before you build.

| Layer | Where | What it holds | Scope |
| --- | --- | --- | --- |
| **Account controls** | Ad account advertising settings | Locations, minimum age (18–25), excluded custom audiences, one employer exclusion | Every new campaign in the account |
| **Ad set audience** | Ad set targeting (`excluded_custom_audiences`, `excluded_geo_locations`) | Campaign-specific custom audience and geo exclusions | That ad set only |
| **Placement controls** | Ad set placements + business-level brand safety | Placement opt-outs, publisher block lists, inventory filter | Where the ad renders, not who sees it |

**Rule:** anything that must be true for *every* campaign (served countries, minimum age, customer list exclusion for acquisition) goes in account controls. Advantage+ audience treats audience controls as hard constraints; everything in "audience suggestions" is only a hint.

**Detailed targeting exclusions are gone** (removed January 2025). You can no longer exclude by interest, job title, or behavior. Exclusion now means custom audiences, geography, age, and the employer control.

**Check campaign type:** Advantage+ sales and app campaigns do not honor ad set-level custom audience exclusions, and the employer and brand-protection account controls do not apply to them. Use account-level audience controls or the existing-customer definition there instead.

---

## Existing Customers & Converters

You pay to reach people who already bought unless you exclude them. For acquisition campaigns, this is the first exclusion to set up.

**Build these custom audiences and exclude them from prospecting:**

| Audience | Source | Retention |
| --- | --- | --- |
| Paying customers | Customer list (CRM export or sync) | No expiry — refresh the upload on a schedule |
| Trial / signup converters | Pixel or Conversions API event (`CompleteRegistration`, `StartTrial`) | 180 days (website max) |
| Leads submitted | `Lead` event, or lead form engagement audience | 90–180 days |
| Logged-in app users | Website audience on app URLs (`/app`, `/dashboard`) | 30–180 days |

**Define existing customers once.** In ad account settings, the existing-customer definition (built from these custom audiences) drives the new vs. existing customer audience segments, reporting breakdowns, and the new-customer acquisition setting in Advantage+ sales campaigns.

**Retention window rule:** match the window to the sales cycle. A 14-day trial needs at least 30 days; a quarter-long enterprise cycle wants 180. Too short and recent converters re-enter prospecting.

**Exception:** retargeting and upsell campaigns target these same audiences — exclude them from prospecting only, never account-wide if you run expansion campaigns.

---

## Employees & Job Seekers

Your own team and people researching you as an employer inflate engagement and pollute lead forms.

**Employer exclusion:** account controls allow excluding people who list one specific company as their employer on Facebook. Set it to your own company.

**Also exclude:** a customer list of employee emails, and a website audience of careers-page visitors (`/careers`, `/jobs`) over 90 days.

**Job seekers** can no longer be excluded by interest. Keep job-seeker language (hiring, careers, salary) out of ad copy and forms, and keep the careers-page audience excluded.

---

## Placement Exclusions & Block Lists

Placements decide lead quality as much as audiences. Accidental clicks on low-quality inventory produce junk leads for B2B SaaS.

| Control | What it does | B2B SaaS default |
| --- | --- | --- |
| **Audience Network** | Third-party apps and sites | Exclude for lead gen until tested; watch for low-quality form fills |
| **Publisher block list** | Blocks specific Pages, profiles, creators, apps, and sites (upload list, up to account limits) | Add any publisher with clicks but no qualified leads |
| **Content block list** | Keeps ads away from organic Feed and Reels content from listed accounts | Competitors, controversial accounts |
| **Inventory filter** | Sets sensitivity for in-content ads (Reels, Instream) and Audience Network | See Brand Safety |

**Rule:** do not switch Advantage+ placements off wholesale. Exclude the placement that underperforms after it has spent enough to judge, and keep the rest open.

---

## Wrong Geography or Language

If you only sell in specific markets, block regions you can't serve.

**Rule:** set served countries in account controls so no campaign can ship outside them. Use `excluded_geo_locations` at the ad set for carve-outs (sanctioned regions, markets without a sales team or data-residency support).

**Language:** set `locales` only when your product and sales process are single-language. Location alone does not guarantee language.

**Check:** break down results by region and country weekly in the first month. Lead forms from unserved markets mean the location control is too loose.

---

## Brand Safety

B2B buyers judge the brand by what appears next to it.

**Inventory filter tiers** (apply to in-content ads and Audience Network):

- **Expanded** — content that meets Content Monetization Policies; maximum reach. Default since February 2025.
- **Moderate** — excludes highly sensitive content. Lower reach, possibly higher cost.
- **Limited** — excludes additional sensitive content and all live videos. Lowest reach.

**Rule:** start at **Moderate** for B2B SaaS unless the brand has a stated tolerance for Expanded. Pair it with a publisher block list; the filter is a tier, not a list.

**Also set:** the brand-protection audience exclusions in account controls, and review delivery reports (published publisher lists) for Audience Network placements.

---

## Review Cadence

- **First 60 days:** weekly — check placement and region breakdowns, update block lists, refresh the customer list upload
- **After 60 days:** monthly — exclusions drift as customers churn in and new publishers appear

The three-way decision for every unexpected placement or segment in a breakdown: **exclude** (block list or audience exclusion), **isolate** (own ad set to test), or **ignore** (low spend, no signal yet).
