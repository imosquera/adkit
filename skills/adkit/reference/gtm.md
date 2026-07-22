---
description: "Build the full Go-To-Market block for a processed idea: Keyword Planner-decorated keywords (volume/competition/CPC), a semantic Keyword Themes grouping (the ad-group source of truth for /adkit create), PLUS a theme-matched Responsive Search Ad set (15 headlines / 4 descriptions) per theme. Reads raw, writes processed under Go To Market > Keywords + Keyword Themes + Ad Copy. (Merged ads:keywords + idea:adcopy.)"
argument-hint: "ideas/raw/<file>.md | ideas/processed/<file>.md [--geo geoTargetConstants/N] [--language languageConstants/N] [optional idea notes]"
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

**The `### Keyword Themes` section is the single ad-group *and* offer source of truth** — `/adkit create` parses it and makes one ad group per non-spend-trap theme. `### Keywords` is a flat, kept keyword list (with volume/competition/CPC decoration); it carries no separate intent-tier classification.

**Before proceeding, read:**
- [`reference/google/2-keyword-mining.md`](google/2-keyword-mining.md) — theme relevance, screening criteria, grouping rules
- [`reference/google/4-ad-copy.md`](google/4-ad-copy.md) — headline pools, pinning strategy, asset checklist

You also judge each theme's buying-cycle temperature directly from its member keywords and recommend an offer / CTA whose threat level matches that temperature, so the landing page does not ask for too much (or too little) given where the visitor actually is in their buying cycle.

## Input Contract

1. `$ARGUMENTS` is required.
2. Parse the first path-like token from `$ARGUMENTS` as the input idea markdown file, preserving quoted paths with spaces. It may be a **raw** file (`ideas/raw/<name>.md`) or an already-**processed** file (`ideas/processed/<name>.md`) — accept either.
3. The file must exist, must be a markdown file (`.md` or `.markdown`), and MUST resolve under `ideas/raw/` **or** `ideas/processed/` relative to the current working directory (this worktree). Do NOT look in sibling worktrees, the main checkout, or any other path outside this worktree.
4. Determine the **source** and **output** paths from the input:
   - If the input is under `ideas/raw/`, the source is that raw file and the **output** is the same name under `ideas/processed/` (swap `ideas/raw/` → `ideas/processed/`). Example: `ideas/raw/inventive.md` → output `ideas/processed/inventive.md`. If the processed file does not exist yet, create it with a minimal frontmatter + the keywords section (the rest of the processed idea is the job of `/idea:process`).
   - If the input is **already** under `ideas/processed/`, the source and output are that same file — read it in place for context and write the Go To Market sections back into it. Do NOT require or fabricate a raw stub; the processed file already carries the full context.
5. Treat all remaining `$ARGUMENTS` text as optional idea notes. If optional idea notes are present, use them as additional context alongside the input markdown file content.
6. If no valid idea markdown file is provided, return: `Error: Provide a valid idea markdown file path under this worktree's ideas/raw/ or ideas/processed/ directory, for example ideas/raw/example.md or ideas/processed/example.md.`

## Output Contract

1. Modify only the provided markdown file.
2. Append or replace, under a single `## Go To Market` section, these three subsections in order:
   - `### Keywords` — the flat kept-keyword list + Dropped + Negative Keywords (this section).
   - `### Keyword Themes` — the 3–6 semantic themes that become ad groups (see the Keyword Themes Contract below).
   - `### Ad Copy` — one RSA set per theme (see the Ad Copy Phase).
3. Under `### Keywords`, list every kept keyword as a flat bullet list (**omit the section body entirely if the Keyword Planner returned zero kept keywords** — see the thin-source rule in #5; do not invent keywords to fill it), followed by:
   - `#### Dropped (off-topic)` — phrases the LLM filtered for being unrelated to this idea (see Step 9 below). Each bullet: `- <bullet_text> — reason: <one short phrase>`. Omit the subsection entirely if nothing was dropped.
   - `#### Negative Keywords` — phrases to **block** as campaign negatives so paid traffic (and AI Max / broad-match expansion) stays on-theme (see Step 9b below). Each bullet: `- <phrase> — reason: <one short phrase>`. `ads:create` auto-seeds these into `campaign.negativeKeywords`. Always emit at least 8.
4. `### Keywords` itself carries no offer annotation — offer resolution happens once, per theme, in `### Keyword Themes` (see the Keyword Themes Contract below).
5. **Aim for ~100 keywords total to start** when the source can support it — a campaign wants ~25+ keywords to compete (what `ads:audit` flags as `keywords_under`), and starting near 100 gives real reach and room to prune to the winners. **The real floor is the kept set the Keyword Planner actually returned, not a fixed count.** Every keyword must be a Keyword-Planner-returned candidate that survived screening (steps 8–9) — so **do not fabricate keywords, split near-duplicates, or hand-add zero-volume phrasings to hit ~100** (that violates step 8 and Keyword Research Guidance item 8). A genuinely thin, single-intent niche legitimately yields far fewer keywords — write exactly what the kept set supports.
6. Each bullet uses the format: `- keyword phrase` (using the verbatim `bullet_text` from step 8 — no per-keyword offer annotation; offers live only on themes).
7. Keep keywords buyer-search realistic, specific, and useful for content, landing pages, and paid search.
8. Preserve the rest of the file exactly except for the `## Go To Market` keyword section update.
9. Return a concise status line with the modified file path and keyword counts.

## Keyword Themes Contract (the ad-group source of truth)

`### Keyword Themes` is written to the file (not screen-only) and is what `/adkit create` parses to build ad groups — **one ad group per non-spend-trap theme**. Author it per Execution Step 15c. Shape:

1. One subsection named exactly `### Keyword Themes`, placed AFTER `### Keywords` and BEFORE `### Ad Copy`.
2. It opens with a one-line `> ` note, then **3–6** themes (aim for 3–6; **never more than 10** — `/adkit create` keeps only the first 10), ordered **highest-potential-volume theme first** (sum each theme's member-keyword volumes from `### Keywords`; the lead ad-group-split theme is usually #1). Ordering matters: the scaffold keeps the *top 10 by this order*, so a weak theme must sink to the bottom. Each theme is an h4: 
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
5. **`> Offer:` line** (non-spend-trap themes only): exactly one, directly under the h4. It is the theme's **resolved offer** — judged directly from the theme's member keywords and their collective buying-cycle temperature (see Buying-Cycle Temperature & Offer Matching below), not looked up from a separate per-keyword tier. This single line is what the Ad Copy Phase reads for that theme's RSA — no re-derivation from `### Keywords`.
6. **Keyword bullets**: bare phrases (no `(volume, …)` decoration needed — decoration lives in `### Keywords`), one per line. Every theme keyword MUST also appear in the kept `### Keywords` list (the themes are a re-grouping of the kept set, not a new keyword source). A keyword appears in **exactly one** theme (no cross-theme duplication — that would cannibalize across ad groups).

## Keyword Research Guidance

0. **Qualify by buyer intent before topical relevance — this screen runs first.** A phrase can be perfectly on-vertical yet bring traffic that will never convert for a *paid* product. The classic trap: **free-intent / DIY-seeker modifiers** (`free`, `free download`, `template`, `theme`, `ppt`, `clipart`, `examples`, `sample`) when the product is paid software. They look relevant — they're in the category — but the searcher wants a free download, not a subscription, so they click, cost money, and never buy (this is exactly how an agency pitch-deck tool burned spend on `free powerpoints templates`, `slideshow template free`, `ppt slides`, `swot presentation template` with zero conversions). Before screening further, ask **"does this searcher want the transaction the product needs?"** — if the product is paid, treat zero-budget freebie queries like off-topic: drop them (with a reason) or, when borderline, tag them off-theme so they never lead a theme. If the product is lead-gen / free-tier, soften this. When such a phrase is dropped, its free-intent modifier becomes a valid negative (step 9b) — the "never negate a word that's in a kept keyword" rule only protects words you actually kept.
1. Use the source markdown as the primary product and audience context.
2. Use optional idea notes to refine the keyword universe, especially when they contain examples, positioning, or category language.
3. When available, use current search or web research to validate phrasing, adjacent terms, competitor/category modifiers, and common buyer language.
4. Include root keyword variations, long-tail variants, pain/problem queries, solution/category terms, and comparison terms.
5. Avoid stuffing near-duplicates that differ only by punctuation or word order.
6. Avoid brand names unless the source clearly names the brand or the keyword is navigational for the idea itself.
7. Prefer plain buyer language over internal jargon.
8. **Seed the category language buyers actually search; keep the differentiator in the copy.** The highest-volume keywords are the generic *category* language buyers type (`salon booking app`, `best scheduling app for estheticians`), NOT the product's differentiator — a differentiator phrasing like `book by text` typically has ~zero search volume. Seeds may pair the category with the differentiator to *probe* its volume (step 5), but the Keyword Planner only emits phrases at/above its volume floor (step 8), so a zero-volume differentiator phrasing simply never comes back as a candidate. Do not chase or hand-add zero-volume differentiator seeds to the kept keyword set — carry the differentiator in the RSA ad copy (Ad Copy Phase) instead, which is where it converts.

## Buying-Cycle Temperature & Offer Matching

Every theme has exactly one resolved buying-cycle temperature — cold, warm, hot, or
scalding — judged directly from its member keywords, and exactly one `> Offer:` line
that matches that temperature. There is no separate per-keyword tier to look the
temperature up from; read the theme's member keywords as a whole and judge where the
searcher sits in the buying cycle.

**Temperature reference** (four named points along one continuum — judge each
theme's actual position on it; a theme is not required to sit squarely on one label):

- **Cold** — searchers want to learn, troubleshoot, or understand a concept; not ready
  to buy. Examples: `how to structure google ads ad groups`, `what is a single keyword
  ad group`. Offer: low-threat lead magnet — guide, checklist, calculator,
  email-gated resource.
- **Warm** — searchers want a specific product, brand, tool, page, template,
  calculator, guide, or known category destination. Examples: `<brand> pricing`,
  `<category> template`, `<tool> demo`. Offer: route them to the exact thing —
  pricing page, demo video, template download, comparison page.
- **Hot** — searchers are comparing options or evaluating vendors, structures,
  methods, or alternatives before buying. Examples: `best google ads account
  structure`, `single keyword ad groups vs themed ad groups`. Offer: medium-threat
  conversion — book a demo, start free trial, multi-step lead form, instant-quote
  calculator.
- **Scalding** — searchers are ready to act, buy, hire, book, download, start a
  trial, request a demo, or use a tool. Examples: `hire google ads agency`, `download
  google ads keyword template`. Offer: high-threat direct CTA — phone call, instant
  signup, buy now, schedule today.

**Resolving a theme's temperature and offer**: read the theme's member keywords as a
group (not keyword-by-keyword) and judge the *dominant* buying-cycle stage they
collectively represent — the rule is **the offer's threat level must match the
theme's overall buying-cycle temperature, not any single literal keyword.** A theme
that mixes a few colder long-tail phrases with a hot core still resolves to the hot
end if that's what most of its volume/intent represents (e.g. a theme anchored on
`best salon booking software` and `salon scheduling app vs [competitor]` resolves hot
even if it also nets a stray `what is salon booking software`). Apply the source
idea's category, buyer, and product to judge each theme's true temperature, then pick
the offer that converts that temperature without overreaching or underreaching.

Keep recommended offers concrete (a real artifact or action), not abstract ("nurture
content"). Tie them to something the landing page could actually ship.

## Section Update Rules

1. If the file already has `## Go To Market`:
   - If it already contains `### Keywords`, replace only the full `### Keywords` subsection.
   - If it does not contain `### Keywords`, append `### Keywords` to the end of `## Go To Market`.
   - Same rule for `### Keyword Themes` (replace the whole subsection if present) and `### Ad Copy`. Order within `## Go To Market`: `### Keywords`, then `### Keyword Themes`, then `### Ad Copy`.
2. If the file does not have `## Go To Market`, append it to the end of the file.
3. Preserve any other existing `## Go To Market` subsections.
4. Keep a single blank line between headings, the `> Offer:` line, and the bullet list.
5. Bullet format:
   - `### Keywords` kept keyword: `- <bullet_text>` (verbatim decorated string, no offer suffix — offers live only on themes).
   - `### Keyword Themes` keyword bullet: `- keyword phrase` (bare — no decoration or offer suffix).

## Execution Steps

1. Parse `$ARGUMENTS`. Extract the input markdown file path (under `ideas/raw/` **or** `ideas/processed/`). Extract optional `--geo <value>` and `--language <value>` tokens (treat as paired). Remaining text is idea notes.
2. Validate the input markdown file exists.
3. Compute the **processed** output path: if the input is under `ideas/raw/`, replace `ideas/raw/` with `ideas/processed/`; if the input is already under `ideas/processed/`, the output is that same file. If the processed file does not exist, create it with minimal frontmatter (`---\nsource_file: <input path>\n---`) so subsequent edits attach somewhere stable.
4. Read the full input markdown file for context. When the input is a raw file, also read any existing processed file for context. (Operator edits to keywords are still discarded when the section is rewritten.)
5. **Anchor on the idea's core theme, then brainstorm seeds.** First extract 3–6 *core theme tokens* from the raw idea — its differentiator, primary audience, and the specific channels/jobs it names (for a brand-voice reply tool: `brand voice`, `replies`, `reviews`, `comments`, `social`, `DTC`). These tokens are the relevance yardstick reused in steps 9 and 11; record them. Then brainstorm an initial candidate list (`seeds`) from the raw idea + optional notes + theme tokens, using the Keyword Research Guidance and Buying-Cycle Temperature & Offer Matching sections above. **Seeds must combine the category with the differentiator and audience** (`brand voice reply tool`, `reply to reviews ai`, `social comment response`) — do NOT seed bare category stems alone (`chatbot`, `ai writing tool`); Keyword Planner expands bare stems into generic consumer noise that drowns the on-theme niche. (Seeds may pair the differentiator with the category to *probe* its volume, but do not expect zero-volume differentiator phrasings to survive as kept keywords — see Keyword Research Guidance item 8.)
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
   - **Tag as off-theme** (keep, but mark) the on-vertical-but-off-positioning phrases — generic category terms that carry NONE of the core theme tokens yet are still plausible paid targets (e.g., bare `ai writing tool` / `ai powered chatbot` for a brand-voice reply tool). They stay for targeting but must NOT lead a theme (step 11) or a Keyword Theme (step 15c). A phrase containing ≥1 core theme token is **on-theme**.
   Do NOT drop borderline-relevant phrases — keep them; the on-theme tag, not deletion, is what stops generic terms from defining the ad.
9b. **Generate negative keywords.** Build a list of ≥8 phrases to block as campaign negatives, so paid traffic (and AI Max / broad-match expansion) stays on-theme. Draw from three sources:
   - **The dropped phrases (step 9)** — the off-vertical / wrong-buyer terms are natural negatives (e.g. for an agency pitch tool: `marketing agency near me`, `seo`, the `mtg`/Magic-the-Gathering "deck" homonym).
   - **Generic intent-mismatch modifiers** the idea does not serve — common B2B blockers like `jobs`, `salary`, `course`, `tutorial`, `meaning`, `definition`, `reddit`, `free download`, `near me`, `hire`, `internship`, plus any modifier that signals the wrong buyer/intent for this specific product.
   - **Cannibalization guards** — single words that, if left to broad/close-variant matching, would pull clearly-wrong queries given the vertical (homonyms, adjacent industries).
   Each negative is a short phrase (PHRASE match is assumed downstream). **Do NOT negate any word that appears in a keyword you keep in an ad-group theme** — i.e. any keyword in a non-spend-trap `### Keyword Themes` theme (e.g. never negate `template` if a template term leads a live ad group) — that would suppress your own traffic. This guard does **not** protect spend-trap-theme terms: those are excluded from ad groups (step 15c), so they are no longer live keywords and are safe — indeed expected — to negate (see the next bullet). Prefer multi-word phrases over single broad tokens when a single token risks over-blocking.
   - **Seed the spend-trap theme's terms as negatives.** The generic `[spend-trap]` theme from step 15c gets no ad group, so its member phrases become negatives here. This is also the cluster `/adkit audit` most often flags as zero-conversion waste on a live campaign — in a real run those generic terms mapped ~1:1 to the wasted spend the audit surfaced. Because the theme is excluded from ad groups, negating its terms no longer contradicts the guard above.
10. Every surviving candidate (on-theme or tagged off-theme) is simply a kept keyword in the flat `### Keywords` list — buying-cycle temperature judgment happens once, per theme, at step 15c, not per keyword here.
11. Order the flat `### Keywords` bullet list **on-theme first, then by `volume` descending** with alphabetical tie-break (on-theme = carries ≥1 core theme token per step 9; off-theme terms sink below every on-theme one). This keeps the idea's positioning at the top of the list for readability and makes the highest-intent on-theme keywords easy to pull into themes at step 15c. (Amends the volume-only ordering of spec FR-016 — see the plan note.)
12. Cap the kept list at ~100 bullets total per the target in the Output Contract; truncate the tail if more survived screening. A thin source is fine — write only what genuinely survived screening and never fabricate phrases to pad the count.
13. Render each bullet as `- <bullet_text>` (using the verbatim CLI-provided string, no offer suffix — offers are resolved only on themes at step 15c).
14. If any phrases were dropped in step 9, append a `#### Dropped (off-topic)` subsection AFTER the kept keyword list. Each bullet: `- <bullet_text> — reason: <2–6 word reason>`. Omit the subsection entirely if nothing was dropped.
14b. Append a `#### Negative Keywords` subsection LAST (after `#### Dropped (off-topic)`). Each bullet: `- <phrase> — reason: <2–6 word reason>`, using the step-9b list. Plain phrases only — **no** `(volume, …)` decoration (these are not Keyword Planner candidates). Always emit at least 8.
15c. **Keyword Themes — WRITE the `### Keyword Themes` section (the ad-group and offer source of truth).** Cluster the **kept** keywords into **3–6 semantic themes** and write them to the file in the shape defined by the *Keyword Themes Contract* above. `/adkit create` parses this section and makes one ad group per non-spend-trap theme, so this is where the STAG grouping — and the offer resolution — now lives.
   - **Cluster from the deterministic prior.** Each candidate carries a `concept_group` (step 8) — Google's own semantic grouping. Group the kept keywords by `concept_group` first, then merge, rename, and split those raw groups into 3–6 operator-facing themes (a `null` concept_group → use your own judgment for that keyword). This anchors themes to real Keyword Planner data instead of clustering from scratch, so the grouping is stable run-to-run and not invented. Themes are **orthogonal to** the on-theme/off-theme tag from step 9 — a single theme can mix on-theme and off-theme keywords.
   - **Order themes by potential volume, cap at 10.** Write the themes highest-total-volume first (sum each theme's member-keyword volumes from `### Keywords`). Aim for 3–6; if you ever author more, keep it to **≤10** — `/adkit create` builds at most 10 ad groups and keeps the *first 10* in file order, so the highest-volume themes must come first. Keep each theme to **≤30 keywords** (the per-ad-group schema cap; the scaffold's default packs 25) — if a theme would exceed that, split it or let its lowest-volume tail fall out.
   - **Every theme keyword must come from the kept `### Keywords` set** (themes re-group the kept keywords; they do not introduce new phrases), and each kept keyword lands in **exactly one** theme (no cross-theme duplication — that cannibalizes across ad groups).
   - **Resolve each theme's `> Offer:`.** For each non-spend-trap theme, read its member keywords as a group and judge the buying-cycle temperature they collectively represent per Buying-Cycle Temperature & Offer Matching above, then write that temperature's matching offer as the theme's single `> Offer:` line. Rationale: AI Max expands past the literal keyword list, so biasing the offer toward the theme's hottest represented intent doesn't strand the colder long-tail; and one ad group needs one coherent offer. The Ad Copy Phase reads this line directly.
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
16. Update the **processed** file (computed in step 3) according to Section Update Rules. A raw input file is never modified; when the input *is* the processed file, edits are written back into it in place.
17. Re-read the processed file and verify:
   - exactly one `## Go To Market` section exists,
   - exactly one `### Keywords` subsection exists, with a flat kept-keyword list (no intent-tier subsections),
   - **no keyword was padded**: every keyword bullet traces to a Keyword-Planner-returned candidate (verbatim `bullet_text`), with no fabricated or near-duplicate phrases added to reach a count,
   - the optional `#### Dropped (off-topic)` subsection, if present, comes before Negative Keywords,
   - a `#### Negative Keywords` subsection exists LAST with ≥8 plain-phrase bullets (no volume decoration),
   - no `### Keywords` bullet carries an `— offer:` suffix (offers are theme-level only, written in `### Keyword Themes`).
   - **`### Keyword Themes`** exists (after `### Keywords`) with **3–10** `####` themes (aim 3–6; hard cap 10), ordered highest-potential-volume first; **≥1** is NOT `[spend-trap]`; each non-spend-trap theme has exactly one `> Offer:` line, ≥1 keyword bullet, and **≤30** keywords.
   - **Theme↔keywords consistency**: every theme keyword also appears in the kept `### Keywords` list (themes re-group the kept set; no new phrases), and **no keyword appears in two themes** (cross-theme duplication cannibalizes ad groups — fix by moving it to one theme).
   - **Spend-trap → negatives**: every keyword under a `[spend-trap]` theme also appears in `#### Negative Keywords`.
18. Keyword phase done. Record each theme's name and its resolved `> Offer:` line — the Ad Copy phase generates one RSA per theme from them. **Do NOT return yet**; proceed to the Ad Copy phase below and emit a single combined status line at the end.

---

## Ad Copy Phase (runs after the Keyword phase, same file)

After `### Keyword Themes` is written, generate **one Responsive Search Ad set per non-spend-trap theme** and append them as `### Ad Copy`. You write the way a working PPC team writes: copy aligned to the theme's resolved temperature, offer matched to that temperature, claims backed by specific numbers, location and dynamic-keyword tokens used where they pay off, explicit CTAs. The `### Keyword Themes` block you just wrote is the source of truth — one RSA per theme, in the same order, each carrying that theme's `> Offer:` and its own keywords. (A `[spend-trap]` theme gets **no** ad group and therefore **no** RSA — skip it.)

### Ad Copy — Output Contract

1. Append or replace one subsection named exactly `### Ad Copy` under the same `## Go To Market` section, AFTER `### Keyword Themes`.
2. Under `### Ad Copy`, create **one subsection per non-spend-trap theme, in `### Keyword Themes` order**, each named `#### <Theme Name>` — the same theme name as its h4 in `### Keyword Themes` (so the RSA maps 1:1 to the ad group `/adkit create` builds). The number of subsections equals the number of ad groups (the non-spend-trap themes, at most 10).
3. Each subsection begins with a single one-line `> Offer:` blockquote that MUST equal that theme's `> Offer:` from `### Keyword Themes` (resolved per Buying-Cycle Temperature & Offer Matching in the Keyword phase). This one offer sets the whole ad set's temperature.
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
   - When the theme's resolved temperature is **hot or scalding**, at least 1 headline uses dynamic keyword insertion `{KeyWord:<fallback>}` (fallback reads naturally, ≤ 25 chars).
   - No two headlines share the same opening 3 words. **Never pin** — assets must combine freely.
6. Description rules:
   - Exactly **4** unique descriptions per theme. Each ≤ 90 characters.
   - Different angles: offer, problem-solution, trust signal, CTA.
   - At least 1 contains a specific number or proof point; at least 1 ends with a clear CTA sentence.
7. Display path: two segments, each ≤ 15 chars, lowercase, hyphenated; reflect the theme's resolved offer (e.g. `/free-guide/<topic>` for a cold-resolved theme, `/get-quote/<topic>` for a scalding one).
8. Notes line, keyed to the theme's resolved temperature: cold = soft lead magnet, no urgency/RLSA · warm = destination match + any retargeting · hot = FOMO mechanic + any RLSA segment · scalding = explicit CTA + any RLSA/area-code call extension.

### Ad Copy — Nine Principles (binding)

Each theme has ONE resolved temperature — the buying-cycle stage its `> Offer:` was matched to in the Keyword phase (cold/warm/hot/scalding, per Buying-Cycle Temperature & Offer Matching). Write that theme's whole ad set to that one temperature; the gradient below tells you how hard to push at each.

1. **Match copy to the theme's resolved temperature.** Write the ad set as if the searcher is exactly at that stage and no further — don't mix a cold theme's soft copy with a scalding CTA.
2. **Match the offer to the temperature.** cold = low-threat (cheatsheet/calculator/guide); warm = medium (template/demo/comparison); hot = higher (instant quote/free trial/scheduled demo); scalding = high (call now/buy now/signup). The `> Offer:` must be reachable from the ad's destination page.
3. **Use specific, verifiable numbers.** Exact/odd numbers beat rounded (`$47/mo`, `17 minutes`, `163%`). Pull from the source idea; never fabricate.
4. **Hyper-local.** For local/location-influenced buyers, put the location in the headline AND display path; for phone verticals, match the call-extension area code.
5. **FOMO / urgency.** Manufacture credible urgency only on hot/scalding-resolved themes ("Ends Sunday", "47 left"); never scarcity the landing page can't back. Cold/warm themes use curiosity and value.
6. **Explicit, action-oriented CTA.** Direct verbs on hot/scalding themes; softer verbs ("See", "Learn") allowed only on a cold theme.
7. **Dynamic keyword insertion.** On hot/scalding themes, ≥1 headline uses `{KeyWord:<fallback>}` so the ad mirrors the query; combine with location tokens where applicable.
8. **RLSA / retargeting awareness.** In Notes, call out RLSA-targeted sets and the segment (cart-abandon, pricing-viewer, demo-no-show); for those, include one returning-visitor-incentive headline.
9. **Distribute across persuasion angles + quality-score rules** — see [`reference/google/4-ad-copy.md`](google/4-ad-copy.md) (Persuasion Angles + Quality-Score Alignment), the canonical source for these. Spread the 15 headlines across the three offer-matched frames it defines — cost-of-inaction, FOMO/scarcity-urgency (hot/scalding themes only), and risk-reversal — alongside the value/feature/proof angles, and satisfy its relevance rules (landing-page match, ad-group keywords in headlines, USP-led, emotion+logic mix, no near-duplicate phrasing, keyword insertion where variants are broad). Honor its **honest-use gate**: use scarcity, guarantees, and proof numbers only when the source idea backs them — omit the angle otherwise, never invent it. This is a **qualitative distribution across the existing 15 slots, not a new required count** — the hard minimums in the Output Contract and self-check (A5) are unchanged.

### Ad Copy — Execution Steps

A1. Read back the `### Keyword Themes` block you wrote. For each non-spend-trap theme lift its `> Offer:` line (used verbatim as the RSA's `> Offer:`), its resolved temperature (the buying-cycle stage that offer was matched to — sets how hard to push), and its member keywords (the concept to carry across ≥3 headlines). Skip `[spend-trap]` themes entirely.
A2. Extract the idea's category, buyer, key promises, pricing, timelines, and proof points from the processed file for numbers and claims.
A3. Generate one RSA ad set per non-spend-trap theme per the Output Contract and Nine Principles, in `### Keyword Themes` order. Each ad set's temperature is that theme's own resolved temperature (cold/warm/hot/scalding) — there is no fixed Cold/Warm/Hot/Scalding quartet; a campaign may have, say, two hot themes and one warm.
A4. Self-check every headline (≤30 chars), every description (≤90 chars), every display-path segment (≤15 chars). Rewrite any over-limit line before writing.
A5. Self-check per-theme minimums: 15 unique headlines, 4 unique descriptions, ≥2 numbers, ≥1 CTA verb, keyword-in-≥3-headlines, dynamic insertion when the theme is hot/scalding, no shared opening-3-words, no pins.
A6. Append `### Ad Copy` after `### Keyword Themes` (replace it if it already exists); preserve `### Keywords`, `### Keyword Themes`, and everything else exactly.
A7. Re-read the file and verify: exactly one `## Go To Market`; exactly one each of `### Keywords`, `### Keyword Themes`, `### Ad Copy`; **one `#### <Theme>` Ad Copy subsection per non-spend-trap theme, names and order matching `### Keyword Themes`**; each with one `> Offer:` line equal to that theme's, exactly 15 headlines, exactly 4 descriptions, one display path, one notes line.
A8. Return the single combined status line: `Updated <processed-path>: <kept_count> keywords [<decorated_count> Keyword Planner, <dropped_count> dropped, <negative_count> negatives] + <theme_count> themes (<adgroup_count> ad groups, <spendtrap_count> spend-trap) + Ad Copy: <adgroup_count> RSAs, <total_headlines> headlines, <total_descriptions> descriptions (<dki_count> dynamic insertion, <loc_count> location tokens).`

## CLI Prerequisites

The Keyword Planner CLI (`ads.sh keyword-ideas`) uses the same Google Ads credentials and `GOOGLE_ADS_CUSTOMER_ID` (or `--customer-id`) as the rest of the `/adkit *` lifecycle — see **`reference/conventions.md`** for invocation, customer-id resolution, and credentials. If credentials are missing the CLI exits non-zero with the SDK's verbatim error; surface it to the operator and do not modify the file.
