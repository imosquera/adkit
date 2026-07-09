/**
 * IO entry: GenerateKeywordIdeas -> decorated JSON candidates on stdout.
 *
 * Faithful port of `ads_skill/bin/keyword_ideas.py`. This is the only adkit
 * entrypoint that calls the Google Ads KeywordPlanIdeaService's
 * `generate_keyword_ideas` — an RPC NOT covered by the {@link AdsClient}
 * search/mutate abstraction. It therefore talks to `google-ads-api` directly,
 * building a `Customer` from the same google-ads.yaml credentials and calling
 * `customer.keywordPlanIdeas.generateKeywordIdeas(request)`.
 *
 * The SDK call is isolated behind {@link generateIdeaRows}; everything else — the
 * request builder, the row->ApiIdea->Candidate->bullet mapping — is pure and
 * unit-tested with canned idea rows (no network).
 */

import { readFileSync } from "node:fs";
import { GoogleAdsApi, type services } from "google-ads-api";
import { parse as parseYaml } from "yaml";
import { credentialsPath } from "../lib/auth.js";
import { resolveCustomer } from "../cli/args.js";
import { sdkErrorMessage } from "../cli/output.js";
import { formatBulletText } from "../lib/markdown.js";
import { type ApiIdea, type Candidate, unionCandidates } from "../lib/merge.js";
import { competitionLabel } from "../lib/metrics.js";

/** United States. (Python `DEFAULT_GEO`.) */
export const DEFAULT_GEO = "geoTargetConstants/2840";
/** English. (Python `DEFAULT_LANGUAGE`.) */
export const DEFAULT_LANGUAGE = "languageConstants/1000";
/** Google Ads API hard limit on `keyword_seed.keywords`. (Python `MAX_SEEDS`.) */
export const MAX_SEEDS = 20;

/** A single result row from `generateKeywordIdeas`. */
type IdeaRow = services.IGenerateKeywordIdeaResult;

/** Parsed keyword-ideas invocation. (Parse-don't-validate: built once in {@link main}.) */
export interface KeywordIdeasArgs {
  readonly customerId: string | null;
  readonly geo: string;
  readonly language: string;
  readonly seeds: readonly string[];
  readonly pageUrl: string | null;
}

/** Minimal slice of google-ads.yaml this entrypoint needs to build a Customer. */
interface AdsYaml {
  developer_token?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  login_customer_id?: string | number;
}

/**
 * Parse argv into a {@link KeywordIdeasArgs}. Pure over its input array; the
 * `--customer-id` default falls back to `GOOGLE_ADS_CUSTOMER_ID` exactly as the
 * Python `argparse` default did. `--seed` is repeatable; `--geo`/`--language`
 * default to US/English.
 *
 * (Python `_parse_args`.)
 */
export function parseArgs(argv: readonly string[]): KeywordIdeasArgs {
  const seeds: string[] = [];
  let customerId: string | null = process.env["GOOGLE_ADS_CUSTOMER_ID"] ?? null;
  let geo = DEFAULT_GEO;
  let language = DEFAULT_LANGUAGE;
  let pageUrl: string | null = null;

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
      case "--seed":
        if (value !== undefined) {
          seeds.push(value);
        }
        i += 1;
        break;
      case "--page-url":
        pageUrl = value ?? null;
        i += 1;
        break;
      default:
        // Unknown token: ignore (argparse would error, but faithful behavior
        // here favors the documented flags the slash command actually passes).
        break;
    }
  }

  return { customerId, geo, language, seeds, pageUrl };
}

/**
 * Build the `GenerateKeywordIdeasRequest` payload from resolved inputs. Pure:
 * mirrors the seed-selection branching of the Python `_build_request` —
 * keyword+url seed when both a page URL and seeds are present, url seed when only
 * a URL, else a bare keyword seed.
 */
export function buildRequest(params: {
  customerId: string;
  seeds: readonly string[];
  pageUrl: string | null;
  geo: string;
  language: string;
}): services.IGenerateKeywordIdeasRequest {
  const { customerId, seeds, pageUrl, geo, language } = params;
  const base: services.IGenerateKeywordIdeasRequest = {
    customer_id: customerId,
    language,
    geo_target_constants: [geo],
    include_adult_keywords: false,
  };
  if (pageUrl && seeds.length > 0) {
    return { ...base, keyword_and_url_seed: { url: pageUrl, keywords: [...seeds] } };
  }
  if (pageUrl) {
    return { ...base, url_seed: { url: pageUrl } };
  }
  return { ...base, keyword_seed: { keywords: [...seeds] } };
}

/**
 * Map one keyword-idea result row to an {@link ApiIdea}. Pure.
 *
 * Mirrors the Python `_row_to_api_idea`: volume is `avg_monthly_searches` (0 when
 * absent); the bid micros collapse to `null` when zero/absent (`int(x) or None`).
 */
export function rowToApiIdea(row: IdeaRow): ApiIdea {
  const metrics = row.keyword_idea_metrics ?? {};
  const low = Number(metrics.low_top_of_page_bid_micros ?? 0);
  const high = Number(metrics.high_top_of_page_bid_micros ?? 0);
  return {
    phrase: row.text ?? "",
    volume: Number(metrics.avg_monthly_searches ?? 0),
    competition: competitionLabel(metrics.competition),
    lowMicros: low || null,
    highMicros: high || null,
  };
}

/**
 * A Candidate serialized for stdout. This is a WIRE CONTRACT the `/adkit gtm`
 * slash command parses, so the keys are snake_case — matching the Python
 * `_candidate_to_dict` (`{**dataclasses.asdict(c), "bullet_text": ...}`) exactly,
 * NOT the internal camelCase Candidate. `bullet_text` is the decorated string the
 * slash command copies verbatim into markdown; missing optionals emit `null`
 * (Python's `None`).
 */
export interface CandidateDict {
  readonly phrase: string;
  readonly source: "llm" | "api" | "both";
  readonly volume: number | null;
  readonly competition: string | null;
  readonly low_micros: number | null;
  readonly high_micros: number | null;
  readonly bullet_text: string;
}

/** Decorate a Candidate for JSON output. Pure. (Python `_candidate_to_dict`.) */
export function candidateToDict(c: Candidate): CandidateDict {
  return {
    phrase: c.phrase,
    source: c.source,
    volume: c.volume ?? null,
    competition: c.competition ?? null,
    low_micros: c.lowMicros ?? null,
    high_micros: c.highMicros ?? null,
    bullet_text: formatBulletText(c),
  };
}

/**
 * The whole pure pipeline: idea rows + LLM seeds -> decorated candidate dicts.
 * No network, no SDK — unit-tested directly. (Python `main`'s tail: rows ->
 * ApiIdea -> union_candidates -> _candidate_to_dict.)
 */
export function buildCandidateDicts(rows: readonly IdeaRow[], seeds: readonly string[]): CandidateDict[] {
  const apiIdeas = rows.map(rowToApiIdea);
  return unionCandidates(seeds, apiIdeas).map(candidateToDict);
}

/**
 * The one SDK-touching function: build a Customer from google-ads.yaml and call
 * `keywordPlanIdeas.generateKeywordIdeas`, returning the raw result rows.
 *
 * `login_customer_id` is carried from the yaml (the KeywordPlanIdeaService is
 * called against the operating account directly). Kept tiny and side-effect-only
 * so the pure mapping above stays testable without a live account.
 */
export async function generateIdeaRows(
  request: services.IGenerateKeywordIdeasRequest,
): Promise<IdeaRow[]> {
  const creds = (parseYaml(readFileSync(credentialsPath(), "utf8")) as AdsYaml | null) ?? {};
  const api = new GoogleAdsApi({
    client_id: creds.client_id ?? "",
    client_secret: creds.client_secret ?? "",
    developer_token: creds.developer_token ?? "",
  });
  const customer = api.Customer({
    customer_id: request.customer_id ?? "",
    refresh_token: creds.refresh_token ?? "",
    ...(creds.login_customer_id !== undefined ? { login_customer_id: String(creds.login_customer_id) } : {}),
  });
  // The SDK method's param type is the concrete request class (with toJSON); the
  // plain `I…Request` object is accepted at runtime, so narrow to the expected type.
  type GenerateArg = Parameters<typeof customer.keywordPlanIdeas.generateKeywordIdeas>[0];
  const response = await customer.keywordPlanIdeas.generateKeywordIdeas(request as GenerateArg);
  return response.results ?? [];
}

/**
 * Entry point. Returns the process exit code (2 on bad args, 1 on SDK error, 0 on
 * success). Faithful to the Python `main`: resolve the customer id, require a
 * seed or page URL, truncate to {@link MAX_SEEDS}, call the SDK, then emit the
 * decorated candidate JSON on stdout with the same stderr narration.
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

  const cleanSeeds = args.seeds.filter((s) => s.trim() !== "");
  if (cleanSeeds.length === 0 && !args.pageUrl) {
    process.stderr.write("error: at least one --seed or --page-url required\n");
    return 2;
  }

  let seeds = cleanSeeds;
  if (seeds.length > MAX_SEEDS) {
    process.stderr.write(
      `warning: ${seeds.length} seeds provided; truncating to first ${MAX_SEEDS} (Google Ads API limit)\n`,
    );
    seeds = seeds.slice(0, MAX_SEEDS);
  }

  let rows: IdeaRow[];
  try {
    const request = buildRequest({
      customerId,
      seeds,
      pageUrl: args.pageUrl,
      geo: args.geo,
      language: args.language,
    });
    rows = await generate(request);
  } catch (exc) {
    process.stderr.write(`google-ads error: ${sdkErrorMessage(exc)}\n`);
    return 1;
  }

  if (!args.pageUrl) {
    process.stderr.write("no URL found in idea; using keyword seed only\n");
  }

  const dicts = buildCandidateDicts(rows, seeds);
  process.stdout.write(JSON.stringify(dicts, null, 2) + "\n");
  if (rows.length === 0) {
    process.stderr.write("API returned zero ideas; using LLM seeds only\n");
  }
  return 0;
}

// Run as a CLI entrypoint (mirrors Python's `if __name__ == "__main__"`).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc: unknown) => {
      process.stderr.write(`google-ads error: ${sdkErrorMessage(exc)}\n`);
      process.exitCode = 1;
    });
}
