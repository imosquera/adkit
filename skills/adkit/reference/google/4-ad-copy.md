# Ad Copy — Modular Relevance System

Write ads as a modular relevance system: each asset has a job and earns its place in the slot it serves. The goal is **data velocity** — learn which combinations work, then lean into them.

> Write ads like modular relevance systems, not as Google-score bait.

---

## Headline Pools

Three pools, each with a distinct job. 8–10 headlines total distributed across the pools.

- **H1 — Catch attention.** Keyword echo, problem, or audience match. The searcher needs proof you understood the query. H1s typically contain or mirror the keyword. Pin 2–3 to Position 1 during learning.
- **H2 — Create interest.** Main benefit, differentiator, USP, or pain-point resolution. In B2B, H2 often doubles as a qualifier ("for RevOps teams", "for agencies with 10+ clients") to filter out mismatched clicks.
- **H3 — Lower friction.** Proof, trust, speed, authority — social proof, integrations, time-to-value, guarantees. This pool rotates most freely.

Round out with **1–2 CTA headlines** (demo, trial, pricing) and **2–3 descriptions** (concise problem → solution → CTA).

**Volume cap:** 10 headlines + 3 descriptions max. More dilutes combination data and slows convergence.

**Combo check:** Avoid synonyms in the same pool — "PM Software – PM Solution – Project Manager" in the same ad group reads as incoherent if all three appear together.

---

## Persuasion Angles

Structural constraints (counts, char caps) make copy _valid_; persuasion angles make it _convert_. Spread the headline set across these three offer-matched frames in addition to the plain value/feature/proof angles — don't restate one benefit across every slot. Which angles apply is governed by the theme's **resolved buying-cycle temperature** (cold / warm / hot / scalding — defined in `gtm.md`'s Buying-Cycle Temperature & Offer Matching section): scarcity-urgency and hard CTAs belong on **hot/scalding** themes only; cold/warm themes lean on curiosity, value, and the cost-of-inaction frame's softer end.

- **Cost of Inaction.** Confront what the buyer is *losing* by delaying, not just what they'd gain. Frame: `[Pain Point] + [Financial/Time Loss] + [Solution]`. E.g. "Stop Overpaying for Energy", "Outdated Software Slowing You Down?". Works across temperatures (the loss is real even when the buyer is early).
- **FOMO / scarcity-urgency.** Frame: `[Scarcity/Limit] + [Benefit] + [Urgency]`. E.g. "Only 3 Spots Left This Month", "20% Off — Ends Sunday". Hot/scalding themes only.
- **Risk mitigation / reversal.** Frame: `[Trust Signal] + [Risk Reversal] + [Solution]`. E.g. "100% Risk-Free 30-Day Trial", "Trusted by 10,000 Teams", "No Hidden Fees".

> **Honest-use gate (binding).** Scarcity, urgency limits, guarantees, risk-reversals, and proof numbers may be used **only when the source idea backs them** — a real spot limit, a real deadline, a real guarantee, a real customer count. If the source states no such fact, **omit the angle** rather than invent one. Never manufacture scarcity the landing page can't honor or a guarantee the product doesn't offer. This extends the existing "never invent stats — pull from the source idea" rule to scarcity and guarantees specifically.

**Emotion → logic handoff.** Pair an emotional or loss-framed headline with a description that follows through on the logic: the headline hits the feeling ("Stop Losing Leads Overnight"), the description delivers the rational benefit/feature and the next step ("Automated follow-up replies in under 60s — start your free trial"). Balance emotional and rational registers across the headline set rather than picking one.

---

## Quality-Score Alignment

Relevance is what lowers CPC and lifts Ad Rank. These rules keep the copy aligned to the query and the landing page:

- **Match the landing page.** The headline's offer/claim must match the destination — same promotion, same promise. Bait-and-switch tanks bounce rate and Ad Rank.
- **Use ad-group keywords in headlines.** Pull relevant keywords (including long-tail) from the theme into headlines to lift relevance and lower CPC. Don't keyword-stuff — natural phrasing beats jammed exact-match.
- **Keyword insertion.** Use `{KeyWord:<fallback>}` where the theme has many close variants so the ad mirrors the exact query (fallback reads naturally, ≤ 25 chars). Most valuable on themes with broad variant coverage; `gtm.md` requires it on hot/scalding themes specifically.
- **Explicit, instructive CTA.** Tell the searcher what to do — "Get Started", "Book a Demo", "Claim Your Free Consultation" — and pair it with urgency/exclusivity only where honest.
- **Lead with USPs, not generic features.** Capture what's unique (tech, service, price): "Gourmet Meals by Local Chefs" beats "Meal Delivery at Your Door".
- **Mix emotional + rational tonality.** Span both registers across the set — the emotional ("Embark on Your Dream Career") and the logical ("Cut Your Energy Bills in Half").
- **Avoid repetition.** Vary word choice across headlines; near-duplicate phrasings waste asset slots (reinforces the "no two headlines share the same opening 3 words" rule).
- **Use the full character limit purposefully.** Be descriptive within the cap — don't pad to hit it, and don't waste it.

---

## Pinning Strategy

Pinning accelerates learning. Unpinned headlines are tested across all combinations, which takes longer to reach significance.

| Phase              | Pinning approach                                                              |
| ------------------ | ----------------------------------------------------------------------------- |
| Launch → 4–6 weeks | Pin H1 (2–3 to Position 1) and H2 (1–2 to Position 2). Let H3 pool rotate freely. |
| After convergence  | Unpin H1/H2 progressively. Let Google find combinations you didn't anticipate.     |

**Three levers for sitelink promotion control:**

- **Block sitelink promotion entirely** — pin any remaining headlines to Position 3
- **Allow some promotion** — don't pin Headline 3
- **Maximize promotion** — pin all three positions, add extra unpinned headlines that can _only_ surface as sitelinks

---

## Supporting Assets

Add all of these before launching. Google uses them to fill ad space and improve CTR.

| Asset               | Guidance                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Sitelinks**       | Add beyond the display cap (6 desktop / 8 mobile) — Google selects the most relevant. |
| **Callouts**        | ≤ 25 chars each, not clickable. Specific and credible ("SOC 2 Type II", "14-day free trial"). Not vague fluff ("Best in class"). |
| **Structured snippets** | Factual categories, ≥ 3 values required to serve ("Features: API, SDK, Webhooks"). Not clickable, not persuasive.      |

**Disable ACA (Automatically Created Assets).** Google silently generates copy from your landing page. It's often off-brand and inconsistent. Disable it unless you've reviewed and approved its output.

---

## Checklist Before Launching

- [ ] Each ad group has ≥ 8 headlines across all three pools
- [ ] H1 pool contains at least one keyword echo
- [ ] H3 pool has at least one proof/trust asset
- [ ] 2–3 descriptions written (one pinned for brand consistency)
- [ ] Sitelinks added (4–6 minimum)
- [ ] Callouts added (4–6 minimum)
- [ ] Structured snippets added
- [ ] ACA disabled
- [ ] No combo of adjacent headlines reads as redundant or incoherent

---

## B2B SaaS Quick Reference

- **H1 pool** — keyword echo / problem statement / audience call-out. Pin 2–3 to P1.
- **H2 pool** — main differentiator or B2B qualifier. Pin 1–2 to P2.
- **H3 pool** — proof / trust / speed / authority. Rotate freely.
- **CTA headlines** — 1–2 ("Start Free Trial", "Book a Demo")
- **Descriptions** — 2–3, concise problem → solution → CTA
- **Sitelinks** — exceed display cap, let Google select
- **Callouts** — specific facts, not vague superlatives
- **Snippets** — factual categories (features, integrations, platforms)
