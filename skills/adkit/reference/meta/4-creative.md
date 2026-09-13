# Creative — Hook, Format, Placement

On Meta the creative is the targeting: with broad audiences, the asset decides who stops scrolling. Each piece of text and media has a job: stop the scroll, qualify the viewer, and move the right one to click. The goal is **data velocity**. Ship a few distinct options, learn which ones win, then lean into them.

> Nobody on Meta searched for you. Earn the first second before you ask for the click.

---

## Text Pools

Three text fields, each with a distinct job. Meta's lengths are **recommendations, not hard caps**: longer text is truncated behind "See more" or cut off by the placement.

| Field            | Recommended  | Job                                                                                          |
| ---------------- | ------------ | -------------------------------------------------------------------------------------------- |
| **Primary text** | ≤ 125 chars before "See more" | Hook + qualifier. The first line carries the ad; everything after it is optional reading. |
| **Headline**     | ≤ 40 chars   | The offer or outcome, next to the CTA button. Often truncated on mobile, so front-load it.      |
| **Description**  | ≤ 30 chars   | Proof or friction-reducer ("SOC 2 Type II", "No credit card"). Many placements hide it, so never put essential info here. |

- **Multiple text options.** Supply up to **5 primary texts, 5 headlines, 5 descriptions** per ad (flexible format / Advantage+ creative). Meta tests the combinations per impression.
- **Make each option a different angle**, not a rewrite of the same sentence. Five near-synonyms give Meta nothing to learn from.
- **Every option must stand alone.** Any primary text can pair with any headline, so no option may rely on another to make sense.
- **Front-load the qualifier.** "For RevOps teams at 50+ seats:" in the first line filters out mismatched clicks before you pay for them.

---

## Persuasion Angles

Specs make creative _valid_; angles make it _convert_. Spread the text options and visuals across these frames rather than restating one benefit. Angle choice follows the theme's **resolved buying-cycle temperature** (cold / warm / hot / scalding, defined in `gtm.md`). Most Meta traffic is cold, so default to problem and curiosity angles. Save hard CTAs and urgency for retargeting or hot/scalding themes.

- **Cost of Inaction.** `[Pain Point] + [Time/Money Loss] + [Solution]`. E.g. "Your reps lose 6 hrs/week to CRM data entry" (only when the source backs the number).
- **Pattern interrupt / call-out.** `[Audience] + [Specific Frustration]`. E.g. "Finance teams still reconciling in spreadsheets:". Works cold because it earns attention without a search intent.
- **Proof / risk reversal.** `[Trust Signal] + [Risk Reversal] + [Offer]`. E.g. "Trusted by 2,000 agencies. Free for 14 days."
- **FOMO / scarcity-urgency.** `[Limit] + [Benefit] + [Deadline]`. Hot/scalding and retargeting only.

> **Honest-use gate (binding).** Scarcity, deadlines, guarantees, customer counts, and proof numbers may be used **only when the source idea backs them**. If the source states no such fact, **omit the angle**. Never invent stats, and never overlay a claim on an image that the landing page can't honor.

**Emotion → logic handoff.** Let the visual and first line hit the feeling ("Stop chasing invoices"). Let the headline and description deliver the rational benefit and next step ("Automated reminders. Start free trial").

---

## The Hook

The hook is the **first 3 seconds of video** and the **first line of primary text**. If those don't stop the scroll, nothing after them gets seen.

- **Video: open on the payoff or the problem**, not the logo. Put the product, the pain, or the result on screen in the first frame.
- **Design for sound off.** Burn in captions or on-screen text. The hook has to read without audio.
- **Show the product early.** For SaaS, a real UI moment (dashboard, before/after, workflow in motion) beats stock footage.
- **Brand inside the hook, not before it.** A logo in the corner or a product frame beats a logo intro.
- **First line of primary text = a standalone hook.** Question, call-out, or sharp claim. No "We're excited to announce".

| Format           | Use when                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| **Single image** | One clear claim or offer (webinar, report, trial). Fastest to produce and test.              |
| **Video**        | Showing a workflow or transformation. Strongest format for cold audiences.                    |
| **Carousel**     | 2–10 cards: step-by-step walkthrough, feature tour, multiple use cases, or a sequential story. |
| **Collection**   | Mobile, commerce-style catalog browsing. **Rarely fits B2B SaaS**, so skip unless you sell a catalog. |

---

## Placements & Aspect Ratios

Build **two crops per concept, 4:5 and 9:16**, and let placement asset customization serve the right one. A single 1:1 asset stretched everywhere wastes Stories/Reels real estate.

| Placement                          | Aspect ratio                   | Notes                                                        |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| **Feeds** (FB, IG, Explore)        | **4:5** preferred; 1:1 supported | 4:5 takes more vertical screen on mobile. 1080×1350.        |
| **Stories & Reels** (FB, IG)       | **9:16**                       | 1080×1920. Full-screen vertical.                             |
| **Right column / search / in-stream** | 1:1 or 16:9                    | Low priority for B2B. Let Advantage+ placements handle them. |

**9:16 safe zone.** Keep text, logos, and CTAs out of the **top ~14%** (profile/header), the **bottom ~35%** (caption, CTA, and audio overlays; Reels is the tightest), and **~6% on each side**. Design for Reels and the asset is safe on Stories too.

**Advantage+ placements (default: on).** Let Meta distribute budget across placements. It usually lowers cost, so keep it on. Exclude placements only for a specific reason (e.g. Audience Network brand-safety concerns). Do not exclude a placement just because you lack an asset for it: make the asset.

---

## Dynamic & Advantage+ Creative

**Flexible ad format.** Upload up to 10 images/videos plus up to 5 of each text field. Meta picks the format and combination per placement and person. This is the Meta equivalent of responsive search ads. Use it for testing breadth.

**Advantage+ creative enhancements** are individual opt-ins in the API (the `standard_enhancements` bundle was deprecated in Marketing API v22.0). Set each feature under `degrees_of_freedom_spec.creative_features_spec` with `enroll_status: OPT_IN | OPT_OUT`. Several default to on in Ads Manager, so **set every one explicitly**.

| Enhancement (API field)                      | B2B default | Why                                                                           |
| -------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| Visual touch-ups (`image_touchups`)          | Opt in      | Crops/resizes for placement. Low brand risk.                                   |
| Text improvements (`text_optimizations`)     | **Opt out** | Swaps text between fields. Can reorder claims or surface a description as the headline. |
| Add overlays (`add_text_overlay`) / image templates (`image_templates`) | **Opt out** | Generated overlays and frames can collide with product UI and brand type. |
| Image animation / expansion / background generation (`image_animation`, `image_background_gen`) | **Opt out** | AI-altered product screenshots misrepresent the UI. |
| Music (`music_generation`)                   | **Opt out** | Stock music on a product demo reads as consumer, not B2B.                     |
| Relevant comments (`inline_comment`)         | Opt out     | Surfaces public comments under the ad. You don't control which.                |
| Translation / generated CTAs (`text_translation`, `generate_cta`) | **Opt out** | Unreviewed copy in your name.                        |

**Rule:** only opt in to what doesn't rewrite your words or alter your product imagery. Revisit an opt-out only after you've previewed its output in Ads Manager and approved it.

---

## Checklist Before Launching

- [ ] Each ad has 3–5 primary texts, 3–5 headlines, 2–3 descriptions, each a distinct angle
- [ ] Every first line works as a standalone hook within ~125 chars
- [ ] Headlines ≤ 40 chars, front-loaded; no essential info only in the description
- [ ] Every video hook lands in the first 3 seconds and reads with sound off
- [ ] Each concept exported in 4:5 and 9:16
- [ ] 9:16 text/logo/CTA clear of top 14%, bottom 35%, sides 6%
- [ ] Advantage+ placements on (or exclusions justified)
- [ ] Every creative enhancement set explicitly; text rewrites, overlays, music, and AI image edits opted out
- [ ] All proof numbers, deadlines, and guarantees traced to the source idea

---

## B2B SaaS Quick Reference

- **Primary text**: hook + audience call-out in the first line. 3–5 options, distinct angles.
- **Headline**: offer/outcome ≤ 40 chars ("Start Free Trial", "Get the 2026 Benchmark")
- **Description**: proof or friction-reducer ≤ 30 chars. Assume it may be hidden.
- **Formats**: video for cold workflow demos, carousel for feature tours, single image for gated offers
- **Crops**: 4:5 feed + 9:16 Stories/Reels. Respect the 14% / 35% / 6% safe zone.
- **Placements**: Advantage+ placements on
- **Enhancements**: visual touch-ups on. Text improvements, overlays, music, AI image edits, and comments off.
