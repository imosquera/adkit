---
description: "Build the full Go-To-Market block for a processed idea: Keyword Planner-decorated keyword tiers (volume/competition/CPC), a semantic Keyword Themes grouping (the ad-group source of truth for /adkit create), PLUS a theme-matched Responsive Search Ad set (15 headlines / 4 descriptions) per theme. Reads raw, writes processed under Go To Market > Keywords + Keyword Themes + Ad Copy. (Merged ads:keywords + idea:adcopy.)"
argument-hint: "ideas/raw/<file>.md [--geo geoTargetConstants/N] [--language languageConstants/N] [optional idea notes]"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

Use user input when provided. Do not ask clarifying questions.

## Role

You are a focused Go-To-Market command for processed idea files. You run in **two phases against one file**: first keyword research (the `### Keywords` block plus the `### Keyword Themes` grouping), then Responsive Search Ad copy matched to those **themes** (the `### Ad Copy` block). All land under a single `## Go To Market` section.

Your job is to append practical search keywords to one existing markdown file for downstream landing-page and marketing use, cluster them into the 3–6 **Keyword Themes** that become the campaign's ad groups, then generate ready-to-paste RSA copy whose offer and message match each theme's resolved buying-cycle temperature.

**The `### Keyword Themes` section is the ad-group source of truth** — `/adkit create` parses it and makes one ad group per non-spend-trap theme. The four I/N/C/T intent tiers in `### Keywords` are **not** the ad-group grouping any more; they are a per-keyword buyer-intent + offer-matching annotation that each theme's resolved offer is derived from.

**Before proceeding, read:**
- [`reference/google/2-keyword-mining.md`](google/2-keyword-mining.md) — intent classification, screening criteria, grouping rules
- [`reference/google/4-ad-copy.md`](google/4-ad-copy.md) — headline pools, pinning strategy, asset checklist

You also classify each keyword by intent tier (which doubles as a buying-cycle temperature) and recommend an offer / CTA whose threat level matches that temperature, so the landing page does not ask for too much (or too little) given where the visitor actually is in their buying cycle.

## Input Contract

1. `$ARGUMENTS` is required.
2. Parse the first path-like token from `$ARGUMENTS` as the **raw** idea markdown file to read, preserving quoted paths with spaces.
3. The file must exist, must be a markdown file (`.md` or `.markdown`), and MUST resolve under `ideas/raw/` relative to the current working directory (this worktree). Do NOT look in sibling worktrees, the main checkout, or any other path outside this worktree.
4. Derive the **output** path by swapping `ideas/raw/` for `ideas/processed/` in the input path. Example: input `ideas/raw/inventive.md` → output `ideas/processed/inventive.md`. If the processed file does not exist yet, create it with a minimal frontmatter + the keywords section (the rest of the processed idea is the job of `/idea:process`).
5. Treat all remaining `$ARGUMENTS` text as optional idea notes. If optional idea notes are present, use them as additional context alongside the raw markdown file content.
6. If no valid raw markdown file is provided, return: `Error: Provide a valid raw idea markdown file path under this worktree's ideas/raw/ directory, for example ideas/raw/example.md.`

## Output Contract

1. Modify only the provided markdown file.
2. Append or replace, under a single `## Go To Market` section, these three subsections in order:
   - `### Keywords` — the four I/N/C/T intent tiers + Dropped + Negative Keywords (this section).
   - `### Keyword Themes` — the 3–6 semantic themes that become ad groups (see the Keyword Themes Contract below).
   - `### Ad Copy` — one RSA set per theme (see the Ad Copy Phase).
3. Under `### Keywords`, create these subsections in this order:
   - `#### Informational` (cold — early curiosity)
   - `#### Navigational` (warm — looking for a specific destination)
   - `#### Commercial` (hot — comparing options)
   - `#### Transactional` (scalding — ready to act)
   - `#### Dropped (off-topic)` — phrases the LLM filtered for being unrelated to this idea (see Step 9 below). Each bullet: `- <bullet_text> — reason: <one short phrase>`. Omit the subsection entirely if nothing was dropped.
   - `#### Negative Keywords` — phrases to **block** as campaign negatives so paid traffic (and AI Max / broad-match expansion) stays on-theme (see Step 9b below). Each bullet: `- <phrase> — reason: <one short phrase>`. `ads:create` auto-seeds these into `campaign.negativeKeywords`. Always emit at least 8.
4. Each subsection must begin with a single one-line `> Default offer:` blockquote stating the recommended CTA / offer for that tier (see Offer Matching below). No other explanatory paragraphs.
5. Each intent tier then lists keyword bullets. **Aim for ~100 keywords total to start**, spread across the four intent tiers (roughly 20-30 per tier) — a campaign needs at least 25 keywords to compete (what `ads:audit` flags as `keywords_under`), and starting near 100 gives real reach and room to prune to the winners. Use fewer only when the source is genuinely too thin; never fewer than 5 per subsection.
6. Each bullet uses the format: `- keyword phrase` by default. If the keyword's intent diverges from its tier default (a multi-intent keyword), append ` — offer: <recommended offer>` to that bullet only. Do not append the offer to bullets that match the tier default.
7. Keep keywords buyer-search realistic, specific, and useful for content, landing pages, and paid search.
8. Preserve the rest of the file exactly except for the `## Go To Market` keyword section update.
9. Return a concise status line with the modified file path and keyword counts.

## Keyword Themes Contract (the ad-group source of truth)

`### Keyword Themes` is written to the file (not screen-only) and is what `/adkit create` parses to build ad groups — **one ad group per non-spend-trap theme**. Author it per Execution Step 15c. Shape:

1. One subsection named exactly `### Keyword Themes`, placed AFTER `### Keywords` and BEFORE `### Ad Copy`.
2. It opens with a one-line `> ` note, then **3–6** themes, each an h4:
   ```
   ### Keyword Themes

   > One ad group per theme below (except [spend-trap], which feeds negatives only).

   #### <Theme Name> — <one-line role note>
   > Offer: <resolved offer for this theme>
   - keyword phrase one
   - keyword phrase two

   #### <Generic Theme Name> [spend-trap] — generic, keep-but-don't-lead
   - generic keyword one
   ```
3. **Theme name**: the h4 text up to the ` — role note`. It becomes `adGroups[].name`, so keep it short and human (`Salon Software`, `Barber / Stylist`).
4. **Spend-trap marker**: a theme that should never lead an ad carries the literal token `[spend-trap]` anywhere in its h4 heading (before or after the role note). `/adkit create` **excludes** it from ad groups; its terms are seeded into `#### Negative Keywords` instead (safe precisely because they're no longer live ad-group keywords). A spend-trap theme needs **no** `> Offer:` line (it gets no ad).
5. **`> Offer:` line** (non-spend-trap themes only): exactly one, directly under the h4. It is the theme's **resolved offer** = the Default offer of the theme's **highest-actionable represented intent tier** (Transactional > Commercial > Navigational > Informational) among its member keywords. This single line is what the Ad Copy Phase reads for that theme's RSA — no re-derivation from `### Keywords`.
6. **Keyword bullets**: bare phrases (no `(volume, …)` decoration needed — decoration lives in `### Keywords`), one per line. Every theme keyword MUST also appear in some `### Keywords` tier (the themes are a re-grouping of the kept set, not a new keyword source). A keyword appears in **exactly one** theme (no cross-theme duplication — that would cannibalize across ad groups).

## Keyword Research Guidance

0. **Qualify by buyer intent before topical relevance — this screen runs first.** A phrase can be perfectly on-vertical yet bring traffic that will never convert for a *paid* product. The classic trap: **free-intent / DIY-seeker modifiers** (`free`, `free download`, `template`, `theme`, `ppt`, `clipart`, `examples`, `sample`) when the product is paid software. They look relevant — they're in the category — but the searcher wants a free download, not a subscription, so they click, cost money, and never buy (this is exactly how an agency pitch-deck tool burned spend on `free powerpoints templates`, `slideshow template free`, `ppt slides`, `swot presentation template` with zero conversions). Before tiering, ask **"does this searcher want the transaction the product needs?"** — if the product is paid, treat zero-budget freebie queries like off-topic: drop them (with a reason) or, when borderline, tag them off-theme so they never lead a tier. If the product is lead-gen / free-tier, soften this. When such a phrase is dropped, its free-intent modifier becomes a valid negative (step 9b) — the "never negate a word that's in a kept keyword" rule only protects words you actually kept.
1. Use the source markdown as the primary product and audience context.
2. Use optional idea notes to refine the keyword universe, especially when they contain examples, positioning, or category language.
3. When available, use current search or web research to validate phrasing, adjacent terms, competitor/category modifiers, and common buyer language.
4. Include root keyword variations, long-tail variants, pain/problem queries, solution/category terms, and comparison terms.
5. Avoid stuffing near-duplicates that differ only by punctuation or word order.
6. Avoid brand names unless the source clearly names the brand or the keyword is navigational for the idea itself.
7. Prefer plain buyer language over internal jargon.
8. **Seed the category language buyers actually search; keep the differentiator in the copy.** The highest-volume keywords are the generic *category* language buyers type (`salon booking app`, `best scheduling app for estheticians`), NOT the product's differentiator — a differentiator phrasing like `book by text` typically has ~zero search volume. Seeds may pair the category with the differentiator to *probe* its volume (step 5), but the Keyword Planner only emits phrases at/above its volume floor (step 8), so a zero-volume differentiator phrasing simply never comes back as a candidate. Do not chase or hand-add zero-volume differentiator seeds to the kept keyword set — carry the differentiator in the RSA ad copy (Ad Copy Phase) instead, which is where it converts.

## Intent Definitions

### Informational (cold traffic)

Searchers want to learn, troubleshoot, or understand a concept. They are not ready to buy.
Examples: `how to structure google ads ad groups`, `what is a single keyword ad group`.
Default offer: low-threat lead magnet — guide, checklist, calculator, email-gated resource.

### Navigational (warm traffic)

Searchers want a specific product, brand, tool, page, template, calculator, guide, or known category destination.
Examples: `<brand> pricing`, `<category> template`, `<tool> demo`.
Default offer: route them to the exact thing — pricing page, demo video, template download, comparison page.

### Commercial (hot traffic)

Searchers are comparing options or evaluating vendors, structures, methods, or alternatives before buying.
Examples: `best google ads account structure`, `single keyword ad groups vs themed ad groups`.
Default offer: medium-threat conversion — book a demo, start free trial, multi-step lead form, instant-quote calculator.

### Transactional (scalding traffic)

Searchers are ready to act, buy, hire, book, download, start a trial, request a demo, or use a tool.
Examples: `hire google ads agency`, `download google ads keyword template`.
Default offer: high-threat direct CTA — phone call, instant signup, buy now, schedule today.

## Offer Matching (Multi-Intent Keywords)

A keyword's intent tier predicts traffic temperature, but some keywords inside a tier diverge.

The rule: **the offer's threat level must match the visitor's buying-cycle temperature, not just the literal keyword.**

- If a keyword sits inside a low-intent tier but the visitor is closer to action than peers in that tier, raise the offer threat (e.g., `sell my car` is transactional → ask for the phone call; `what's my car worth` is commercial-leaning informational → multi-step calculator that captures a lead, not a blog post).
- If a keyword sits inside a high-intent tier but ambiguity is high, lower the offer threat (e.g., `broken transmission` could be transactional for a junkyard buying cars, but the searcher is more likely trying to fix the car first → soft offer comparing repair cost vs sale value).
- Industries vary. Apply the source idea's category, buyer, and product to judge each keyword's true temperature, then pick the offer that converts that temperature without overreaching or underreaching.

When a keyword's true temperature differs from its tier default, flag it inline using the `— offer: <recommended offer>` suffix described in the Output Contract. Examples:

- `- broken transmission — offer: repair vs sell calculator (email gate)`
- `- what's my car worth — offer: multi-step instant-offer estimator`
- `- sell my car today — offer: tap-to-call for instant cash offer`

Keep recommended offers concrete (a real artifact or action), not abstract ("nurture content"). Tie them to something the landing page could actually ship.

## Section Update Rules

1. If the file already has `## Go To Market`:
   - If it already contains `### Keywords`, replace only the full `### Keywords` subsection.
   - If it does not contain `### Keywords`, append `### Keywords` to the end of `## Go To Market`.
   - Same rule for `### Keyword Themes` (replace the whole subsection if present) and `### Ad Copy`. Order within `## Go To Market`: `### Keywords`, then `### Keyword Themes`, then `### Ad Copy`.
2. If the file does not have `## Go To Market`, append it to the end of the file.
3. Preserve any other existing `## Go To Market` subsections.
4. Keep a single blank line between headings, the `> Default offer:` / `> Offer:` line, and the bullet list.
5. Bullet format:
   - `### Keywords` tier-default intent: `- keyword phrase`
   - `### Keywords` divergent / multi-intent: `- keyword phrase — offer: <recommended offer>`
   - `### Keyword Themes` keyword bullet: `- keyword phrase` (bare — no decoration or offer suffix).

## Execution Steps

1. Parse `$ARGUMENTS`. Extract the raw markdown file path (under `ideas/raw/`). Extract optional `--geo <value>` and `--language <value>` tokens (treat as paired). Remaining text is idea notes.
2. Validate the raw markdown file exists.
3. Compute the **processed** output path: replace `ideas/raw/` with `ideas/processed/` in the input path. If the processed file does not exist, create it with minimal frontmatter (`---\nsource_file: <raw path>\n---`) so subsequent edits attach somewhere stable.
4. Read the full raw markdown file (and any existing processed file for context — operator edits to keywords are still discarded when the section is rewritten).
5. **Anchor on the idea's core theme, then brainstorm seeds.** First extract 3–6 *core theme tokens* from the raw idea — its differentiator, primary audience, and the specific channels/jobs it names (for a brand-voice reply tool: `brand voice`, `replies`, `reviews`, `comments`, `social`, `DTC`). These tokens are the relevance yardstick reused in steps 9 and 11; record them. Then brainstorm an initial candidate list (`seeds`) from the raw idea + optional notes + theme tokens, using the Keyword Research Guidance and Intent Definitions above. **Seeds must combine the category with the differentiator and audience** (`brand voice reply tool`, `reply to reviews ai`, `social comment response`) — do NOT seed bare category stems alone (`chatbot`, `ai writing tool`); Keyword Planner expands bare stems into generic consumer noise that drowns the on-theme niche. (Seeds may pair the differentiator with the category to *probe* its volume, but do not expect zero-volume differentiator phrasings to survive as kept keywords — see Keyword Research Guidance item 8.)
6. Extract the first `https?://` URL found in either the raw or processed file. If none, leave it empty.
7. Invoke the Keyword Planner CLI to decorate and expand the candidate set:
   ```bash
   ads.sh keyword-ideas \
     [--page-url <url>] \
     [--geo <value>] \
     [--language <value>] \
     --seed "<kw1>" --seed "<kw2>" ...
   ```
   - Omit `--page-url` when no URL was extracted (the CLI emits a stderr note and proceeds with `keyword_seed` only — spec FR-018).
   - Omit `--geo` / `--language` flags entirely when not present in `$ARGUMENTS` (CLI defaults to US/English — spec FR-006).
   - On non-zero exit: surface the CLI's stderr verbatim, stop without modifying the file (spec FR-009).
8. Parse the CLI's stdout JSON array of candidates. Every element is backed by Keyword Planner data (avg monthly searches ≥ 1,000); bare/undecorated seeds are not emitted. Each element has `phrase`, a pre-built decorated `bullet_text`, raw metric fields, and `concept_group` — Google's own semantic grouping for the phrase (`null` when unannotated), which step 15c uses as its theme prior. **You MUST copy `bullet_text` verbatim into each bullet — do not regenerate the `(volume, competition, $L–$H)` decoration string (spec FR-017).** `concept_group` is a screen-only signal — never write it into the file.
9. **Buyer-intent + relevance filter + on-theme tag**: In one pass, judge each candidate's `phrase` against the raw idea content (the product, audience, vertical you read in step 4), the core theme tokens from step 5, and the **buyer-intent screen (guidance item 0)**. Three outcomes:
   - **Drop (wrong buyer)** — on-vertical phrases whose searcher won't make the transaction this product needs: for a *paid* product, free-intent / DIY-seeker queries (`free …`, `… template`, `… ppt`, `… download`, `… examples`) that hunt a freebie, not a purchase. Record them for `#### Dropped (off-topic)` with a reason like `free-seeker, not a buyer`. Skip or soften this when the product is genuinely free / lead-gen.
   - **Drop (off-vertical)** phrases that are off-topic for the *vertical* — a different vertical (e.g., home automation hits on `josh ai`/`control4`/`lutron` when the product is agency software), an adjacent industry (e.g., `crm for real estate agents`), or generic stem noise that matches no theme token AND carries no buyer intent for this product. Record dropped phrases (with `bullet_text` + a 2–6 word reason) for the `#### Dropped (off-topic)` subsection.
   - **Tag as off-theme** (keep, but mark) the on-vertical-but-off-positioning phrases — generic category terms that carry NONE of the core theme tokens yet are still plausible paid targets (e.g., bare `ai writing tool` / `ai powered chatbot` for a brand-voice reply tool). They stay for targeting but must NOT lead a tier (step 11). A phrase containing ≥1 core theme token is **on-theme**.
   Do NOT drop borderline-relevant phrases — keep them; the on-theme tag, not deletion, is what stops generic terms from defining the ad.
9b. **Generate negative keywords.** Build a list of ≥8 phrases to block as campaign negatives, so paid traffic (and AI Max / broad-match expansion) stays on-theme. Draw from three sources:
   - **The dropped phrases (step 9)** — the off-vertical / wrong-buyer terms are natural negatives (e.g. for an agency pitch tool: `marketing agency near me`, `seo`, the `mtg`/Magic-the-Gathering "deck" homonym).
   - **Generic intent-mismatch modifiers** the idea does not serve — common B2B blockers like `jobs`, `salary`, `course`, `tutorial`, `meaning`, `definition`, `reddit`, `free download`, `near me`, `hire`, `internship`, plus any modifier that signals the wrong buyer/intent for this specific product.
   - **Cannibalization guards** — single words that, if left to broad/close-variant matching, would pull clearly-wrong queries given the vertical (homonyms, adjacent industries).
   Each negative is a short phrase (PHRASE match is assumed downstream). **Do NOT negate any word that appears in a keyword you keep in an ad-group theme** — i.e. any keyword in a non-spend-trap `### Keyword Themes` theme (e.g. never negate `template` if a template term leads a live ad group) — that would suppress your own traffic. This guard does **not** protect spend-trap-theme terms: those are excluded from ad groups (step 15c), so they are no longer live keywords and are safe — indeed expected — to negate (see the next bullet). Prefer multi-word phrases over single broad tokens when a single token risks over-blocking.
   - **Seed the spend-trap theme's terms as negatives.** The generic `[spend-trap]` theme from step 15c gets no ad group, so its member phrases become negatives here. This is also the cluster `/adkit audit` most often flags as zero-conversion waste on a live campaign — in a real run those generic terms mapped ~1:1 to the wasted spend the audit surfaced. Because the theme is excluded from ad groups, negating its terms no longer contradicts the guard above.
10. Assign each surviving candidate to **exactly one** of the four intent tiers (Informational / Navigational / Commercial / Transactional) per the Intent Definitions, classifying by true buying-cycle temperature. This tier assignment is the **buyer-intent + offer-matching annotation** — it sets each keyword's Default offer and drives each theme's resolved `> Offer:` (step 15c). It is **no longer** the ad-group grouping: the STAG ad groups come from `### Keyword Themes` (step 15c), which `ads:create` parses. Keep a keyword in only one tier (never repeated across tiers) so its intent/offer is unambiguous; a tier no longer has to read as one coherent ad message (the *theme* does).
11. Within each tier, order bullets **on-theme first, then by `volume` descending** with alphabetical tie-break (on-theme = carries ≥1 core theme token per step 9; off-theme terms sink below every on-theme one and are the first truncated by step 12's cap). This keeps the idea's positioning at the top of each tier for readability and makes the highest-intent on-theme keywords easy to pull into themes at step 15c. (Amends the volume-only ordering of spec FR-016 — see the plan note.)
12. Cap each tier at 8–16 bullets; truncate the tail if more were classified there. If a tier has fewer than 5, redistribute / relax (existing keyword guidance).
13. For each tier, write the `> Default offer:` line that matches the tier's typical temperature for this idea's category and buyer.
14. Render each bullet as `- <bullet_text>` (using the verbatim CLI-provided string). For any candidate whose true temperature diverges from its tier default, append ` — offer: <recommended offer>` to that bullet (the offer suffix comes AFTER the decoration on the same line — spec FR-004).
15. If any phrases were dropped in step 9, append a `#### Dropped (off-topic)` subsection AFTER `#### Transactional`. Each bullet: `- <bullet_text> — reason: <2–6 word reason>`. Omit the subsection entirely if nothing was dropped.
15b. Append a `#### Negative Keywords` subsection LAST (after `#### Dropped (off-topic)`). Each bullet: `- <phrase> — reason: <2–6 word reason>`, using the step-9b list. Plain phrases only — **no** `(volume, …)` decoration (these are not Keyword Planner candidates). Always emit at least 8.
15c. **Keyword Themes — WRITE the `### Keyword Themes` section (the ad-group source of truth).** Cluster the **kept** keywords into **3–6 semantic themes** and write them to the file in the shape defined by the *Keyword Themes Contract* above. `/adkit create` parses this section and makes one ad group per non-spend-trap theme, so this is where the STAG grouping now lives (not the intent tiers — see step 10).
   - **Cluster from the deterministic prior.** Each candidate carries a `concept_group` (step 8) — Google's own semantic grouping. Group the kept keywords by `concept_group` first, then merge, rename, and split those raw groups into 3–6 operator-facing themes (a `null` concept_group → use your own judgment for that keyword). This anchors themes to real Keyword Planner data instead of clustering from scratch, so the grouping is stable run-to-run and not invented. Themes are **orthogonal to** the four intent tiers (which cut by buying-cycle temperature) and to the on-theme/off-theme tag from step 9 — a single theme can span several intent tiers and mix on-theme and off-theme keywords.
   - **Every theme keyword must come from the kept `### Keywords` set** (themes re-group the kept keywords; they do not introduce new phrases), and each kept keyword lands in **exactly one** theme (no cross-theme duplication — that cannibalizes across ad groups).
   - **Resolve each theme's `> Offer:`.** For each non-spend-trap theme, look at its member keywords' intent tiers (from step 10) and take the **highest-actionable** one — Transactional > Commercial > Navigational > Informational. Write that tier's Default offer as the theme's single `> Offer:` line. Rationale: AI Max expands past the literal keyword list, so biasing the offer toward the theme's hottest represented intent doesn't strand the colder long-tail; and one ad group needs one coherent offer, not four. The Ad Copy Phase reads this line directly.
   - **Flag exactly the generic "keep-but-don't-lead" cluster as `[spend-trap]`.** Mark that theme's h4 heading with `[spend-trap]`, give it **no** `> Offer:` line, and seed its member phrases into `#### Negative Keywords` (step 9b). It gets no ad group.
   - **Ad-group-split note (screen).** Alongside writing the section, tell the operator in the run output which **1–2 themes carry the highest on-theme intent** (the natural lead ad groups / campaign split) and which theme is the spend trap. This is commentary; the file section is the contract.
   - **Illustrative example** (a salon-booking idea — placeholder, do not leak this domain into real runs) as it lands in the file:
     ```
     ### Keyword Themes

     > One ad group per theme below (except [spend-trap], which feeds negatives only).

     #### Salon / Spa Software — category core (lead)
     > Offer: start free trial
     - salon booking software
     - salon management software

     #### Hair / Barber / Stylist — segment-specific (lead)
     > Offer: start free trial
     - hair stylist app
     - best scheduling app for estheticians

     #### Free / Freemium Intent — low-commitment
     > Offer: free plan signup
     - free appointment booking app

     #### Generic Scheduling [spend-trap] — generic, keep-but-don't-lead
     - appointment scheduling software
     - online scheduling tool
     ```
16. Update the **processed** file (computed in step 3) according to Section Update Rules. The raw file is never modified.
17. Re-read the processed file and verify:
   - exactly one `## Go To Market` section exists,
   - exactly one `### Keywords` subsection exists,
   - all four required tier subsections exist in order (Informational, Navigational, Commercial, Transactional),
   - the optional `#### Dropped (off-topic)` subsection, if present, comes before Negative Keywords,
   - a `#### Negative Keywords` subsection exists LAST with ≥8 plain-phrase bullets (no volume decoration),
   - each tier subsection has a single `> Default offer:` line directly under its heading,
   - each tier subsection has at least 5 keyword bullets,
   - any bullet with an offer suffix uses the exact ` — offer: ` separator.
   - **`### Keyword Themes`** exists (after `### Keywords`) with **3–6** `####` themes; **≥1** is NOT `[spend-trap]`; each non-spend-trap theme has exactly one `> Offer:` line and ≥1 keyword bullet.
   - **Theme↔tier consistency**: every theme keyword also appears in some `### Keywords` tier (themes re-group the kept set; no new phrases), and **no keyword appears in two themes** (cross-theme duplication cannibalizes ad groups — fix by moving it to one theme).
   - **Spend-trap → negatives**: every keyword under a `[spend-trap]` theme also appears in `#### Negative Keywords`.
18. Keyword phase done. Record each theme's name and its resolved `> Offer:` line — the Ad Copy phase generates one RSA per theme from them. **Do NOT return yet**; proceed to the Ad Copy phase below and emit a single combined status line at the end.

---

## Ad Copy Phase (runs after the Keyword phase, same file)

After `### Keyword Themes` is written, generate **one Responsive Search Ad set per non-spend-trap theme** and append them as `### Ad Copy`. You write the way a working PPC team writes: copy aligned to the theme's resolved temperature, offer matched to that temperature, claims backed by specific numbers, location and dynamic-keyword tokens used where they pay off, explicit CTAs. The `### Keyword Themes` block you just wrote is the source of truth — one RSA per theme, in the same order, each carrying that theme's `> Offer:` and its own keywords. (A `[spend-trap]` theme gets **no** ad group and therefore **no** RSA — skip it.)

### Ad Copy — Output Contract

1. Append or replace one subsection named exactly `### Ad Copy` under the same `## Go To Market` section, AFTER `### Keyword Themes`.
2. Under `### Ad Copy`, create **one subsection per non-spend-trap theme, in `### Keyword Themes` order**, each named `#### <Theme Name>` — the same theme name as its h4 in `### Keyword Themes` (so the RSA maps 1:1 to the ad group `/adkit create` builds). The number of subsections equals the number of ad groups (3–6, minus any spend-trap theme).
3. Each subsection begins with a single one-line `> Offer:` blockquote that MUST equal that theme's `> Offer:` from `### Keyword Themes` (which was resolved to the theme's highest-actionable represented tier — T>C>N>I). This one offer sets the whole ad set's temperature.
4. Each subsection contains **one RSA ad set** in this exact shape:

   ```
   **Headlines (15):**
   - <headline>
   - ...

   **Descriptions (4):**
   - <description>
   - ...

   **Display path:** /<path1>/<path2>

   **Notes:** <one short line covering location, FOMO, dynamic insertion, or RLSA usage if applicable>
   ```

5. Headline rules:
   - Exactly **15** unique headlines per theme (matches `/adkit create`'s Excellent-strength requirement so the copy is publish-ready).
   - Each headline ≤ 30 characters (spaces and punctuation count).
   - Cover distinct *angles* across the 15 — value prop, feature, social proof, urgency, offer/free, pricing, audience callout, objection, brand — not reworded twins.
   - Put the **theme's main keyword concept** in **≥3** headlines (Google rewards keyword inclusion); use the theme's shared concept, not every literal phrase.
   - At least 2 headlines contain a specific verifiable number (odd numbers preferred when plausible; never invent stats — pull from the source idea's pricing/timelines/capacity/proof).
   - At least 1 headline contains an explicit CTA verb (Get, Start, Book, Claim, Try, Save, Compare, Download, Call).
   - At least 1 headline includes a location token `{LOCATION(City)}` or `[City]` when the buyer is local/location-influenced.
   - When the theme's resolved offer is **hot or scalding** (its `> Offer:` came from a Commercial or Transactional tier), at least 1 headline uses dynamic keyword insertion `{KeyWord:<fallback>}` (fallback reads naturally, ≤ 25 chars).
   - No two headlines share the same opening 3 words. **Never pin** — assets must combine freely.
6. Description rules:
   - Exactly **4** unique descriptions per theme. Each ≤ 90 characters.
   - Different angles: offer, problem-solution, trust signal, CTA.
   - At least 1 contains a specific number or proof point; at least 1 ends with a clear CTA sentence.
7. Display path: two segments, each ≤ 15 chars, lowercase, hyphenated; reflect the theme's resolved offer (e.g. `/free-guide/<topic>` for a cold-resolved theme, `/get-quote/<topic>` for a scalding one).
8. Notes line, keyed to the theme's resolved temperature: cold (Informational offer) = soft lead magnet, no urgency/RLSA · warm (Navigational) = destination match + any retargeting · hot (Commercial) = FOMO mechanic + any RLSA segment · scalding (Transactional) = explicit CTA + any RLSA/area-code call extension.

### Ad Copy — Eight Principles (binding)

Each theme has ONE resolved temperature — the tier its `> Offer:` came from (Informational=cold, Navigational=warm, Commercial=hot, Transactional=scalding). Write that theme's whole ad set to that one temperature; the gradient below tells you how hard to push at each.

1. **Match copy to the theme's resolved temperature.** Write the ad set as if the searcher is exactly at that stage and no further — don't mix a cold theme's soft copy with a scalding CTA.
2. **Match the offer to the temperature.** cold = low-threat (cheatsheet/calculator/guide); warm = medium (template/demo/comparison); hot = higher (instant quote/free trial/scheduled demo); scalding = high (call now/buy now/signup). The `> Offer:` must be reachable from the ad's destination page.
3. **Use specific, verifiable numbers.** Exact/odd numbers beat rounded (`$47/mo`, `17 minutes`, `163%`). Pull from the source idea; never fabricate.
4. **Hyper-local.** For local/location-influenced buyers, put the location in the headline AND display path; for phone verticals, match the call-extension area code.
5. **FOMO / urgency.** Manufacture credible urgency only on hot/scalding-resolved themes ("Ends Sunday", "47 left"); never scarcity the landing page can't back. Cold/warm themes use curiosity and value.
6. **Explicit, action-oriented CTA.** Direct verbs on hot/scalding themes; softer verbs ("See", "Learn") allowed only on a cold theme.
7. **Dynamic keyword insertion.** On hot/scalding themes, ≥1 headline uses `{KeyWord:<fallback>}` so the ad mirrors the query; combine with location tokens where applicable.
8. **RLSA / retargeting awareness.** In Notes, call out RLSA-targeted sets and the segment (cart-abandon, pricing-viewer, demo-no-show); for those, include one returning-visitor-incentive headline.

### Ad Copy — Execution Steps

A1. Read back the `### Keyword Themes` block you wrote. For each non-spend-trap theme lift its `> Offer:` line (used verbatim as the RSA's `> Offer:`), its resolved temperature (the tier that offer came from — sets how hard to push), and its member keywords (the concept to carry across ≥3 headlines). Skip `[spend-trap]` themes entirely.
A2. Extract the idea's category, buyer, key promises, pricing, timelines, and proof points from the processed file for numbers and claims.
A3. Generate one RSA ad set per non-spend-trap theme per the Output Contract and Eight Principles, in `### Keyword Themes` order. Each ad set's temperature is the theme's resolved tier (Informational=cold, Navigational=warm, Commercial=hot, Transactional=scalding) — there is no fixed Cold/Warm/Hot/Scalding quartet any more; a campaign may have, say, two hot themes and one warm.
A4. Self-check every headline (≤30 chars), every description (≤90 chars), every display-path segment (≤15 chars). Rewrite any over-limit line before writing.
A5. Self-check per-theme minimums: 15 unique headlines, 4 unique descriptions, ≥2 numbers, ≥1 CTA verb, keyword-in-≥3-headlines, dynamic insertion when the theme is hot/scalding, no shared opening-3-words, no pins.
A6. Append `### Ad Copy` after `### Keyword Themes` (replace it if it already exists); preserve `### Keywords`, `### Keyword Themes`, and everything else exactly.
A7. Re-read the file and verify: exactly one `## Go To Market`; exactly one each of `### Keywords`, `### Keyword Themes`, `### Ad Copy`; **one `#### <Theme>` Ad Copy subsection per non-spend-trap theme, names and order matching `### Keyword Themes`**; each with one `> Offer:` line equal to that theme's, exactly 15 headlines, exactly 4 descriptions, one display path, one notes line.
A8. Return the single combined status line: `Updated <processed-path>: <informational_count>/<navigational_count>/<commercial_count>/<transactional_count> keywords (I/N/C/T) [<decorated_count> Keyword Planner, <dropped_count> dropped, <negative_count> negatives] + <theme_count> themes (<adgroup_count> ad groups, <spendtrap_count> spend-trap) + Ad Copy: <adgroup_count> RSAs, <total_headlines> headlines, <total_descriptions> descriptions (<dki_count> dynamic insertion, <loc_count> location tokens).`

## CLI Prerequisites

The Keyword Planner CLI (`ads.sh keyword-ideas`) uses the same Google Ads credentials and `GOOGLE_ADS_CUSTOMER_ID` (or `--customer-id`) as the rest of the `/adkit *` lifecycle — see **`reference/conventions.md`** for invocation, customer-id resolution, and credentials. If credentials are missing the CLI exits non-zero with the SDK's verbatim error; surface it to the operator and do not modify the file.
