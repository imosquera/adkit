/**
 * PageSpeed Insights (PSI) diagnosis — the pure half of issue #22's landing-page
 * loop-closer. When /adkit audit reports a below-average landing-page experience,
 * the IO shell (bin/audit.ts `runPsi`) fetches PSI mobile results per distinct
 * final URL; this module owns everything that is NOT network I/O:
 *
 *   - {@link buildPsiRequestUrl}   — shape the runPagespeed request URL (pure).
 *   - {@link parsePsiResponse}     — parse the untrusted PSI JSON at the boundary
 *                                    (zod), returning a discriminated {@link PsiResult}.
 *   - {@link belowAverageFinalUrls} — pure selection: which distinct final URLs to
 *                                    diagnose, given the quality-score + ad reports.
 *
 * No SDK import, no `fetch`, no filesystem — this file is unit-testable without a
 * network. The credential is operator-supplied (PAGESPEED_API_KEY / --psi-key);
 * this module never creates or deletes a GCP key (spec Clarifications 2026-07-18).
 */

import { z } from "zod";
import type {
  CampaignReport,
  PsiOpportunity,
  PsiResult,
  QualityScoreEntry,
} from "../audit/types.js";

/** Google's public PageSpeed Insights v5 REST endpoint (path is `pagespeedonline/v5`). */
export const PSI_ENDPOINT = "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";

/** Google's below-average landing-page-experience bucket (the issue's "≤ 2"). */
export const BELOW_AVERAGE = "BELOW_AVERAGE";

/**
 * Build the runPagespeed request URL for one final URL (mobile, performance).
 * Pure string shaping — the caller does the `fetch`.
 */
export function buildPsiRequestUrl(finalUrl: string, apiKey: string): string {
  const params = new URLSearchParams({
    url: finalUrl,
    strategy: "mobile",
    category: "performance",
    key: apiKey,
  });
  return `${PSI_ENDPOINT}?${params.toString()}`;
}

// The minimal slice of the PSI response the audit reads. Everything is optional /
// nullable so a partial-but-valid response never fails the parse — only a
// structurally wrong blob (non-object) does.
const opportunityItem = z
  .object({ wastedMs: z.number().nullish() })
  .passthrough();

const audit = z
  .object({
    numericValue: z.number().nullish(),
    title: z.string().nullish(),
    details: z.object({ items: z.array(opportunityItem).nullish() }).nullish(),
  })
  .passthrough();

const psiResponseSchema = z
  .object({
    lighthouseResult: z
      .object({
        audits: z.record(z.string(), audit).nullish(),
      })
      .nullish(),
  })
  .passthrough();

function opportunitiesFrom(a: z.infer<typeof audit> | undefined): PsiOpportunity[] {
  const items = a?.details?.items ?? [];
  return items.map((it): PsiOpportunity => ({
    title: a?.title ?? "",
    savingsMs: it.wastedMs ?? null,
  }));
}

/**
 * Parse the untrusted PSI JSON for one URL into a discriminated {@link PsiResult}.
 * A structurally invalid blob returns `{ ok: false, url, error }` rather than
 * throwing — the boundary parser, never a re-check downstream.
 */
export function parsePsiResponse(url: string, raw: unknown): PsiResult {
  const parsed = psiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, url, error: `unparseable PSI response: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  }
  const audits = parsed.data.lighthouseResult?.audits ?? {};
  const lcp = audits["largest-contentful-paint"]?.numericValue;
  return {
    ok: true,
    url,
    lcpMs: lcp ?? null,
    renderBlocking: opportunitiesFrom(audits["render-blocking-resources"]),
    unusedJs: opportunitiesFrom(audits["unused-javascript"]),
  };
}

/**
 * Pure selection: the distinct, non-null final URLs to diagnose. Scoped to the
 * campaigns that actually have a below-average landing-page keyword — quality-score
 * rows carry no URL, so within an affected campaign the audit diagnoses that
 * campaign's ads' final URLs (matching the issue's "auto-run PSI on each ad's
 * final URL"), but a healthy campaign's URLs are never dragged in by an unrelated
 * campaign's flag. Deduped so a URL shared across ad groups is hit at most once.
 * Returns `[]` when no campaign qualifies or none of its ads have a final URL.
 */
export function belowAverageFinalUrls(
  qualityScoreMap: Record<number, QualityScoreEntry[]>,
  report: CampaignReport[],
): string[] {
  const affected = new Set(
    Object.entries(qualityScoreMap)
      .filter(([, kws]) => kws.some((k) => k.landingPageExp === BELOW_AVERAGE))
      .map(([cid]) => Number(cid)),
  );
  if (affected.size === 0) {
    return [];
  }
  const urls = report
    .filter((c) => affected.has(c.campaignId))
    .flatMap((c) => c.ads)
    .map((a) => a.finalUrl)
    .filter((u): u is string => u !== null && u.length > 0);
  return [...new Set(urls)];
}
