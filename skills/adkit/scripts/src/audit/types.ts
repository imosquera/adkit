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

export interface LandingPageEntry {
  url: string | null;
  issue: string;
  detail: string;
  [key: string]: unknown;
}
