/**
 * adkit — public API.
 *
 * The library surface for managing Google Ads search campaigns: the Brief schema
 * and validators, the Google Ads client abstraction, the publish path, and every
 * pure analysis helper (audit scoring, keyword clustering, report metrics, keyword
 * merging, markdown formatting, GAQL builders). The CLI entrypoints live under
 * `bin/` and are exposed as package `bin` scripts, not from this barrel.
 */

// --- Brief schema, types, and validators ---
export {
  AD_NAME_PATTERN,
  AdGroupSchema,
  AdGroupStatusChangeSchema,
  BID_STRATEGIES,
  BriefSchema,
  CampaignSchema,
  CampaignStatusChangeSchema,
  CUSTOMER_ID_PATTERN,
  DescriptionSchema,
  FAILURE_STEPS,
  HeadlineSchema,
  KeywordSchema,
  MATCH_TYPES,
  MAX_AD_GROUPS,
  parseBrief,
  PriceAssetSchema,
  ResponsiveSearchAdSchema,
  SitelinkSchema,
  StructuredSnippetAssetSchema,
} from "./lib/schema.js";
export type {
  AdGroup,
  AdGroupStatusChange,
  BidStrategy,
  Brief,
  Campaign,
  CampaignStatusChange,
  Description,
  Failure,
  FailureStep,
  Headline,
  Keyword,
  PriceAsset,
  PriceOffering,
  ResponsiveSearchAd,
  Sitelink,
  StructuredSnippetAsset,
} from "./lib/schema.js";

// --- Google Ads client abstraction + credentials ---
export {
  credentialsPath,
  customerIdFromYaml,
  DEFAULT_CREDENTIALS_PATH,
  KEEP_YAML_LOGIN,
  loadClient,
} from "./lib/auth.js";
export type { AdsClient, AdsMutateOperation, GaqlRow, GaqlValue, MutateResult } from "./lib/auth.js";

// --- Publish path ---
export { makeExecResults, makeRunOutcome, publishV1 } from "./ads/publish.js";
export type { ExecAdGroup, ExecResults, RunOutcome } from "./ads/publish.js";
export { formatGoogleAdsError, sdkVersion, StepError, step } from "./ads/errors.js";

// --- Differentiation profile (dynamic me-too-copy reference) ---
export {
  DifferentiationAxisSchema,
  DifferentiationProfileSchema,
  EMPTY_PROFILE,
  parseDifferentiationProfile,
} from "./lib/brand.js";
export type { DifferentiationAxis, DifferentiationProfile } from "./lib/brand.js";

// --- Audit scoring (pure) ---
export {
  cannibalization,
  conceptWords,
  differentiationGaps,
  IS_OPPORTUNITY,
  LOST_HI,
  MIN_CALLOUTS,
  MIN_DESCRIPTIONS,
  MIN_HEADLINES,
  MIN_SITELINKS,
  pathToExcellent,
  requireDigits,
  SHARED_HEADLINE_GROUPS,
  TIER_NAMES,
} from "./audit/scoring.js";
export type { CannibalizationPair, DifferentiationGap, ServingCampaign } from "./audit/scoring.js";

// --- Keyword clustering (pure) ---
export { clusterSplitRecommendation, keywordsToPromote, negativesToAdd } from "./lib/cluster.js";
export type { Negative, Proposal, SplitRecommendation } from "./lib/cluster.js";

// --- Report metrics + GAQL builders (pure) ---
export { metricDict, microsToCurrency, remediationHint, safeRatio } from "./lib/report.js";
export * from "./gaql/builders.js";
export { gaqlId, gaqlString } from "./gaql/escape.js";

// --- Keyword merge + display formatting (pure) ---
export { comparisonKey, MAX_KEYWORD_CHARS, MIN_VOLUME, unionCandidates } from "./lib/merge.js";
export type { ApiIdea, Candidate } from "./lib/merge.js";
export { formatBulletText } from "./lib/markdown.js";
export { competitionLabel, formatCpcRange, formatVolume } from "./lib/metrics.js";

// --- Idea parsing (pure) + URL reachability ---
export {
  DEFAULT_TOP_N,
  extractNegatives,
  MAX_KEYWORDS_PER_THEME,
  readThemeGroups,
  slugFromProcessedPath,
} from "./ideas/parse.js";
export { finalUrls, unreachableUrls, urlUnreachableReason } from "./ideas/urls.js";

// --- Fixes-plan validation (pure) ---
export { validate as validateFixesPlan } from "./fixes/plan.js";

// --- CLI helpers ---
export { emitJson, errorEnvelope, ok, sdkErrorMessage } from "./cli/output.js";
export { normalizeId, resolveCustomer } from "./cli/args.js";
