---
description: "Build the full Go-To-Market block for a processed idea: Keyword Planner-decorated keyword tiers (volume/competition/CPC) PLUS a tier-matched Responsive Search Ad set (15 headlines / 4 descriptions) per tier. Reads raw, writes processed under Go To Market > Keywords + Ad Copy. (Merged ads:keywords + idea:adcopy.)"
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

You are a focused Go-To-Market command for processed idea files. You run in **two phases against one file**: first keyword research (the `### Keywords` block), then Responsive Search Ad copy matched to those tiers (the `### Ad Copy` block). Both land under a single `## Go To Market` section.

Your job is to append practical search keywords to one existing markdown file for downstream landing-page and marketing use, then generate ready-to-paste RSA copy whose offer and message match each keyword tier's buying-cycle temperature.

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
2. Append or replace one section named exactly:
   - `## Go To Market`
   - `### Keywords`
3. Under `### Keywords`, create these subsections in this order:
   - `#### Informational` (cold — early curiosity)
   - `#### Navigational` (warm — looking for a specific destination)
   - `#### Commercial` (hot — comparing options)
   - `#### Transactional` (scalding — ready to act)
   - `#### Dropped (off-topic)` — phrases the LLM filtered for being unrelated to this idea (see Step 9 below). Each bullet: `- <bullet_text> — reason: <one short phrase>`. Omit the subsection entirely if nothing was dropped.
   - `#### Negative Keywords` — phrases to **block** as campaign negatives so paid traffic (and AI Max / broad-match expansion) stays on-theme (see Step 9b below). Each bullet: `- <phrase> — reason: <one short phrase>`. `ads:create` auto-seeds these into `campaign.negativeKeywords`. Always emit at least 8.
4. Each subsection must begin with a single one-line `> Default offer:` blockquote stating the recommended CTA / offer for that tier (see Offer Matching below). No other explanatory paragraphs.
5. Each subsection then lists keyword bullets. Use 8-16 bullets per subsection unless the source is too thin; never use fewer than 5 per subsection.
6. Each bullet uses the format: `- keyword phrase` by default. If the keyword's intent diverges from its tier default (a multi-intent keyword), append ` — offer: <recommended offer>` to that bullet only. Do not append the offer to bullets that match the tier default.
7. Keep keywords buyer-search realistic, specific, and useful for content, landing pages, and paid search.
8. Preserve the rest of the file exactly except for the `## Go To Market` keyword section update.
9. Return a concise status line with the modified file path and keyword counts.

## Keyword Research Guidance

0. **Qualify by buyer intent before topical relevance — this screen runs first.** A phrase can be perfectly on-vertical yet bring traffic that will never convert for a *paid* product. The classic trap: **free-intent / DIY-seeker modifiers** (`free`, `free download`, `template`, `theme`, `ppt`, `clipart`, `examples`, `sample`) when the product is paid software. They look relevant — they're in the category — but the searcher wants a free download, not a subscription, so they click, cost money, and never buy (this is exactly how an agency pitch-deck tool burned spend on `free powerpoints templates`, `slideshow template free`, `ppt slides`, `swot presentation template` with zero conversions). Before tiering, ask **"does this searcher want the transaction the product needs?"** — if the product is paid, treat zero-budget freebie queries like off-topic: drop them (with a reason) or, when borderline, tag them off-theme so they never lead a tier. If the product is lead-gen / free-tier, soften this. When such a phrase is dropped, its free-intent modifier becomes a valid negative (step 9b) — the "never negate a word that's in a kept keyword" rule only protects words you actually kept.
1. Use the source markdown as the primary product and audience context.
2. Use optional idea notes to refine the keyword universe, especially when they contain examples, positioning, or category language.
3. When available, use current search or web research to validate phrasing, adjacent terms, competitor/category modifiers, and common buyer language.
4. Include root keyword variations, long-tail variants, pain/problem queries, solution/category terms, and comparison terms.
5. Avoid stuffing near-duplicates that differ only by punctuation or word order.
6. Avoid brand names unless the source clearly names the brand or the keyword is navigational for the idea itself.
7. Prefer plain buyer language over internal jargon.

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
2. If the file does not have `## Go To Market`, append it to the end of the file.
3. Preserve any other existing `## Go To Market` subsections.
4. Keep a single blank line between headings, the `> Default offer:` line, and the bullet list.
5. Bullet format:
   - Tier-default intent: `- keyword phrase`
   - Divergent / multi-intent: `- keyword phrase — offer: <recommended offer>`

## Execution Steps

1. Parse `$ARGUMENTS`. Extract the raw markdown file path (under `ideas/raw/`). Extract optional `--geo <value>` and `--language <value>` tokens (treat as paired). Remaining text is idea notes.
2. Validate the raw markdown file exists.
3. Compute the **processed** output path: replace `ideas/raw/` with `ideas/processed/` in the input path. If the processed file does not exist, create it with minimal frontmatter (`---\nsource_file: <raw path>\n---`) so subsequent edits attach somewhere stable.
4. Read the full raw markdown file (and any existing processed file for context — operator edits to keywords are still discarded when the section is rewritten).
5. **Anchor on the idea's core theme, then brainstorm seeds.** First extract 3–6 *core theme tokens* from the raw idea — its differentiator, primary audience, and the specific channels/jobs it names (for a brand-voice reply tool: `brand voice`, `replies`, `reviews`, `comments`, `social`, `DTC`). These tokens are the relevance yardstick reused in steps 9 and 11; record them. Then brainstorm an initial candidate list (`seeds`) from the raw idea + optional notes + theme tokens, using the Keyword Research Guidance and Intent Definitions above. **Seeds must combine the category with the differentiator and audience** (`brand voice reply tool`, `reply to reviews ai`, `social comment response`) — do NOT seed bare category stems alone (`chatbot`, `ai writing tool`); Keyword Planner expands bare stems into generic consumer noise that drowns the on-theme niche.
6. Extract the first `https?://` URL found in either the raw or processed file. If none, leave it empty.
7. Invoke the Keyword Planner CLI to decorate and expand the candidate set:
   ```bash
   .claude/commands/ads/scripts/ads.sh keyword-ideas \
     [--page-url <url>] \
     [--geo <value>] \
     [--language <value>] \
     --seed "<kw1>" --seed "<kw2>" ...
   ```
   - Omit `--page-url` when no URL was extracted (the CLI emits a stderr note and proceeds with `keyword_seed` only — spec FR-018).
   - Omit `--geo` / `--language` flags entirely when not present in `$ARGUMENTS` (CLI defaults to US/English — spec FR-006).
   - On non-zero exit: surface the CLI's stderr verbatim, stop without modifying the file (spec FR-009).
8. Parse the CLI's stdout JSON array of candidates. Every element is backed by Keyword Planner data (avg monthly searches ≥ 1,000); bare/undecorated seeds are not emitted. Each element has `phrase`, a pre-built decorated `bullet_text`, plus raw metric fields. **You MUST copy `bullet_text` verbatim into each bullet — do not regenerate the `(volume, competition, $L–$H)` decoration string (spec FR-017).**
9. **Buyer-intent + relevance filter + on-theme tag**: In one pass, judge each candidate's `phrase` against the raw idea content (the product, audience, vertical you read in step 4), the core theme tokens from step 5, and the **buyer-intent screen (guidance item 0)**. Three outcomes:
   - **Drop (wrong buyer)** — on-vertical phrases whose searcher won't make the transaction this product needs: for a *paid* product, free-intent / DIY-seeker queries (`free …`, `… template`, `… ppt`, `… download`, `… examples`) that hunt a freebie, not a purchase. Record them for `#### Dropped (off-topic)` with a reason like `free-seeker, not a buyer`. Skip or soften this when the product is genuinely free / lead-gen.
   - **Drop (off-vertical)** phrases that are off-topic for the *vertical* — a different vertical (e.g., home automation hits on `josh ai`/`control4`/`lutron` when the product is agency software), an adjacent industry (e.g., `crm for real estate agents`), or generic stem noise that matches no theme token AND carries no buyer intent for this product. Record dropped phrases (with `bullet_text` + a 2–6 word reason) for the `#### Dropped (off-topic)` subsection.
   - **Tag as off-theme** (keep, but mark) the on-vertical-but-off-positioning phrases — generic category terms that carry NONE of the core theme tokens yet are still plausible paid targets (e.g., bare `ai writing tool` / `ai powered chatbot` for a brand-voice reply tool). They stay for targeting but must NOT lead a tier (step 11). A phrase containing ≥1 core theme token is **on-theme**.
   Do NOT drop borderline-relevant phrases — keep them; the on-theme tag, not deletion, is what stops generic terms from defining the ad.
9b. **Generate negative keywords.** Build a list of ≥8 phrases to block as campaign negatives, so paid traffic (and AI Max / broad-match expansion) stays on-theme. Draw from three sources:
   - **The dropped phrases (step 9)** — the off-vertical / wrong-buyer terms are natural negatives (e.g. for an agency pitch tool: `marketing agency near me`, `seo`, the `mtg`/Magic-the-Gathering "deck" homonym).
   - **Generic intent-mismatch modifiers** the idea does not serve — common B2B blockers like `jobs`, `salary`, `course`, `tutorial`, `meaning`, `definition`, `reddit`, `free download`, `near me`, `hire`, `internship`, plus any modifier that signals the wrong buyer/intent for this specific product.
   - **Cannibalization guards** — single words that, if left to broad/close-variant matching, would pull clearly-wrong queries given the vertical (homonyms, adjacent industries).
   Each negative is a short phrase (PHRASE match is assumed downstream). **Do NOT negate any word that appears in a kept keyword** (e.g. never negate `template` if a template term is a live keyword) — that would suppress your own traffic. Prefer multi-word phrases over single broad tokens when a single token risks over-blocking.
10. Assign each surviving candidate to **exactly one** of the four intent tiers (Informational / Navigational / Commercial / Transactional) per the Intent Definitions, classifying by true buying-cycle temperature. **This tier assignment IS the STAG (Single Theme Ad Group) grouping** — downstream `ads:create` turns each tier into one ad group verbatim and makes no grouping decision of its own. So the grouping intelligence lives *here*: a keyword must appear in only one tier (never repeated across tiers), and the keywords you place in a tier must read as one coherent theme that can share a single ad message.
11. Within each tier, order bullets **on-theme first, then by `volume` descending** with alphabetical tie-break (on-theme = carries ≥1 core theme token per step 9; off-theme terms sink below every on-theme one and are the first truncated by step 12's cap). This keeps the idea's positioning at the top of each tier, which is exactly what downstream `ads:create` reads when it groups each tier into a Single Theme Ad Group (STAG). (Amends the volume-only ordering of spec FR-016 — see the plan note.)
12. Cap each tier at 8–16 bullets; truncate the tail if more were classified there. If a tier has fewer than 5, redistribute / relax (existing keyword guidance).
13. For each tier, write the `> Default offer:` line that matches the tier's typical temperature for this idea's category and buyer.
14. Render each bullet as `- <bullet_text>` (using the verbatim CLI-provided string). For any candidate whose true temperature diverges from its tier default, append ` — offer: <recommended offer>` to that bullet (the offer suffix comes AFTER the decoration on the same line — spec FR-004).
15. If any phrases were dropped in step 9, append a `#### Dropped (off-topic)` subsection AFTER `#### Transactional`. Each bullet: `- <bullet_text> — reason: <2–6 word reason>`. Omit the subsection entirely if nothing was dropped.
15b. Append a `#### Negative Keywords` subsection LAST (after `#### Dropped (off-topic)`). Each bullet: `- <phrase> — reason: <2–6 word reason>`, using the step-9b list. Plain phrases only — **no** `(volume, …)` decoration (these are not Keyword Planner candidates). Always emit at least 8.
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
18. Keyword phase done. Record the four tier `> Default offer:` lines and each tier's keyword themes — the Ad Copy phase consumes them. **Do NOT return yet**; proceed to the Ad Copy phase below and emit a single combined status line at the end.

---

## Ad Copy Phase (runs after the Keyword phase, same file)

After `### Keywords` is written, generate one Responsive Search Ad set per tier and append it as `### Ad Copy`. You write the way a working PPC team writes: copy aligned to funnel stage, offer matched to the visitor's temperature, claims backed by specific numbers, location and dynamic-keyword tokens used where they pay off, explicit CTAs. The `### Keywords` block you just wrote is the source of truth — the ad copy MUST align to its tiers and `> Default offer:` lines.

### Ad Copy — Output Contract

1. Append or replace one subsection named exactly `### Ad Copy` under the same `## Go To Market` section, AFTER `### Keywords`.
2. Under `### Ad Copy`, create exactly four subsections in this order, mirroring the keyword tiers:
   - `#### Cold (Informational)`
   - `#### Warm (Navigational)`
   - `#### Hot (Commercial)`
   - `#### Scalding (Transactional)`
3. Each subsection begins with a single one-line `> Offer:` blockquote that MUST match the corresponding tier's `> Default offer:` from `### Keywords`.
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
   - Exactly **15** unique headlines per tier (matches `/ads:create`'s Excellent-strength requirement so the copy is publish-ready).
   - Each headline ≤ 30 characters (spaces and punctuation count).
   - Cover distinct *angles* across the 15 — value prop, feature, social proof, urgency, offer/free, pricing, audience callout, objection, brand — not reworded twins.
   - Put the tier's main keyword concept in **≥3** headlines (Google rewards keyword inclusion); use the shared concept, not every literal phrase.
   - At least 2 headlines contain a specific verifiable number (odd numbers preferred when plausible; never invent stats — pull from the source idea's pricing/timelines/capacity/proof).
   - At least 1 headline contains an explicit CTA verb (Get, Start, Book, Claim, Try, Save, Compare, Download, Call).
   - At least 1 headline includes a location token `{LOCATION(City)}` or `[City]` when the buyer is local/location-influenced.
   - At Hot and Scalding tiers, at least 1 headline uses dynamic keyword insertion `{KeyWord:<fallback>}` (fallback reads naturally, ≤ 25 chars).
   - No two headlines share the same opening 3 words. **Never pin** — assets must combine freely.
6. Description rules:
   - Exactly **4** unique descriptions per tier. Each ≤ 90 characters.
   - Different angles: offer, problem-solution, trust signal, CTA.
   - At least 1 contains a specific number or proof point; at least 1 ends with a clear CTA sentence.
7. Display path: two segments, each ≤ 15 chars, lowercase, hyphenated; reflect the tier offer (e.g. `/free-guide/<topic>` Cold, `/get-quote/<topic>` Scalding).
8. Notes line: Cold = soft lead magnet, no urgency/RLSA · Warm = destination match + any retargeting · Hot = FOMO mechanic + any RLSA segment · Scalding = explicit CTA + any RLSA/area-code call extension.

### Ad Copy — Eight Principles (binding)

1. **Match copy to the funnel stage.** Write each tier as if the searcher is exactly at that stage and no further.
2. **Match the offer to the temperature.** Cold = low-threat (cheatsheet/calculator/guide); Warm = medium (template/demo/comparison); Hot = higher (instant quote/free trial/scheduled demo); Scalding = high (call now/buy now/signup). The `> Offer:` must be reachable from the ad's destination page.
3. **Use specific, verifiable numbers.** Exact/odd numbers beat rounded (`$47/mo`, `17 minutes`, `163%`). Pull from the source idea; never fabricate.
4. **Hyper-local.** For local/location-influenced buyers, put the location in the headline AND display path; for phone verticals, match the call-extension area code.
5. **FOMO / urgency.** Manufacture credible urgency at Hot/Scalding only ("Ends Sunday", "47 left"); never scarcity the landing page can't back. Cold/Warm use curiosity and value.
6. **Explicit, action-oriented CTA.** Direct verbs at Hot/Scalding; softer verbs ("See", "Learn") allowed only at Cold.
7. **Dynamic keyword insertion.** At Hot/Scalding, ≥1 headline uses `{KeyWord:<fallback>}` so the ad mirrors the query; combine with location tokens where applicable.
8. **RLSA / retargeting awareness.** In Notes, call out RLSA-targeted sets and the segment (cart-abandon, pricing-viewer, demo-no-show); for those, include one returning-visitor-incentive headline.

### Ad Copy — Execution Steps

A1. Read back the `### Keywords` block you wrote. For each tier lift its `> Default offer:` line (basis for `> Offer:`) and its top on-theme keyword themes (the concept to carry across ≥3 headlines).
A2. Extract the idea's category, buyer, key promises, pricing, timelines, and proof points from the processed file for numbers and claims.
A3. Generate one RSA ad set per tier per the Output Contract and Eight Principles. Map tiers: Informational→Cold, Navigational→Warm, Commercial→Hot, Transactional→Scalding.
A4. Self-check every headline (≤30 chars), every description (≤90 chars), every display-path segment (≤15 chars). Rewrite any over-limit line before writing.
A5. Self-check per-tier minimums: 15 unique headlines, 4 unique descriptions, ≥2 numbers, ≥1 CTA verb, keyword-in-≥3-headlines, dynamic insertion at Hot/Scalding, no shared opening-3-words, no pins.
A6. Append `### Ad Copy` after `### Keywords` (replace it if it already exists); preserve `### Keywords` and everything else exactly.
A7. Re-read the file and verify: exactly one `## Go To Market`; exactly one `### Keywords` and one `### Ad Copy`; all four Ad Copy tier subsections in order; each with one `> Offer:` line, exactly 15 headlines, exactly 4 descriptions, one display path, one notes line.
A8. Return the single combined status line: `Updated <processed-path>: <informational_count>/<navigational_count>/<commercial_count>/<transactional_count> keywords (I/N/C/T) [<decorated_count> Keyword Planner, <dropped_count> dropped, <negative_count> negatives] + Ad Copy: 4 tiers, <total_headlines> headlines, <total_descriptions> descriptions (<dki_count> dynamic insertion, <loc_count> location tokens).`

## CLI Prerequisites

The Keyword Planner CLI (`ads.sh keyword-ideas`) uses the same Google Ads credentials and `GOOGLE_ADS_CUSTOMER_ID` (or `--customer-id`) as the rest of the `/ads:*` lifecycle — see **`reference/conventions.md`** for invocation, customer-id resolution, and credentials. If credentials are missing the CLI exits non-zero with the SDK's verbatim error; surface it to the operator and do not modify the file.
