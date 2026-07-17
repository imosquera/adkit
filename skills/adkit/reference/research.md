---
description: "Competitive + keyword research (read-only): seed from a set of competitors OR an existing campaign/idea, expand into adjacent keywords and adjacent competitors, and rank the landscape by keyword theme — volume, cost (CPC), and a competitiveness score. Overlays real owned CTR/avg-CPC where the account already runs a term. Writes a dated competitive-landscape markdown report under ads/output/research/."
argument-hint: "<competitor-url> [<competitor-url> ...] | ideas/processed/<file>.md | <campaign-name-or-id> [--seed \"<kw>\" ...] [--geo geoTargetConstants/N] [--language languageConstants/N] [--customer <10-digit>] [--history]"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## Role

You run **competitive and keyword research** and hand the operator a ranked map of where to compete. You start from a seed — a set of **competitor URLs**, an existing **idea file**, or a live **campaign** — expand outward into the **adjacent keywords and adjacent competitors** the seed implies, and compare the whole landscape on the three axes that decide a search plan: **search volume** (how much demand), **cost** (top-of-page CPC), and **competitiveness** (how hard the term is to win). The answer is organized **by keyword theme**, because a theme (not a single keyword) is what becomes an ad group and a budget line.

This skill is **read-only** — it researches and reports, it never mutates a campaign. Its natural next step is `/adkit gtm` (turn a chosen theme into keywords + ad copy) or `/adkit create`.

> **Backend note:** `research` (like `keyword-ideas`) is driven by
> `KeywordPlanIdeaService.generate_keyword_ideas`, a non-GAQL RPC the google-ads-mcp
> server does **not** expose. It therefore stays on the `google-ads-api` SDK and is
> unaffected by the `ADKIT_READ_BACKEND` read-backend switch — see
> `reference/conventions.md` § "Read backend (SDK vs google-ads-mcp)".

Same division of labor as the rest of adkit:

- **Deterministic work is the CLI's** — fanning the Keyword Planner across every competitor domain and seed set, unioning the ideas with per-source provenance, reading Google's competition index and CPC bid range, scoring competitiveness/opportunity, rolling keywords up into themes with summed volume and a CPC band, and overlaying owned history. That is **`ads.sh research`** (`src/bin/research.ts`). It is pure and repeatable — same inputs, same numbers — so the comparison isn't hand-waved.
- **Creative judgement is yours** — *choosing* the competitors and seeds worth probing, spotting the **adjacent** areas the first pass reveals and probing them in a second pass, merging/renaming themes into ones an operator recognizes, and writing the ranked narrative that tells the operator where to spend first and why.

Mechanics (ads.sh invocation, customer-id resolution, the JSON envelope, credentials/preflight) are in **`reference/conventions.md`** — read it once. Run `ads.sh preflight` once per session before the first live call.

**Before proceeding, read:**
- [`reference/conventions.md`](conventions.md) — ads.sh, customer-id resolution, the `{ ok, ... }` JSON envelope, credentials
- [`reference/google/2-keyword-mining.md`](google/2-keyword-mining.md) — buyer-intent screening and what makes a keyword worth targeting (reused when you judge adjacency)
- [`reference/google/6-analyze.md`](google/6-analyze.md) — auction-insights / impression-share reading, for framing competitor pressure

## What the engine gives you (and its one honest limit)

`ads.sh research` returns, per keyword: `volume`, `competition` (LOW/MEDIUM/HIGH) + numeric `competition_index` (0–100), the `low_micros`/`high_micros` top-of-page CPC band, a `competitiveness` and an `opportunity` score (both 0–100), the Keyword Planner `concept_group`, the `sources` that surfaced it, and `overlap` (how many sources — the more competitors share a term, the more contested it is). Themes come back rolled up: summed volume, volume-weighted competitiveness, a CPC band, and the competitors present.

**The one limit, state it plainly in the report:** *measured* click-through rate and average CPC exist **only for keywords the account has actually run**. For a competitor's keywords and the adjacent terms you discover, there is **no owned history** — Google never tells you a rival's CTR. So competitiveness across un-owned keywords is a **proxy** built from the planner's competition index + CPC bid range + volume, not a measured rate. Where the account *does* run a term, `--history` overlays the real numbers (`owned.ctr`, `owned.avg_cpc`) so you can show estimate-vs-reality side by side. Never present a planner estimate as if it were measured history.

## Input Contract

`$ARGUMENTS` names the **seed** and optional flags. Resolve the seed into competitor URLs and/or seed keywords the engine can probe:

1. **Competitor URLs** (one or more `https?://…` tokens) — the primary mode. Each becomes a Keyword Planner `url_seed`: "what keyword universe does Google associate with this domain?" Point them at a rival's **home or a category/landing page**, not a blog post. Bare domains (`acme.com`) are fine — normalize to `https://acme.com`.
2. **An existing idea file** (`ideas/processed/<name>.md` or `ideas/raw/<name>.md`) — read it for the product, audience, and any competitor names/URLs it already lists; derive seed keywords (category + audience language, per `2-keyword-mining.md`) and any competitor URLs from its content. Pull the first `https?://` URL in the file through as a `url_seed` too.
3. **A live campaign** (a campaign name or id) — pull its current keywords with `ads.sh report --customer <id> --days <N>` and use its **top keywords by volume/spend as the seeds**, so the research is anchored to what the account already targets. This is also the seed that most rewards `--history` (the account has run these terms).
4. Explicit `--seed "<phrase>"` tokens (repeatable) always add to the seed set regardless of mode.
5. Flags: `--geo geoTargetConstants/N` and `--language languageConstants/N` (default US/English — omit when not given); `--customer <10-digit>` (else env/yaml per conventions); `--history` (opt into the owned-performance overlay — see Execution step 4).
6. If `$ARGUMENTS` yields **neither** a competitor URL **nor** any seed keyword, ask the user once for at least one competitor URL or a seed campaign/idea. Do not invent competitors.

Seeds are capped at 20 (Google Ads API limit) and competitors at 15 by the engine; if the user hands you more, keep the most relevant and say which you dropped.

## Execution

You are producing a competitive-landscape report. Four steps: resolve the seed, run the first pass, expand into adjacency, then write the report. Do not invent numbers — every figure comes from `ads.sh research` output.

### 1. Resolve the seed

Turn `$ARGUMENTS` into a concrete list of competitor URLs and seed keywords per the Input Contract. When seeding from an idea file or campaign, do the reading/derivation here. Keep a note of *why* each competitor/seed is in the set — it goes in the report's methodology line.

### 2. First pass — run the deterministic engine

Fan the Keyword Planner across the resolved seed in one call:

```bash
ads.sh research \
  --competitor "https://competitor-a.com" \
  --competitor "https://competitor-b.com/pricing" \
  [--seed "<category keyword>" --seed "<audience keyword>" ...] \
  [--geo geoTargetConstants/N] [--language languageConstants/N] \
  [--customer <10-digit>]
```

- Redirect stdout to capture the JSON payload (`> /tmp/research.json`); the human summary is on stderr.
- On `ok: false`, surface `error.step` and `error.message` **verbatim** and stop — do not fabricate a landscape (conventions.md).
- A `warnings` array means some competitor URL failed (dead page, blocked) while others succeeded; note it and continue.
- Read the `themes` (already ordered by total volume) and `keywords` (ordered by opportunity). This is your raw landscape.

### 3. Second pass — expand into adjacency (the part that makes this *research*, not a lookup)

The first pass shows you the seed's immediate universe. Now find what's **adjacent** — the whole point of research is to surface competition and demand the operator didn't already know about:

- **Adjacent keywords** — scan the returned `concept_group`s and the high-`overlap` themes for category language the seed didn't include (a sibling use-case, an alternative buyer term, a "vs / alternative to" cluster). Add those as new `--seed` phrases and run a second `ads.sh research` pass. Judge each new area for buyer intent using `2-keyword-mining.md` — an on-vertical, wrong-buyer cluster (free-seekers for a paid tool) is a finding too, but flag it as low-value, don't let it lead.
- **Adjacent competitors** — a keyword surfaced by a competitor you didn't seed, or a theme dominated by one rival, points at **other domains** worth probing. Name them (from your own knowledge of the space or a quick check of who ranks for the contested themes) and add them as `--competitor` URLs in the second pass.
- Merge the two passes' payloads by phrase (the engine dedupes within a pass; across passes, prefer the higher-volume/owned row). Two focused passes beat one giant seed list — bare-stem seeds make the planner return generic noise.

Stop expanding when a pass surfaces no genuinely new theme or competitor (usually 1–2 expansion passes is enough). If you skip expansion because the seed was already exhaustive, **say so** in the report — don't let a single-pass lookup read as a full sweep.

### 4. Overlay owned history (when the account runs any of these terms)

If the seed is a live campaign, or the user passed `--history`, pull the account's real performance and overlay it so the report can compare planner estimate vs measured reality:

```bash
bash ads.sh report --customer <id> --days <N>        # writes ads/output/reports/<date>-<customer>-raw.yaml
ads.sh research … --history ads/output/reports/<date>-<customer>-raw.yaml
```

The engine matches owned keywords by phrase and attaches `owned.ctr` / `owned.avg_cpc` / clicks / impressions. `owned_count` in the payload tells you how many of the researched keywords the account already runs. Everything without an `owned` block is un-owned — proxy metrics only.

### 5. Write the report

Write `ads/output/research/<YYYY-MM-DD>-<slug>-competitive-landscape.md` (slug from the primary competitor or campaign). Use this structure:

```markdown
# Competitive landscape — <subject>
<one-line window: geo, language, date, seed competitors/keywords, # of passes>

## Methodology
- Seeded from: <competitors / campaign / idea + why>
- Adjacency added in pass 2: <new keywords / competitors, or "none — seed was exhaustive">
- Metric note: competitiveness/opportunity are Keyword-Planner proxies; measured CTR/avg-CPC (marked ⬤ owned) exist only for the <owned_count> terms this account runs.

## Where to compete first (ranked recommendation)
<3–6 prioritized moves, each: a theme, the volume it opens, its CPC band + competitiveness, whether it's contested (overlap) or open, and why it's ranked here. Lead with the highest-opportunity, reachable theme.>

## Themes (by total search volume)
| Theme | Keywords | Volume/mo | CPC band | Competitiveness | Competitors present |
|-------|---------:|----------:|----------|----------------:|---------------------|
| <name> | <n> | <sum> | $L–$H | <0–100> | acme.com, beta.io |
| …     |    |        |        |               |                   |

## Competitor overlap
<which competitors contest which themes; who owns a theme alone (a moat) vs shared battlegrounds (high overlap). Pull from each theme's `competitors` + each keyword's `overlap`.>

## Owned vs estimated (only if --history was used)
<for the terms the account runs: planner competition/CPC estimate vs the real owned.ctr / owned.avg_cpc. Call out where reality diverges from the estimate — e.g. a "HIGH competition" term you actually win cheaply.>

## Top keywords by opportunity
<a table of the ~15 highest-opportunity keywords: bullet_text (volume, competition, CPC), competitiveness, opportunity, sources. Use each keyword's verbatim `bullet_text` from the payload — don't re-format the decoration.>
```

Rules:
- **Sort themes by total volume; sort the keyword table by opportunity.** That's how the payload is ordered — keep it, it's the "biggest demand first" / "best bet first" reading.
- Use each keyword's verbatim `bullet_text` string for its `(volume, competition, $L–$H)` decoration — the engine is the single producer of that format; don't regenerate it.
- Every competitiveness/opportunity number is a proxy — the metric note and the ⬤-owned marker keep that honest. Never drop it.
- Keep recommendations concrete: a theme, a dollar/volume figure, and a next action (`/adkit gtm` this theme, avoid that spend-trap cluster, this competitor owns X so flank via Y).

### 6. Report back

Tell the user the report path and a 3–4 sentence headline: the biggest-volume theme, the best-opportunity (high-demand, winnable) theme, the most-contested battleground, and — if relevant — any adjacent competitor/keyword area the research surfaced that they hadn't named. Point them at `/adkit gtm <idea>` as the next step to build a chosen theme out.

## CLI Prerequisites

`ads.sh research` uses the same Google Ads credentials and customer-id resolution as the rest of the `/adkit *` lifecycle — see **`reference/conventions.md`**. It calls the same `KeywordPlanIdeaService.generate_keyword_ideas` RPC as `ads.sh keyword-ideas`, so if credentials are missing it exits non-zero with the SDK's verbatim error; surface it and stop. `--history` additionally reads a raw report YAML produced by `ads.sh report`.
