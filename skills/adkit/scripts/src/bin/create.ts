/**
 * IO entry: scaffold a brief from a processed idea -> validate -> persist to
 * adbriefs/ -> publish to Google Ads.
 *
 * The filled brief is persisted to `adbriefs/<slug>.yaml` (the local source of
 * truth) BEFORE publishing, and its diff against any existing brief is shown first —
 * the review-the-change gate. The scaffolding step still uses a throwaway temp file
 * for *filling in* the brief; the completed brief lands in adbriefs/. Read live state
 * with /adkit audit; revise live ads with ads.sh update.
 *
 * Run: ads.sh create <idea-slug|brief-path.yaml> [--dry-run] [--top-n N]
 *
 * Style note: pure scaffold-building (`buildSkeleton`) and pure arg parsing
 * (`parseTopN`) are isolated from the filesystem/network shell (`resolveBriefPath`,
 * `readBrief`, `main`). The brief is parsed once via `parseBrief` (zod); downstream
 * relies on the typed `Brief`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isMainModule } from "../cli/entry.js";
import { formatGoogleAdsError } from "../ads/errors.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify, YAMLParseError } from "yaml";
import { z } from "zod";

import { publishV1 } from "../ads/publish.js";
import {
  AdbriefsError,
  BRIEF_YAML_STRINGIFY_OPTS,
  assertNoForeignBrief,
  briefPathForCampaign,
  loadBriefIfExists,
  writeBrief,
} from "../adbriefs/store.js";
import { diffBriefs } from "../adbriefs/diff.js";
import { buildState, statePathForCampaign, writeState } from "../adbriefs/state.js";
import { resolveCustomer } from "../cli/args.js";
import { emitJson, errorEnvelope } from "../cli/output.js";
import {
  DEFAULT_TOP_N,
  MAX_KEYWORDS_PER_THEME,
  extractNegatives,
  readThemeGroups,
  slugFromProcessedPath,
} from "../ideas/parse.js";
import { unreachableUrls } from "../ideas/urls.js";
import { loadClient } from "../lib/auth.js";
import { parseBrief, type Brief } from "../lib/schema.js";

/**
 * Repo root — bare idea slugs resolve under `<root>/ideas/processed/`. Read at
 * module load so tests can leave it as cwd.
 */
const REPO_ROOT = process.cwd();

/**
 * Scaffolded briefs are throwaway (not committed). Stable temp path so re-running
 * the same idea slug finds the brief you filled in on the first pass.
 */
const BRIEF_TMP_DIR = join(tmpdir(), "ads-briefs");

// ---------- io helpers ----------

/** Print `error: <msg>` to stderr and throw an {@link ExitError} carrying `code`. */
function die(msg: string, code = 1): never {
  process.stderr.write(`error: ${msg}\n`);
  throw new ExitError(code);
}

/**
 * A requested process exit. `main` catches it and returns the code so the entry
 * shell can `process.exit` once, keeping the die-path testable (no real exit).
 */
export class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
    this.name = "ExitError";
  }
}

// ---------- brief scaffold (pure) ----------

/**
 * A fresh campaign should launch near this many keywords — matches the gtm
 * generation target and clears the audit's 25-keyword floor by a wide margin.
 */
export const TARGET_KEYWORDS = 100;
/** Acceptable band around {@link TARGET_KEYWORDS}: ±10% (90-110). Outside it, create warns. */
export const KEYWORD_TARGET_TOLERANCE = 0.1;
const KEYWORD_TARGET_MIN = Math.round(TARGET_KEYWORDS * (1 - KEYWORD_TARGET_TOLERANCE)); // 90
const KEYWORD_TARGET_MAX = Math.round(TARGET_KEYWORDS * (1 + KEYWORD_TARGET_TOLERANCE)); // 110

/**
 * Pure: a one-line nudge when a campaign's total keyword count falls outside the
 * ±10% band around {@link TARGET_KEYWORDS}, else null (on target → no noise).
 */
export function keywordCountWarning(total: number): string | null {
  if (total >= KEYWORD_TARGET_MIN && total <= KEYWORD_TARGET_MAX) {
    return null;
  }
  const fix =
    total < KEYWORD_TARGET_MIN
      ? "add more keywords to the processed idea's ### Keyword Themes"
      : "trim with --top-n or in the idea";
  return (
    `${total} keywords total — aim for ~${TARGET_KEYWORDS} ` +
    `(${KEYWORD_TARGET_MIN}-${KEYWORD_TARGET_MAX}); ${fix}`
  );
}

/**
 * Build the throwaway brief skeleton object from the idea's parsed themes +
 * negatives. Pure — no fs, no stdout. TODO placeholders mark every field the
 * operator must fill; the pre-publish validation/URL checks reject leftover TODOs.
 */
export function buildSkeleton(
  name: string,
  themes: ReadonlyArray<[string, string[]]>,
  negatives: ReturnType<typeof extractNegatives>,
): Record<string, unknown> {
  const range = (start: number, end: number): number[] =>
    Array.from({ length: end - start }, (_, i) => start + i);

  const adGroups = themes.map(([themeNameStr, kws]) => ({
    name: themeNameStr, // STAG: ad group IS the keyword theme (gtm ### Keyword Themes)
    defaultBidMicros: 1_500_000,
    responsiveSearchAd: {
      headlines: range(1, 16).map((i) => ({ text: `TODO headline ${i} (≤30 chars)` })),
      descriptions: range(1, 5).map((i) => ({ text: `TODO description ${i} (≤90 chars, end with CTA)` })),
      // Landing pages publish under /ideas/<published-slug> (clean URL, no .html).
      // The published slug is the timestamped name from `Idea HTML`, not this
      // processed-file slug — fill it in. The pre-publish URL check rejects a
      // leftover TODO because it 404s.
      finalUrl: "https://www.example.com/ideas/TODO-published-slug",
      // Optional display-URL "pretty URL" paths (path1/path2) are intentionally
      // omitted from the scaffold — a leftover placeholder is rejected at
      // validation, so an untouched brief would fail. See the commented
      // OPTIONAL ADD-ONS template appended below the brief to add them.
    },
    // All theme keywords as PHRASE — close-variant matching + AI Max cover
    // plurals/typos/synonyms, so the SKAG-era PHRASE+EXACT pair is redundant.
    keywords: kws.map((kw) => ({ text: kw, matchType: "PHRASE" })),
  }));

  return {
    name,
    version: 1,
    campaign: {
      name: `${name}-search`,
      budgetMicros: 25_000_000, // $25.00/day
      networkSettings: "search-partners-display", // Google search + search partners (Display Network always off); "search-only" to restrict
      bidStrategy: "maximize-clicks", // cold-start warm-up; graduate to maximize-conversions in UI after ~15-30 conv/30d
      // "cpcBidCeilingMicros": 2_000_000,  // optional $2.00 max CPC cap for the maximize-clicks warm-up
      aiMax: true, // AI Max for Search on; set False for strict keyword matching. Per-ad-group opt-out via adGroups[].aiMax (default off)
      // "devices": ["computer", "tablet", "tv"],  // omit = default (mobile -100%); list all to serve everywhere

      // Campaign-level negative keywords, auto-seeded from the processed
      // file's "#### Negative Keywords" section (empty if none). Shared
      // across every theme — block off-theme close-variant / AI Max traffic.
      negativeKeywords: negatives,
      // Exactly 6 sitelinks (link_text ≤25 chars). finalUrl under /ideas/<slug> (clean URL).
      sitelinks: range(1, 7).map((i) => ({
        text: `TODO sitelink ${i} (≤25)`,
        finalUrl: "https://www.example.com/ideas/TODO-published-slug",
      })),
      // At least 4 callouts (≤25 chars each), short benefit phrases shown
      // under the ad, e.g. "No new integrations" / "Live in 30 days".
      callouts: range(1, 5).map((i) => `TODO callout ${i} (≤25)`),
      // priceAsset + structuredSnippet are OPTIONAL and intentionally omitted from
      // the scaffold: pre-filled TODO offerings 404 the URL check (priceAsset) or
      // publish literal "TODO service" text (structuredSnippet), so an untouched
      // brief would fail or ship junk. Add them from the commented OPTIONAL ADD-ONS
      // template appended below the brief if you want them.
    },
    adGroups,
  };
}

/**
 * Commented-out YAML template for the optional assets the scaffold omits
 * (priceAsset, structuredSnippet, and per-ad-group path1/path2). Appended below
 * the brief so a required-only brief validates as-is, while operators who want the
 * extras have a ready-to-uncomment example. Every line is a `#` comment — the YAML
 * parser ignores it entirely.
 */
export const COMMENTED_OPTIONAL_ASSETS = `
# ---------------------------------------------------------------------------
# OPTIONAL ADD-ONS (commented out — a brief validates without them). Uncomment
# and fill in to include, then remove the leading "# " from each line.
# ---------------------------------------------------------------------------
# Under campaign::
#   priceAsset:
#     type: SERVICES
#     languageCode: en
#     currencyCode: USD
#     offerings:            # 3–8 offerings
#       - header: "Plan name (≤25)"
#         description: "Benefit (≤25)"
#         priceMicros: 1000000
#         finalUrl: https://www.example.com/ideas/published-slug
#   structuredSnippet:
#     header: SERVICE_CATALOG
#     values: ["Value one", "Value two", "Value three"]   # 3–10, unique
#
# Under an ad group's responsiveSearchAd:: keyword-rich display-URL segments
# (each ≤15 chars, no spaces or "/"). path2 requires path1.
#     path1: keyword
#     path2: segment
`;

/**
 * Scaffold a skeleton brief YAML from the processed idea markdown into
 * `briefPath`, print the summary to stderr, and exit(2) so the operator fills it
 * in. Dies (exit 1) if the idea markdown is missing or has no keyword themes.
 */
function scaffoldBriefFromProcessed(mdPath: string, briefPath: string, maxPerTheme: number): never {
  if (!existsSync(mdPath)) {
    die(`no brief at ${briefPath} and processed idea not found at ${mdPath}`);
  }
  const md = readFileSync(mdPath, "utf8");
  const slug = slugFromProcessedPath(mdPath);
  const name = slug.length <= 64 ? slug : slug.slice(0, 64).replace(/-+$/, "");
  const themes = readThemeGroups(md, maxPerTheme);
  const negatives = extractNegatives(md);
  if (themes.length === 0) {
    die(
      `${mdPath} has no "## Go To Market > ### Keyword Themes" section (one #### ` +
        `theme per ad group). Re-run /adkit gtm ${mdPath} to (re)generate it.`,
    );
  }
  const skeleton = buildSkeleton(name, themes, negatives);
  mkdirSync(dirname(briefPath), { recursive: true });
  // defaultStringType QUOTE_DOUBLE double-quotes every string scalar so an
  // operator editing a headline/description/sitelink in place can type a ": "
  // (colon-space) without producing invalid YAML — the #1 hand-edit break.
  // lineWidth: 0 disables folding so long values stay on one quoted line.
  // Same stringify options as serializeBrief (shared const) so a scaffolded brief and
  // a persisted adbriefs/ brief serialize identically — keeps later diffs clean.
  writeFileSync(briefPath, yamlStringify(skeleton, BRIEF_YAML_STRINGIFY_OPTS) + COMMENTED_OPTIONAL_ASSETS);
  const themesPretty = themes.map(([theme, kws]) => `${theme} (${kws.length} kw)`).join("\n  - ");
  const totalKeywords = themes.reduce((n, [, kws]) => n + kws.length, 0);
  const kwWarning = keywordCountWarning(totalKeywords);
  process.stderr.write(
    `scaffolded ${briefPath} from ${mdPath}\n` +
      `${themes.length} STAG ad groups (one per keyword theme; spend-trap excluded):\n  - ${themesPretty}\n` +
      (kwWarning
        ? `⚠ ${kwWarning}\n`
        : `${totalKeywords} keywords total (on target ~${TARGET_KEYWORDS})\n`) +
      `${negatives.length} campaign negative keywords seeded from the processed file\n` +
      "6 sitelink + 4 callout placeholders added (fill these in too)\n" +
      "priceAsset/structuredSnippet/path1/path2 are OPTIONAL — see the commented template at the end of the brief\n" +
      "fill in headlines/descriptions/finalUrl per ad group, then re-run\n",
  );
  throw new ExitError(2);
}

/**
 * Resolve the CLI positional to a brief YAML path. A `.yaml`/`.yml` input is taken
 * as-is. Otherwise it names a processed idea (path-like as given, or a bare slug
 * under `ideas/processed/`); if the throwaway brief already exists it is returned,
 * else a skeleton is scaffolded (which exits).
 */
function resolveBriefPath(input: string, topN: number): string {
  if (input.endsWith(".yaml") || input.endsWith(".yml")) {
    return input;
  }
  // Path-like (contains '/' or leading '.') → take as-is; bare basename → join under ideas/processed/.
  const isPathLike = input.includes("/") || input.startsWith(".");
  let mdPath: string;
  if (isPathLike) {
    mdPath = input;
  } else {
    const leaf = input.endsWith(".md") || input.endsWith(".markdown") ? input : `${input}.md`;
    mdPath = join(REPO_ROOT, "ideas", "processed", leaf);
  }
  const slug = slugFromProcessedPath(mdPath);
  const briefPath = join(BRIEF_TMP_DIR, `${slug}.yaml`);
  if (existsSync(briefPath)) {
    return briefPath;
  }
  scaffoldBriefFromProcessed(mdPath, briefPath, topN);
}

// ---------- core orchestration ----------

/**
 * Read + parse a brief YAML into a typed {@link Brief}. On a zod validation error,
 * print the issue list (mirroring the Python `ValidationError` listing) and die.
 */
export function readBrief(path: string): Brief {
  if (!existsSync(path)) {
    die(`brief not found: ${path}`);
  }
  let data: unknown;
  try {
    data = yamlParse(readFileSync(path, "utf8"));
  } catch (exc) {
    if (exc instanceof YAMLParseError) {
      // The classic hand-edit break: an unquoted value containing ": " reads as a
      // nested mapping. Surface the offending line + the fix instead of the raw
      // "Nested mappings are not allowed in compact mappings" trace.
      const where = exc.linePos?.[0] ? ` (line ${exc.linePos[0].line})` : "";
      die(
        `brief is not valid YAML${where}: ${exc.message.split("\n")[0]}\n` +
          '  fix: wrap any value containing a colon-space (": ") in double quotes, ' +
          'e.g. text: "Protect earned trust: start free"',
      );
    }
    throw exc;
  }
  try {
    return parseBrief(data);
  } catch (exc) {
    if (exc instanceof z.ZodError) {
      const lines = exc.errors.map((e) => `  - ${e.path.map((p) => String(p)).join(".")}: ${e.message}`);
      die("brief failed validation:\n" + lines.join("\n"));
    }
    throw exc;
  }
}

/**
 * Fail before any Google Ads mutation if a destination URL 404s (or is otherwise
 * unreachable). Catches the classic /ideas/ prefix slip and leftover TODO slugs.
 */
async function assertFinalUrlsReachable(brief: Brief): Promise<void> {
  const failures = await unreachableUrls(brief);
  if (failures.length > 0) {
    const lines = failures.map(([url, reason]) => `  - ${url} → ${reason}`);
    die(
      "final URL check failed — these destinations don't resolve (fix the brief, " +
        "or pass --skip-url-check to bypass):\n" + lines.join("\n"),
    );
  }
}

/**
 * Resolve the customer id from the brief, then env, then google-ads.yaml (via
 * {@link resolveCustomer}). Dies if nothing resolves.
 */
export function customerIdFor(brief: Brief): string {
  const chosen = resolveCustomer([brief.customerId, process.env["GOOGLE_ADS_CUSTOMER_ID"]]);
  if (!chosen) {
    die("no customerId in brief, GOOGLE_ADS_CUSTOMER_ID env, or login_customer_id in google-ads.yaml");
  }
  return chosen;
}

/**
 * Parse the `--top-n N` flag from `argv`, defaulting to {@link DEFAULT_TOP_N}. Dies
 * on a non-integer or out-of-range value (must be 1..{@link MAX_KEYWORDS_PER_THEME}).
 */
export function parseTopN(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--top-n" && i + 1 < argv.length) {
      const raw = argv[i + 1]!;
      // Reject anything that isn't a clean integer (Python int() semantics).
      const v = /^[+-]?\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : NaN;
      if (Number.isNaN(v)) {
        die(`--top-n: expected integer, got ${JSON.stringify(raw)}`);
      }
      if (!(v >= 1 && v <= MAX_KEYWORDS_PER_THEME)) {
        die(`--top-n: must be between 1 and ${MAX_KEYWORDS_PER_THEME} (keywords per theme), got ${v}`);
      }
      return v;
    }
  }
  return DEFAULT_TOP_N;
}

/**
 * Scaffold/validate/publish the brief named by `argv`. Returns a process exit code:
 * 0 on success (incl. dry-run), 1 on a publish failure. Dies (via {@link ExitError})
 * on bad args / validation / URL failures, which this catches and turns into a code.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const positionals = argv.filter((a) => !a.startsWith("--"));
    if (positionals.length === 0) {
      die("usage: ads.sh create <idea-slug|brief.yaml> [--dry-run] [--top-n N]");
    }

    const dryRun = argv.includes("--dry-run");
    const archiveExisting = argv.includes("--archive-existing");
    const skipUrlCheck = argv.includes("--skip-url-check");
    const topN = parseTopN(argv);

    const briefPath = resolveBriefPath(positionals[0]!, topN);
    const brief = readBrief(briefPath);

    if (!skipUrlCheck) {
      await assertFinalUrlsReachable(brief);
    }

    const customerId = customerIdFor(brief);
    const agNames = brief.adGroups.map((ag) => ag.name);

    const keywordCount = brief.adGroups.reduce((n, ag) => n + ag.keywords.length, 0);

    // Stage the brief against its adbriefs/ source of truth and surface the diff
    // BEFORE any publish — the review-the-change gate (dry-run shows it, --apply
    // via a non-dry-run run confirms it). Resolved from the live cwd (the repo/worktree
    // root the skill runs from) so a test can redirect it.
    const adbriefsRoot = process.cwd();
    const adbriefsPath = briefPathForCampaign(adbriefsRoot, brief);
    const statePath = statePathForCampaign(adbriefsRoot, brief);
    // Surface a slug collision with a *different* campaign here — in dry-run too — so the
    // review-the-change gate catches it, not just the real publish (FR-008). Otherwise the
    // diff below would compare two unrelated campaigns and read as nonsense.
    try {
      assertNoForeignBrief(adbriefsRoot, brief);
    } catch (exc) {
      if (exc instanceof AdbriefsError) {
        die(exc.message);
      }
      throw exc;
    }
    const existingBrief = loadBriefIfExists(adbriefsRoot, brief);
    const briefDiff = diffBriefs(existingBrief, brief);
    if (briefDiff.changed) {
      process.stderr.write(
        `${existingBrief === null ? "new" : "changed"} adbriefs brief ${adbriefsPath} ` +
          `(+${briefDiff.added}/-${briefDiff.removed}):\n${briefDiff.render}\n`,
      );
    } else {
      process.stderr.write(`adbriefs brief ${adbriefsPath} unchanged\n`);
    }

    if (dryRun) {
      emitJson({
        ok: true,
        dryRun: true,
        customerIdUsed: customerId,
        adGroupCount: brief.adGroups.length,
        adGroups: agNames,
        keywordCount,
        keywordWarning: keywordCountWarning(keywordCount),
        sitelinkCount: brief.campaign.sitelinks.length,
        calloutCount: brief.campaign.callouts.length,
        briefPath: adbriefsPath,
        briefDiff: { changed: briefDiff.changed, added: briefDiff.added, removed: briefDiff.removed },
        willWriteBrief: adbriefsPath,
        // The state file (name ↔ live ids) is written after a successful publish, once
        // Google has assigned the ids — so a dry-run only announces the intent.
        willWriteState: statePath,
        willPublish:
          `budget → campaign(PAUSED) → ${brief.campaign.sitelinks.length} sitelinks → ` +
          `${brief.campaign.callouts.length} callouts → ${agNames.length}x ` +
          `(ad-group → RSA(PAUSED) → keywords). Existing campaign of the same name is reused.`,
      });
      return 0;
    }

    // Persist the brief to adbriefs/ as the local source of truth BEFORE publishing
    // (FR-001). A slug collision with a different campaign is refused here, not silently
    // overwritten (FR-008).
    try {
      writeBrief(adbriefsRoot, brief);
    } catch (exc) {
      if (exc instanceof AdbriefsError) {
        die(exc.message);
      }
      throw exc;
    }

    const client = loadClient();
    const outcome = await publishV1(client, customerId, brief, archiveExisting);

    // On a successful publish, persist the live-id state file (name ↔ campaignId/
    // adGroupId/adId) beside the intent brief. This is what lets `/adkit update` later
    // resolve a plan's ids back to brief entities and stage a change into the brief
    // (see src/adbriefs/state.ts). Only written on success — a partial publish has no
    // complete id set to record.
    const stateSynced = outcome.failure === null;
    if (stateSynced) {
      writeState(adbriefsRoot, brief, buildState(brief, outcome.results));
    }

    emitJson({
      ok: outcome.failure === null,
      status: outcome.failure === null ? "success" : "failed",
      customerIdUsed: customerId,
      created: outcome.results,
      failure: outcome.failure,
      briefPath: adbriefsPath,
      statePath: stateSynced ? statePath : null,
      // The brief was written before publish, so it reflects the intended state; on a
      // failure the envelope's `failure` is the brief↔live divergence signal (FR-010).
      briefSynced: outcome.failure === null,
      stateSynced,
      note: `Campaign + RSAs created PAUSED. Brief persisted at ${adbriefsPath} (local source of truth; manage live via the Ads UI / /adkit audit).`,
    });
    return outcome.failure === null ? 0 : 1;
  } catch (exc) {
    if (exc instanceof ExitError) {
      return exc.code;
    }
    throw exc;
  }
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      emitJson(errorEnvelope(formatGoogleAdsError(err)));
      process.exit(1);
    });
}
