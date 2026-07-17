/**
 * IO entry: competitive + keyword research -> a deterministic JSON envelope.
 *
 * This is the deterministic engine behind `/adkit research`. The slash command
 * (reference/research.md) picks the competitors/seeds and writes the human-facing
 * report; THIS bin does the repeatable, math-heavy middle: fan the Keyword
 * Planner out across every competitor domain and seed set, union the ideas with
 * source provenance, score each keyword's competitiveness/opportunity, and roll
 * the set up into themes with volume + cost. Same "CLI is deterministic, model is
 * creative" split as the rest of adkit (see reference/conventions.md).
 *
 * It reuses the keyword-ideas planner path verbatim ({@link buildRequest},
 * {@link generateIdeaRows}, {@link conceptGroupName}) — the ONLY adkit call that
 * hits `KeywordPlanIdeaService.generate_keyword_ideas`. Every probe is one such
 * RPC: a competitor URL becomes a `url_seed`, a seed-keyword set becomes a
 * `keyword_seed`. The pure pipeline (aggregate -> score -> theme -> overlay) is
 * unit-tested with canned rows; only {@link runProbes} touches the network.
 *
 * Usage: research --competitor <url> [--competitor <url> ...] [--seed <kw> ...]
 *                 [--geo geoTargetConstants/N] [--language languageConstants/N]
 *                 [--customer-id <id>] [--history <report-raw.yaml>]
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { type services } from "google-ads-api";
import { isMainModule } from "../cli/entry.js";
import { resolveCustomer } from "../cli/args.js";
import { emitJson, errorEnvelope, ok, sdkErrorMessage } from "../cli/output.js";
import { formatBulletText } from "../lib/markdown.js";
import { competitionLabel, formatCpcRange } from "../lib/metrics.js";
import { microsToCurrency } from "../lib/report.js";
import { comparisonKey, MAX_KEYWORD_CHARS, MIN_VOLUME } from "../lib/merge.js";
import {
  buildRequest,
  conceptGroupName,
  DEFAULT_GEO,
  DEFAULT_LANGUAGE,
  generateIdeaRows,
  MAX_SEEDS,
} from "./keyword-ideas.js";

/** More than this many competitor URLs is almost certainly a mistake; cap it. */
export const MAX_COMPETITORS = 15;
/** Concept-group name used when the Keyword Planner didn't annotate an idea. */
export const UNTHEMED = "Unthemed";

type IdeaRow = services.IGenerateKeywordIdeaResult;

// ---------------------------------------------------------------------------
// Args (parse-don't-validate: built once in main)
// ---------------------------------------------------------------------------

export interface ResearchArgs {
  readonly customerId: string | null;
  readonly geo: string;
  readonly language: string;
  /** Competitor domain/landing-page URLs — one Keyword Planner `url_seed` each. */
  readonly competitors: readonly string[];
  /** Shared seed keywords — one `keyword_seed` probe for the whole run. */
  readonly seeds: readonly string[];
  /** Optional path to a `ads.sh report` raw YAML, for the owned CTR/CPC overlay. */
  readonly historyPath: string | null;
}

/**
 * Parse argv into a {@link ResearchArgs}. Pure. `--competitor` and `--seed` are
 * repeatable; `--geo`/`--language` default to US/English (same constants the
 * keyword-ideas bin uses); `--customer-id` falls back to GOOGLE_ADS_CUSTOMER_ID.
 * Unknown tokens are ignored (matches the keyword-ideas bin's lenient parser).
 */
export function parseArgs(argv: readonly string[]): ResearchArgs {
  const competitors: string[] = [];
  const seeds: string[] = [];
  let customerId: string | null = process.env["GOOGLE_ADS_CUSTOMER_ID"] ?? null;
  let geo = DEFAULT_GEO;
  let language = DEFAULT_LANGUAGE;
  let historyPath: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--customer-id":
        customerId = value ?? null;
        i += 1;
        break;
      case "--geo":
        geo = value ?? geo;
        i += 1;
        break;
      case "--language":
        language = value ?? language;
        i += 1;
        break;
      case "--competitor":
        if (value !== undefined) competitors.push(value);
        i += 1;
        break;
      case "--seed":
        if (value !== undefined) seeds.push(value);
        i += 1;
        break;
      case "--history":
        historyPath = value ?? null;
        i += 1;
        break;
      default:
        break;
    }
  }

  return { customerId, geo, language, competitors, seeds, historyPath };
}

// ---------------------------------------------------------------------------
// Probes (one generate_keyword_ideas RPC each)
// ---------------------------------------------------------------------------

/** A single Keyword Planner call: a labelled source + its request payload. */
export interface Probe {
  /** Human-facing source label (a competitor host, or "seeds"). */
  readonly label: string;
  readonly request: services.IGenerateKeywordIdeasRequest;
}

/**
 * The host portion of a URL, used as a competitor's source label (`https://www.
 * acme.com/pricing` -> `acme.com`). Falls back to the raw string when it doesn't
 * parse as a URL, and strips a leading `www.` so `www.acme.com` and `acme.com`
 * collapse to one label. Pure.
 */
export function competitorLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || url;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || url;
  }
}

/**
 * Build one probe per competitor URL (a `url_seed`) plus one shared `keyword_seed`
 * probe when seeds are present. Pure. Competitor probes are URL-only on purpose:
 * mixing the shared seeds into each competitor call would blur which keywords the
 * domain actually ranks for, and clean per-source provenance is what powers the
 * overlap signal in {@link aggregate}.
 */
export function buildProbes(params: {
  customerId: string;
  competitors: readonly string[];
  seeds: readonly string[];
  geo: string;
  language: string;
}): Probe[] {
  const { customerId, competitors, seeds, geo, language } = params;
  const competitorProbes = competitors.map((url) => ({
    label: competitorLabel(url),
    request: buildRequest({ customerId, seeds: [], pageUrl: url, geo, language }),
  }));
  const seedProbe: Probe[] =
    seeds.length > 0
      ? [{ label: "seeds", request: buildRequest({ customerId, seeds, pageUrl: null, geo, language }) }]
      : [];
  return [...competitorProbes, ...seedProbe];
}

/** One idea from a probe, tagged with the source it came from. */
export interface ResearchIdea {
  readonly phrase: string;
  readonly source: string;
  readonly volume: number;
  readonly competition: string;
  /** Google's 0–100 competition index, or null when the row carries none. */
  readonly competitionIndex: number | null;
  readonly lowMicros: number | null;
  readonly highMicros: number | null;
  readonly conceptGroup: string | null;
}

/**
 * Map one keyword-idea result row to a {@link ResearchIdea}, tagged with its
 * source label. Pure. Extends the keyword-ideas bin's `rowToApiIdea` with the
 * `competition_index` field (0–100) — a real proto field on
 * `keyword_idea_metrics` that the keyword-ideas bin doesn't surface, and the best
 * numeric competitiveness signal the Keyword Planner offers.
 */
export function rowToResearchIdea(row: IdeaRow, source: string): ResearchIdea {
  const metrics = (row.keyword_idea_metrics ?? {}) as {
    avg_monthly_searches?: number | null;
    competition?: unknown;
    competition_index?: number | string | null;
    low_top_of_page_bid_micros?: number | null;
    high_top_of_page_bid_micros?: number | null;
  };
  const idx = metrics.competition_index;
  const competitionIndex =
    idx === null || idx === undefined || Number.isNaN(Number(idx)) ? null : Number(idx);
  const low = Number(metrics.low_top_of_page_bid_micros ?? 0);
  const high = Number(metrics.high_top_of_page_bid_micros ?? 0);
  return {
    phrase: row.text ?? "",
    source,
    volume: Number(metrics.avg_monthly_searches ?? 0),
    competition: competitionLabel(metrics.competition),
    competitionIndex,
    lowMicros: low || null,
    highMicros: high || null,
    conceptGroup: conceptGroupName(row),
  };
}

/** Result of running one probe: its label, mapped ideas, and any SDK error. */
export interface ProbeResult {
  readonly label: string;
  readonly ideas: readonly ResearchIdea[];
  /** SDK error message when this probe failed; null on success. */
  readonly error: string | null;
}

/**
 * Run every probe against the Keyword Planner, best-effort. The ONLY networked
 * function. A single probe failing (a dead competitor URL, say) is recorded on
 * that probe and does not abort the run — the rest still produce ideas, and
 * {@link main} decides whether the surviving set is empty. The SDK call is
 * injectable ({@link generateIdeaRows} by default) so the pure pipeline is
 * testable without a live account.
 */
export async function runProbes(
  probes: readonly Probe[],
  generate: (req: services.IGenerateKeywordIdeasRequest) => Promise<IdeaRow[]> = generateIdeaRows,
): Promise<ProbeResult[]> {
  return Promise.all(
    probes.map(async (probe) => {
      try {
        const rows = await generate(probe.request);
        return { label: probe.label, ideas: rows.map((r) => rowToResearchIdea(r, probe.label)), error: null };
      } catch (exc) {
        return { label: probe.label, ideas: [] as ResearchIdea[], error: sdkErrorMessage(exc) };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

/** A keyword unioned across probes, carrying which sources surfaced it. */
export interface AggregatedKeyword {
  readonly phrase: string;
  readonly volume: number;
  readonly competition: string;
  readonly competitionIndex: number | null;
  readonly lowMicros: number | null;
  readonly highMicros: number | null;
  readonly conceptGroup: string | null;
  /** Sorted, de-duplicated source labels that surfaced this keyword. */
  readonly sources: readonly string[];
}

/**
 * Union every probe's ideas into deduped {@link AggregatedKeyword}s. Pure.
 *
 * Dedup is by {@link comparisonKey} (case/whitespace-folded). Within a key the
 * "primary" row — the one with the greatest volume (tie-break: higher CPC bid,
 * then first seen) — supplies the metric tuple, so volume/competition/CPC stay a
 * real, self-consistent set rather than a franken-max across rows. `sources` is
 * the union of every probe that surfaced the key; its length is the competitor
 * overlap (how many sources compete for the term). Ideas below MIN_VOLUME or over
 * MAX_KEYWORD_CHARS are dropped first, mirroring the keyword-ideas union policy.
 */
export function aggregate(ideas: readonly ResearchIdea[]): AggregatedKeyword[] {
  const kept = ideas.filter((i) => i.volume >= MIN_VOLUME && i.phrase.length <= MAX_KEYWORD_CHARS);
  const groups = kept.reduce((map, idea) => {
    const key = comparisonKey(idea.phrase);
    const prev = map.get(key);
    map.set(key, prev ? [...prev, idea] : [idea]);
    return map;
  }, new Map<string, ResearchIdea[]>());

  return [...groups.values()].map((rows) => {
    const primary = rows.reduce((best, r) =>
      r.volume > best.volume || (r.volume === best.volume && (r.highMicros ?? 0) > (best.highMicros ?? 0))
        ? r
        : best,
    );
    const sources = [...new Set(rows.map((r) => r.source))].sort();
    const conceptGroup = rows.map((r) => r.conceptGroup).find((c) => c != null) ?? null;
    return {
      phrase: primary.phrase,
      volume: primary.volume,
      competition: primary.competition,
      competitionIndex: primary.competitionIndex,
      lowMicros: primary.lowMicros,
      highMicros: primary.highMicros,
      conceptGroup,
      sources,
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring (pure, deterministic given the set)
// ---------------------------------------------------------------------------

/** Coarse competition label -> 0–100 base, used only when no numeric index. */
const COMPETITION_BASE: Record<string, number> = { LOW: 20, MEDIUM: 50, HIGH: 80, UNSPECIFIED: 50 };

/** A keyword decorated with its deterministic competitiveness/opportunity scores. */
export interface ScoredKeyword extends AggregatedKeyword {
  /** 0–100: how hard/expensive the term is to win (higher = tougher). */
  readonly competitiveness: number;
  /** 0–100: high-volume, low-competition = high (a rough "go here first"). */
  readonly opportunity: number;
}

const cpcHighDollars = (k: AggregatedKeyword): number => microsToCurrency(k.highMicros);

/**
 * Score every keyword's competitiveness and opportunity. Pure, and deterministic
 * given the input set (the CPC/volume normalisers are the set's own maxima).
 *
 * - **competitiveness** blends the two forward-looking signals the planner gives
 *   for keywords the account has never run: Google's competition index (how many
 *   advertisers bid — 65%) and the top-of-page CPC relative to the set's priciest
 *   term (how much they pay — 35%). It is a proxy, not measured history.
 * - **opportunity** rewards reach and penalises toughness: a log-damped volume
 *   score (so a few giant terms don't flatten everything) times `(1 −
 *   competitiveness)`. High volume + low competition floats to the top.
 *
 * Both are heuristics meant to *rank* a set for a human, not to predict outcomes;
 * the weights are stated here and echoed in the output's `scoring.note`.
 */
export function score(keywords: readonly AggregatedKeyword[]): ScoredKeyword[] {
  const maxCpc = Math.max(0, ...keywords.map(cpcHighDollars));
  const maxVolume = Math.max(0, ...keywords.map((k) => k.volume));
  const lnMaxVol = Math.log1p(maxVolume);
  return keywords.map((k) => {
    const base = k.competitionIndex ?? COMPETITION_BASE[k.competition] ?? 50;
    const cpcNorm = maxCpc > 0 ? cpcHighDollars(k) / maxCpc : 0;
    const competitiveness = Math.round(clamp(0.65 * base + 0.35 * cpcNorm * 100, 0, 100));
    const volScore = lnMaxVol > 0 ? Math.log1p(k.volume) / lnMaxVol : 0;
    const opportunity = Math.round(clamp(100 * volScore * (1 - competitiveness / 100), 0, 100));
    return { ...k, competitiveness, opportunity };
  });
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// ---------------------------------------------------------------------------
// Theme roll-up (pure)
// ---------------------------------------------------------------------------

/** A concept-group theme with its rolled-up volume, cost, and competitiveness. */
export interface Theme {
  readonly name: string;
  readonly keyword_count: number;
  readonly total_volume: number;
  /** Volume-weighted mean competitiveness (0–100), so big terms dominate. */
  readonly avg_competitiveness: number;
  /** Display CPC band across the theme (min low bid — max high bid). */
  readonly cpc_range: string;
  /** Competitor sources that surface any keyword in this theme (sorted). */
  readonly competitors: readonly string[];
  /** Up to 5 highest-volume keywords, for the report's at-a-glance table. */
  readonly top_keywords: ReadonlyArray<{ phrase: string; volume: number; bullet_text: string }>;
}

/**
 * Group scored keywords into concept-group themes and roll each up. Pure. Themes
 * come back ordered by total volume descending — the same "highest-potential
 * volume first" ordering `/adkit gtm` uses — so the report leads with the biggest
 * pools. A null concept group collects into {@link UNTHEMED}. `avg_competitiveness`
 * is volume-weighted because a theme's toughness is set by where its traffic is,
 * not by a long tail of zero-volume oddities.
 */
export function themes(keywords: readonly ScoredKeyword[]): Theme[] {
  const groups = keywords.reduce((map, k) => {
    const name = k.conceptGroup ?? UNTHEMED;
    map.set(name, [...(map.get(name) ?? []), k]);
    return map;
  }, new Map<string, ScoredKeyword[]>());

  return [...groups.entries()]
    .map(([name, members]) => {
      const totalVolume = members.reduce((s, k) => s + k.volume, 0);
      const weighted = members.reduce((s, k) => s + k.competitiveness * k.volume, 0);
      const lows = members.map((k) => k.lowMicros).filter((m): m is number => m != null && m > 0);
      const highs = members.map((k) => k.highMicros).filter((m): m is number => m != null && m > 0);
      const competitors = [...new Set(members.flatMap((k) => k.sources))].sort();
      const topKeywords = [...members]
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 5)
        .map((k) => ({ phrase: k.phrase, volume: k.volume, bullet_text: bulletFor(k) }));
      return {
        name,
        keyword_count: members.length,
        total_volume: totalVolume,
        avg_competitiveness: totalVolume > 0 ? Math.round(weighted / totalVolume) : 0,
        cpc_range: formatCpcRange(lows.length ? Math.min(...lows) : null, highs.length ? Math.max(...highs) : null),
        competitors,
        top_keywords: topKeywords,
      };
    })
    .sort((a, b) => b.total_volume - a.total_volume);
}

/** The decorated `phrase (vol, competition, $low–$high)` bullet for a keyword. */
function bulletFor(k: AggregatedKeyword): string {
  return formatBulletText({
    phrase: k.phrase,
    source: "api",
    volume: k.volume,
    competition: k.competition,
    lowMicros: k.lowMicros,
    highMicros: k.highMicros,
  });
}

// ---------------------------------------------------------------------------
// Owned-history overlay (pure over parsed YAML)
// ---------------------------------------------------------------------------

/** Real owned performance for a keyword the account has actually run. */
export interface OwnedHistory {
  readonly ctr: number;
  readonly avg_cpc: number;
  readonly clicks: number;
  readonly impressions: number;
}

/**
 * Index the `keywords` rows of an `ads.sh report` raw YAML by comparison key.
 * Pure over the already-parsed object. This is the ONLY source of *measured* CTR
 * and average CPC in the pipeline — Keyword Planner numbers are estimates. It
 * exists only for terms the account has run, so it overlays a minority of the
 * researched set (see {@link overlayHistory}). Later rows win on a key collision,
 * which is fine: report rows for one keyword carry the same account-level history.
 */
export function indexHistory(report: unknown): Map<string, OwnedHistory> {
  const rows = (report as { keywords?: unknown } | null)?.keywords;
  if (!Array.isArray(rows)) return new Map();
  return rows.reduce((map, raw) => {
    const r = raw as { text?: unknown; ctr?: unknown; avg_cpc?: unknown; clicks?: unknown; impressions?: unknown };
    if (typeof r.text !== "string" || r.text.trim() === "") return map;
    map.set(comparisonKey(r.text), {
      ctr: Number(r.ctr ?? 0),
      avg_cpc: Number(r.avg_cpc ?? 0),
      clicks: Number(r.clicks ?? 0),
      impressions: Number(r.impressions ?? 0),
    });
    return map;
  }, new Map<string, OwnedHistory>());
}

/** A scored keyword with its owned history attached when the account runs it. */
export interface ResearchedKeyword extends ScoredKeyword {
  /** Measured CTR/CPC when the account already runs the term; null otherwise. */
  readonly owned: OwnedHistory | null;
}

/** Attach owned history to each keyword by comparison key. Pure. */
export function overlayHistory(
  keywords: readonly ScoredKeyword[],
  history: Map<string, OwnedHistory>,
): ResearchedKeyword[] {
  return keywords.map((k) => ({ ...k, owned: history.get(comparisonKey(k.phrase)) ?? null }));
}

// ---------------------------------------------------------------------------
// Output shaping (pure)
// ---------------------------------------------------------------------------

/** The per-keyword wire shape (snake_case, matches the adkit JSON convention). */
export interface KeywordDict {
  readonly phrase: string;
  readonly bullet_text: string;
  readonly volume: number;
  readonly competition: string;
  readonly competition_index: number | null;
  readonly low_micros: number | null;
  readonly high_micros: number | null;
  readonly cpc_range: string;
  readonly competitiveness: number;
  readonly opportunity: number;
  readonly concept_group: string | null;
  readonly sources: readonly string[];
  readonly overlap: number;
  readonly owned: OwnedHistory | null;
}

const SCORING_NOTE =
  "competitiveness (0–100) = 0.65·competition_index + 0.35·(CPC ÷ set-max CPC); " +
  "opportunity (0–100) = log-damped volume × (1 − competitiveness). Both are heuristics " +
  "over Keyword Planner estimates — real measured CTR/avg_cpc appears under `owned` only for " +
  "keywords the account has actually run.";

/** Serialize a researched keyword to its wire dict. Pure. */
export function keywordToDict(k: ResearchedKeyword): KeywordDict {
  return {
    phrase: k.phrase,
    bullet_text: bulletFor(k),
    volume: k.volume,
    competition: k.competition,
    competition_index: k.competitionIndex,
    low_micros: k.lowMicros,
    high_micros: k.highMicros,
    cpc_range: formatCpcRange(k.lowMicros, k.highMicros),
    competitiveness: k.competitiveness,
    opportunity: k.opportunity,
    concept_group: k.conceptGroup,
    sources: k.sources,
    overlap: k.sources.length,
    owned: k.owned,
  };
}

/**
 * The whole pure pipeline: probe results (+ optional parsed history) -> the
 * research payload. No IO. `keywords` come back ordered by opportunity descending
 * (the report's "where to look first"); `themes` by total volume descending.
 */
export function buildPayload(params: {
  probeResults: readonly ProbeResult[];
  competitors: readonly string[];
  seeds: readonly string[];
  geo: string;
  language: string;
  history: Map<string, OwnedHistory>;
}): Record<string, unknown> {
  const { probeResults, competitors, seeds, geo, language, history } = params;
  const allIdeas = probeResults.flatMap((p) => p.ideas);
  const scored = score(aggregate(allIdeas));
  const researched = overlayHistory(scored, history);
  const themeList = themes(scored);
  const keywordDicts = [...researched]
    .map(keywordToDict)
    .sort((a, b) => b.opportunity - a.opportunity || b.volume - a.volume);
  const warnings = probeResults.filter((p) => p.error).map((p) => `${p.label}: ${p.error}`);
  const ownedCount = keywordDicts.filter((k) => k.owned).length;

  return {
    geo,
    language,
    competitors: competitors.map((url) => ({ label: competitorLabel(url), url })),
    seeds,
    keyword_count: keywordDicts.length,
    owned_count: ownedCount,
    theme_count: themeList.length,
    scoring: { note: SCORING_NOTE },
    themes: themeList,
    keywords: keywordDicts,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/** Read + parse the owned-history report YAML, best-effort. Returns [] index on any failure. */
function loadHistory(path: string | null): { history: Map<string, OwnedHistory>; warning: string | null } {
  if (!path) return { history: new Map(), warning: null };
  try {
    return { history: indexHistory(parseYaml(readFileSync(path, "utf8"))), warning: null };
  } catch (exc) {
    return { history: new Map(), warning: `could not read --history ${path}: ${sdkErrorMessage(exc)}` };
  }
}

/**
 * Entry point. Returns the process exit code (2 on bad args, 1 when every probe
 * failed / nothing came back, 0 on success). On success it writes the research
 * payload as an `ok:true` envelope on stdout; a total failure writes an `ok:false`
 * envelope naming the step. Human narration goes to stderr (the JSON-envelope
 * contract in reference/conventions.md).
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  generate: (req: services.IGenerateKeywordIdeasRequest) => Promise<IdeaRow[]> = generateIdeaRows,
): Promise<number> {
  const args = parseArgs(argv);
  const customerId = resolveCustomer([args.customerId]);
  if (!customerId) {
    process.stderr.write(
      "error: --customer-id, GOOGLE_ADS_CUSTOMER_ID, or login_customer_id in google-ads.yaml required\n",
    );
    return 2;
  }

  const competitors = args.competitors.filter((c) => c.trim() !== "");
  const seeds = args.seeds.filter((s) => s.trim() !== "");
  if (competitors.length === 0 && seeds.length === 0) {
    process.stderr.write("error: at least one --competitor <url> or --seed <keyword> required\n");
    return 2;
  }

  let usableCompetitors = competitors;
  if (usableCompetitors.length > MAX_COMPETITORS) {
    process.stderr.write(
      `warning: ${usableCompetitors.length} competitors provided; truncating to first ${MAX_COMPETITORS}\n`,
    );
    usableCompetitors = usableCompetitors.slice(0, MAX_COMPETITORS);
  }
  let usableSeeds = seeds;
  if (usableSeeds.length > MAX_SEEDS) {
    process.stderr.write(
      `warning: ${usableSeeds.length} seeds provided; truncating to first ${MAX_SEEDS} (Google Ads API limit)\n`,
    );
    usableSeeds = usableSeeds.slice(0, MAX_SEEDS);
  }

  const probes = buildProbes({
    customerId,
    competitors: usableCompetitors,
    seeds: usableSeeds,
    geo: args.geo,
    language: args.language,
  });
  const probeResults = await runProbes(probes, generate);

  // Every probe erroring is a hard failure (bad creds, quota) — surface it as an
  // ok:false envelope naming the step, don't pretend an empty landscape.
  const failures = probeResults.filter((p) => p.error);
  if (failures.length === probes.length) {
    const msg = failures.map((p) => `${p.label}: ${p.error}`).join("; ");
    process.stderr.write(`google-ads error: ${msg}\n`);
    emitJson(errorEnvelope(msg, { step: "generate_keyword_ideas" }));
    return 1;
  }

  const { history, warning: historyWarning } = loadHistory(args.historyPath);
  if (historyWarning) process.stderr.write(`warning: ${historyWarning}\n`);

  const payload = buildPayload({
    probeResults,
    competitors: usableCompetitors,
    seeds: usableSeeds,
    geo: args.geo,
    language: args.language,
    history,
  });

  const keywordCount = payload["keyword_count"] as number;
  if (keywordCount === 0) {
    // Probes ran but every idea filtered below MIN_VOLUME — a real, diagnosable
    // zero, not a crash. Emit the (empty) payload so the caller sees the request
    // shape rather than a silent failure.
    process.stderr.write(
      `Keyword Planner returned no keywords at/above ${MIN_VOLUME} avg monthly searches across ` +
        `${probes.length} probe(s)\n`,
    );
  } else {
    process.stderr.write(
      `research: ${keywordCount} keywords, ${payload["theme_count"] as number} themes, ` +
        `${payload["owned_count"] as number} with owned history\n`,
    );
  }

  emitJson(ok(payload));
  return 0;
}

// Run as a CLI entrypoint (mirrors the other adkit bins' run-guard).
if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc: unknown) => {
      process.stderr.write(`google-ads error: ${sdkErrorMessage(exc)}\n`);
      process.exitCode = 1;
    });
}
