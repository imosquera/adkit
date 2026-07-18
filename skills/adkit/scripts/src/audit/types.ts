/**
 * Output-shape types for the /adkit audit skill — the scored dicts the audit
 * orchestration produces and the renderers consume. Kept in one module so the
 * scoring layer (bin/audit.ts) and the stderr renderers (audit/render.ts) share a
 * single definition instead of a cross-file `import type` cycle.
 */

export type AdIssue = Record<string, unknown>;

export interface ScoredAd {
  adId: number;
  adGroup: string;
  strength: string;
  status: string;
  headlines: string[];
  descriptions: string[];
  finalUrl: string | null;
  actionItems: string[];
  issues: AdIssue[];
  keywords: string[];
  pathToExcellent: string[];
}

export interface CampaignFinding {
  level: string;
  issue: string;
  detail: string;
  need?: number;
  items?: Record<string, string[]>;
}

export interface CampaignReport {
  campaignId: number;
  campaignName: string;
  status: string;
  keywords: number;
  sitelinks: number;
  callouts: number;
  campaignFindings: CampaignFinding[];
  ads: ScoredAd[];
}

export interface ScoredServing {
  campaignId: number;
  campaignName: string;
  bidStrategy: string;
  budgetMicros: number;
  impressions: number;
  conversions: number;
  searchImpressionShare: number;
  lostISBudget: number;
  lostISRank: number;
  flags: string[];
  impressionShareRecs: string[];
}

export interface KeywordCpc {
  text: string;
  avg_cpc: number;
  avg_cpc_micros: number;
  // adGroupId + matchType let a keyword pause/update plan be authored straight
  // from the audit JSON (no /adkit report round-trip). matchType is null when a
  // criterion has no populated match type. (issue #22)
  adGroupId: number;
  matchType: string | null;
  // These rows feed the generic (Record-consuming) cluster helpers.
  [key: string]: unknown;
}

export interface ClusterSplit {
  campaignId: number;
  campaignName: string;
  [key: string]: unknown;
}

export interface SearchTermAgg {
  search_term: string;
  clicks: number;
  conversions: number;
  cost: number;
  impressions: number;
  // These rows feed the generic (Record-consuming) cluster helpers.
  [key: string]: unknown;
}

export interface QualityScoreEntry {
  keyword: string;
  qualityScore: number;
  landingPageExp: string;
  adRelevance: string;
  expectedCtr: string;
}

/** One PageSpeed Insights opportunity row (render-blocking / unused-JS). */
export interface PsiOpportunity {
  title: string;
  savingsMs: number | null;
}

/** A successful PageSpeed Insights (mobile) diagnosis for one final URL. */
export interface PsiDiagnosis {
  ok: true;
  url: string;
  lcpMs: number | null;
  renderBlocking: PsiOpportunity[];
  unusedJs: PsiOpportunity[];
}

/** PSI could not be obtained for this URL (network / parse / rate-limit). */
export interface PsiFailure {
  ok: false;
  url: string;
  error: string;
}

/** Tagged on `ok` so renderers/JSON handle success vs failure without a null soup. */
export type PsiResult = PsiDiagnosis | PsiFailure;

export interface LandingPageEntry {
  url: string | null;
  issue: string;
  detail: string;
  [key: string]: unknown;
}
