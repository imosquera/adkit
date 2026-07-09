/**
 * Final-URL collection + reachability for the /adkit create scaffold.
 *
 * `finalUrls(brief)` is pure (no network) — it just enumerates the brief's
 * destination URLs, so it is unit-testable without touching the wire. The actual
 * HEAD/GET probe lives in `urlUnreachableReason` (its natural home), and
 * `unreachableUrls` composes the two: collect, probe each, return failures.
 *
 * No stdout, no sys.exit — bin/create formats and dies on the failure list.
 */

import type { Brief } from "../lib/schema.js";

/**
 * Every destination URL the brief publishes: one per RSA + one per sitelink.
 * Deduped, order-preserving.
 */
export function finalUrls(brief: Brief): string[] {
  const rsaUrls = brief.adGroups.map((ag) => String(ag.responsiveSearchAd.finalUrl));
  const sitelinkUrls = brief.campaign.sitelinks.map((sl) => String(sl.finalUrl));
  return [...new Set([...rsaUrls, ...sitelinkUrls])];
}

/**
 * `null` if the URL resolves (status < 400, redirects followed); else a short
 * reason. HEAD first, fall back to GET when the host rejects HEAD.
 */
export async function urlUnreachableReason(url: string): Promise<string | null> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const resp = await fetch(url, {
        method,
        redirect: "follow",
        headers: { "User-Agent": "ads-skill-urlcheck" },
        signal: AbortSignal.timeout(10_000),
      });
      // Some servers reject HEAD with 403/405 — retry with GET.
      if ((resp.status === 403 || resp.status === 405) && method === "HEAD") {
        continue;
      }
      return resp.status < 400 ? null : `HTTP ${resp.status}`;
    } catch (exc) {
      // DNS, timeout, TLS, etc. — surface the error's type name.
      return exc instanceof Error ? exc.name : String(exc);
    }
  }
  return null;
}

/**
 * The brief's destination URLs that don't resolve, as [url, reason] pairs.
 * Empty when every URL is reachable. Catches the classic /ideas/ prefix slip
 * and leftover TODO slugs before any Google Ads mutation runs.
 */
export async function unreachableUrls(brief: Brief): Promise<Array<[string, string]>> {
  const probed = await Promise.all(
    finalUrls(brief).map(async (url): Promise<[string, string | null]> => [url, await urlUnreachableReason(url)]),
  );
  return probed.filter((pair): pair is [string, string] => pair[1] !== null);
}
