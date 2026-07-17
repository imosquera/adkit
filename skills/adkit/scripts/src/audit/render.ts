/**
 * stderr rendering for /adkit audit — every render* function is a pure
 * `data -> string[]` transform; the IO shell (bin/audit.ts) is the only place that
 * actually prints (via {@link emitLines}). No SDK, no clock, no mutation.
 */

import type { CannibalizationPair } from "./scoring.js";
import type { keywordsToPromote, negativesToAdd } from "../lib/cluster.js";
import type {
  CampaignReport,
  ClusterSplit,
  KeywordCpc,
  LandingPageEntry,
  QualityScoreEntry,
  ScoredServing,
} from "./types.js";

export function emitLines(lines: string[]): void {
  for (const line of lines) {
    process.stderr.write(line + "\n");
  }
}

/** Format a fraction as a whole-percent string, matching Python `f"{x*100:.0f}%"`. */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Left-pad/truncate-free right-fill, matching Python `f"{s:<width}"`. */
export function ljust(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Right-justify, matching Python `f"{s:>width}"`. */
export function rjust(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function renderCreativeSummary(report: CampaignReport[]): string[] {
  function campaignLines(c: CampaignReport): [string[], number] {
    const badAds = c.ads.filter((a) => a.issues.length > 0);
    const header = [
      `\n${c.campaignName} (${c.campaignId}) [${c.status}] ` +
        `keywords=${c.keywords} sitelinks=${c.sitelinks} callouts=${c.callouts}`,
    ];
    const findingLines = c.campaignFindings.map((f) => `  ! ${f.issue}: ${f.detail}`);
    const adLines = c.ads.flatMap((a) => [
      `    [${ljust(a.strength, 9)}] ${ljust(a.adGroup, 34)} ${a.headlines.length}H/${a.descriptions.length}D  ` +
        `${a.issues.map((i) => i.issue).join(", ") || "ok"}`,
      ...(a.strength !== "EXCELLENT"
        ? a.pathToExcellent.map((step) => `        -> ${step}`)
        : []),
    ]);
    return [
      [...header, ...findingLines, ...adLines],
      c.campaignFindings.length + badAds.length,
    ];
  }

  const perCampaign = report.map(campaignLines);
  const lines = perCampaign.flatMap(([cl]) => cl);
  const total = perCampaign.reduce((sum, [, count]) => sum + count, 0);
  return [...lines, `\n${total} creative findings across ${report.length} campaigns`];
}

export function renderImpressionShare(
  serving: ScoredServing[],
  cannib: CannibalizationPair[],
  days: number,
): string[] {
  function row(c: ScoredServing): string[] {
    const tag = c.flags.join(", ") || "serving";
    const isPct = c.impressions ? pct(c.searchImpressionShare) : "  -";
    const lb = pct(c.lostISBudget);
    const lr = pct(c.lostISRank);
    return [
      `    ${ljust(c.campaignName, 34)} impr=${rjust(String(c.impressions), 6)} IS=${rjust(isPct, 4)} ` +
        `lostBudget=${rjust(lb, 4)} lostRank=${rjust(lr, 4)} conv=${c.conversions.toFixed(0)} [${tag}]`,
      ...c.impressionShareRecs.map((rec) => `        -> ${rec}`),
    ];
  }

  return [
    `\n=== IMPRESSION SHARE (last ${days} days) ===`,
    ...serving.flatMap(row),
    ...cannib.map(
      (p) =>
        `  ~ cannibalization: ${p.a} <> ${p.b} share ${JSON.stringify(p.shared)} (starved: ${p.starvedLikely})`,
    ),
  ];
}

export function renderKeywordCpc(
  serving: ScoredServing[],
  keywordCpcMap: Record<number, KeywordCpc[]>,
  splits: ClusterSplit[],
  days: number,
): string[] {
  function row(c: ScoredServing): string[] {
    const kws = keywordCpcMap[c.campaignId] ?? [];
    if (kws.length === 0) {
      return [];
    }
    const top = kws
      .slice(0, 3)
      .map((k) => `${k.text} $${k.avg_cpc.toFixed(2)}`)
      .join(", ");
    return [`    ${ljust(c.campaignName, 34)} top CPC: ${top}`];
  }

  return [
    `\n=== KEYWORD CPC (last ${days} days) ===`,
    ...serving.flatMap(row),
    ...splits.map((s) => `  ! cluster split: ${s.campaignName} — ${s.reason as string}`),
  ];
}

export function renderSearchTermCandidates(
  addNegatives: Record<number, ReturnType<typeof negativesToAdd>>,
  promoteKeywords: Record<number, ReturnType<typeof keywordsToPromote>>,
  names: Record<number, string>,
  days: number,
): string[] {
  function negativesRow(cid: number, negs: ReturnType<typeof negativesToAdd>): string {
    const top = negs
      .slice(0, 5)
      .map((n) => `${n.text} ($${n.cost.toFixed(2)})`)
      .join(", ");
    const wasted = negs.reduce((sum, n) => sum + n.cost, 0);
    return `    ${ljust(names[cid] ?? String(cid), 34)} $${wasted.toFixed(2)} wasted / ${negs.length} terms: ${top}`;
  }

  function promoteRow(cid: number, proms: ReturnType<typeof keywordsToPromote>): string {
    const top = proms
      .slice(0, 5)
      .map((p) => `${p.text} (${p.conversions.toFixed(0)} conv)`)
      .join(", ");
    return `    ${ljust(names[cid] ?? String(cid), 34)} ${proms.length} terms: ${top}`;
  }

  const negativesSection =
    Object.keys(addNegatives).length > 0
      ? [
          `\n=== SEARCH-TERM WASTE → NEGATIVE CANDIDATES (last ${days} days) ===`,
          ...Object.entries(addNegatives).map(([cid, negs]) => negativesRow(Number(cid), negs)),
        ]
      : [];
  const promoteSection =
    Object.keys(promoteKeywords).length > 0
      ? [
          `\n=== CONVERTING SEARCH TERMS → PROMOTE CANDIDATES (last ${days} days) ===`,
          ...Object.entries(promoteKeywords).map(([cid, proms]) => promoteRow(Number(cid), proms)),
        ]
      : [];
  return [...negativesSection, ...promoteSection];
}

export function renderQualityScoreSection(
  title: string,
  component: "landingPageExp" | "adRelevance" | "expectedCtr",
  qualityScoreMap: Record<number, QualityScoreEntry[]>,
  campNames: Record<number, string>,
): string[] {
  const bad: Record<number, QualityScoreEntry[]> = Object.fromEntries(
    Object.entries(qualityScoreMap)
      .map(([cid, kws]): [number, QualityScoreEntry[]] => [
        Number(cid),
        kws.filter((k) => k[component] === "BELOW_AVERAGE"),
      ])
      .filter(([, kws]) => kws.length > 0),
  );
  if (Object.keys(bad).length === 0) {
    return [];
  }

  function row(cid: number, kws: QualityScoreEntry[]): string {
    const top = kws
      .slice(0, 5)
      .map((k) => `${k.keyword} (QS ${k.qualityScore})`)
      .join(", ");
    return `    ${ljust(campNames[cid] ?? String(cid), 34)} ${kws.length} keywords: ${top}`;
  }

  return [
    `\n=== ${title} ===`,
    ...Object.entries(bad).map(([cid, kws]) => row(Number(cid), kws)),
  ];
}

export function renderLandingPageHealth(
  landingPageHealth: Record<number, LandingPageEntry[]>,
  campNames: Record<number, string>,
): string[] {
  if (Object.keys(landingPageHealth).length === 0) {
    return [];
  }
  return [
    `\n=== LANDING PAGE HEALTH ===`,
    ...Object.entries(landingPageHealth).flatMap(([cidStr, items]) => {
      const cid = Number(cidStr);
      return [
        `    ${ljust(campNames[cid] ?? String(cid), 34)} ${items.length} issue(s):`,
        ...items.map((it) => `        -> [${it.issue}] ${it.url}: ${it.detail}`),
      ];
    }),
  ];
}
