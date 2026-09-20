/**
 * Zero-impression serving diagnosis — the pure half.
 *
 * `ads.sh audit` already says a campaign got zero impressions (`zero_impressions`).
 * That is the symptom the operator already knew. This module turns the
 * serving-eligibility rows (campaign + budget, ad groups, ads + policy, keywords,
 * campaign criteria, shared negative lists, billing) into a ranked list of
 * {@link Blocker}s — named causes, each with a fix — or the explicit
 * `no_blocker_found` verdict that tells the operator to stop hunting for a switch.
 *
 * Everything here is pure: rows in, diagnosis out. The queries + degradation live
 * in bin/audit.ts. Every enum is decoded to its string name at this boundary
 * (requirement #1 of issue "audit must explain a zero-impression campaign") — a
 * bare `status: 2` is unusable in a report and is exactly why the previous audit
 * JSON could not answer "paused or disapproved?".
 */

import { enums } from "google-ads-api";
import { enumName } from "../ads/enums.js";

// ---------------------------------------------------------------------------
// Output shapes.
// ---------------------------------------------------------------------------

export interface Blocker {
  code: string;
  detail: string;
  fix: string;
}

export interface AdGroupDiagnosis {
  id: number;
  name: string;
  status: string | null;
  primaryStatus: string | null;
  primaryStatusReasons: string[];
  eligibleAds: number;
  pausedAds: number;
  disapprovedAds: number;
  underReviewAds: number;
  eligibleKeywords: number;
  rarelyServedKeywords: number;
  disapprovedKeywords: number;
}

export interface Disapproval {
  adId: number;
  adGroup: string;
  approvalStatus: string | null;
  reviewStatus: string | null;
  policyTopics: string[];
}

export interface ProximityTarget {
  radius: number;
  units: string | null;
  city: string | null;
  postalCode: string | null;
}

export interface ServingDiagnosis {
  campaign: {
    status: string | null;
    servingStatus: string | null;
    primaryStatus: string | null;
    primaryStatusReasons: string[];
    startDate: string | null;
    endDate: string | null;
    budget: { amountMicros: number; status: string | null; deliveryMethod: string | null };
    networks: { googleSearch: boolean; searchPartners: boolean; display: boolean };
  };
  /** Absent (undefined) when billing_setup was not readable — see `notes`. */
  billing?: { status: string | null };
  adGroups: AdGroupDiagnosis[];
  disapprovals: Disapproval[];
  targeting: {
    locations: string[];
    proximity: ProximityTarget[];
    languages: string[];
    adSchedule: string[];
  };
  negatives: {
    campaignLevel: number;
    sharedSets: Array<{ name: string; memberCount: number }>;
    matchTypes: Record<string, number>;
  };
  blockers: Blocker[];
  /** Sections that degraded (a resource the developer token could not read). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Raw (wire) row shapes — loose, exactly as the API returns them.
// ---------------------------------------------------------------------------

type Enum = string | number | null | undefined;

export interface RawDiagnosisCampaignRow {
  campaign: {
    id: number;
    name?: string;
    status?: Enum;
    serving_status?: Enum;
    primary_status?: Enum;
    primary_status_reasons?: Enum[];
    start_date_time?: string | null;
    end_date_time?: string | null;
    network_settings?: {
      target_google_search?: boolean;
      target_search_network?: boolean;
      target_content_network?: boolean;
    };
  };
  campaign_budget?: { amount_micros?: number; status?: Enum; delivery_method?: Enum };
}

export interface RawDiagnosisAdGroupRow {
  campaign: { id: number };
  ad_group: {
    id: number;
    name?: string;
    status?: Enum;
    primary_status?: Enum;
    primary_status_reasons?: Enum[];
  };
}

export interface RawDiagnosisAdRow {
  campaign: { id: number };
  ad_group: { id: number; name?: string };
  ad_group_ad: {
    ad: { id: number };
    status?: Enum;
    primary_status?: Enum;
    primary_status_reasons?: Enum[];
    policy_summary?: {
      approval_status?: Enum;
      review_status?: Enum;
      policy_topic_entries?: Array<{ topic?: string }>;
    };
  };
}

export interface RawDiagnosisKeywordRow {
  campaign: { id: number };
  ad_group: { id: number };
  ad_group_criterion: {
    negative?: boolean;
    status?: Enum;
    approval_status?: Enum;
    system_serving_status?: Enum;
    keyword?: { text?: string; match_type?: Enum };
  };
}

export interface RawCampaignCriterionRow {
  campaign: { id: number };
  campaign_criterion: {
    type?: Enum;
    negative?: boolean;
    status?: Enum;
    display_name?: string;
    keyword?: { text?: string; match_type?: Enum };
    location?: { geo_target_constant?: string };
    proximity?: {
      radius?: number;
      radius_units?: Enum;
      address?: { city_name?: string; postal_code?: string };
    };
    language?: { language_constant?: string };
    ad_schedule?: { day_of_week?: Enum; start_hour?: number; end_hour?: number };
  };
}

export interface RawSharedSetRow {
  campaign: { id: number };
  shared_set: { id?: number; name?: string; type?: Enum; member_count?: number };
}

export interface RawSharedCriterionRow {
  shared_set: { id?: number };
  shared_criterion: { keyword?: { text?: string; match_type?: Enum } };
}

export interface RawBillingRow {
  billing_setup: { status?: Enum };
}

/** Everything one campaign's diagnosis is derived from; `billing: null` = unreadable. */
export interface DiagnosisRows {
  campaign: RawDiagnosisCampaignRow;
  adGroups: RawDiagnosisAdGroupRow[];
  ads: RawDiagnosisAdRow[];
  keywords: RawDiagnosisKeywordRow[];
  campaignCriteria: RawCampaignCriterionRow[];
  sharedSets: RawSharedSetRow[];
  sharedNegatives: RawSharedCriterionRow[];
  billing: RawBillingRow | null;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Decoding helpers.
// ---------------------------------------------------------------------------

const name = enumName;
const names = (xs: Enum[] | undefined, table: Record<string | number, string | number>): string[] =>
  (xs ?? []).map((x) => name(table, x)).filter((x): x is string => x !== null);

/** Date part of a Google Ads date/date-time string ("2026-09-03T00:00:00" -> "2026-09-03"). */
const datePart = (s: string | null | undefined): string | null => (s ? s.slice(0, 10) : null);

const MILES_PER_KM = 0.621371;

/** A proximity radius in miles, whatever unit Google reported it in. */
export function radiusMiles(p: ProximityTarget): number {
  return p.units === "KILOMETERS" ? p.radius * MILES_PER_KM : p.radius;
}

/** Lowercased >0-length word tokens of a keyword/negative text. */
const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);

/**
 * True when `negative`'s tokens are all present in `keyword`'s tokens — i.e. the
 * negative would block that keyword's own traffic. Deterministic and match-type
 * agnostic on purpose: a PHRASE negative "programs" kills every "winter programs"
 * search regardless of how the positive is matched.
 */
export function negativeBlocks(negative: string, keyword: string): boolean {
  const kw = new Set(tokens(keyword));
  const neg = tokens(negative);
  return neg.length > 0 && neg.every((t) => kw.has(t));
}

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

const UNDER_REVIEW = new Set(["REVIEW_IN_PROGRESS", "UNDER_APPEAL"]);

interface AdView {
  adId: number;
  adGroupId: number;
  adGroup: string;
  status: string | null;
  approvalStatus: string | null;
  reviewStatus: string | null;
  policyTopics: string[];
}

function adViews(rows: RawDiagnosisAdRow[]): AdView[] {
  return rows.map((r) => {
    const ps = r.ad_group_ad.policy_summary;
    return {
      adId: r.ad_group_ad.ad.id,
      adGroupId: r.ad_group.id,
      adGroup: r.ad_group.name ?? String(r.ad_group.id),
      status: name(enums.AdGroupAdStatus, r.ad_group_ad.status),
      approvalStatus: name(enums.PolicyApprovalStatus, ps?.approval_status),
      reviewStatus: name(enums.PolicyReviewStatus, ps?.review_status),
      policyTopics: (ps?.policy_topic_entries ?? [])
        .map((e) => e.topic)
        .filter((t): t is string => Boolean(t)),
    };
  });
}

interface KeywordView {
  adGroupId: number;
  text: string;
  matchType: string | null;
  negative: boolean;
  status: string | null;
  approvalStatus: string | null;
  servingStatus: string | null;
}

function keywordViews(rows: RawDiagnosisKeywordRow[]): KeywordView[] {
  return rows.map((r) => {
    const c = r.ad_group_criterion;
    return {
      adGroupId: r.ad_group.id,
      text: c.keyword?.text ?? "",
      matchType: name(enums.KeywordMatchType, c.keyword?.match_type),
      negative: c.negative === true,
      status: name(enums.AdGroupCriterionStatus, c.status),
      approvalStatus: name(enums.AdGroupCriterionApprovalStatus, c.approval_status),
      servingStatus: name(enums.CriterionSystemServingStatus, c.system_serving_status),
    };
  });
}

function targetingOf(rows: RawCampaignCriterionRow[]): ServingDiagnosis["targeting"] {
  const typed = rows.map((r) => ({
    ...r.campaign_criterion,
    typeName: name(enums.CriterionType, r.campaign_criterion.type),
  }));
  const positive = typed.filter((c) => c.negative !== true);
  return {
    locations: positive
      .filter((c) => c.typeName === "LOCATION")
      .map((c) => c.display_name || c.location?.geo_target_constant || "")
      .filter(Boolean),
    proximity: positive
      .filter((c) => c.typeName === "PROXIMITY")
      .map((c) => ({
        radius: c.proximity?.radius ?? 0,
        units: name(enums.ProximityRadiusUnits, c.proximity?.radius_units),
        city: c.proximity?.address?.city_name ?? null,
        postalCode: c.proximity?.address?.postal_code ?? null,
      })),
    languages: positive
      .filter((c) => c.typeName === "LANGUAGE")
      .map((c) => c.display_name || c.language?.language_constant || "")
      .filter(Boolean),
    adSchedule: positive
      .filter((c) => c.typeName === "AD_SCHEDULE")
      .map((c) => {
        const day = name(enums.DayOfWeek, c.ad_schedule?.day_of_week) ?? "?";
        return `${day} ${c.ad_schedule?.start_hour ?? 0}-${c.ad_schedule?.end_hour ?? 0}`;
      }),
  };
}

function countBy(values: Array<string | null>): Record<string, number> {
  return values.reduce<Record<string, number>>(
    (acc, v) => (v === null ? acc : { ...acc, [v]: (acc[v] ?? 0) + 1 }),
    {},
  );
}

/**
 * Rows -> the full diagnosis for one campaign, blockers included.
 *
 * `today` is the run date (`YYYY-MM-DD`), injected so the start/end-date checks
 * stay pure and testable.
 */
export function buildServingDiagnosis(rows: DiagnosisRows, today: string): ServingDiagnosis {
  const cp = rows.campaign.campaign;
  const budget = rows.campaign.campaign_budget;
  const ns = cp.network_settings;
  const ads = adViews(rows.ads);
  const kws = keywordViews(rows.keywords);
  const campaignNegatives = rows.campaignCriteria
    .map((r) => r.campaign_criterion)
    .filter((c) => c.negative === true && c.keyword?.text);

  const adGroups: AdGroupDiagnosis[] = rows.adGroups.map((r) => {
    const g = r.ad_group;
    const mine = ads.filter((a) => a.adGroupId === g.id);
    const myKws = kws.filter((k) => k.adGroupId === g.id && !k.negative);
    return {
      id: g.id,
      name: g.name ?? String(g.id),
      status: name(enums.AdGroupStatus, g.status),
      primaryStatus: name(enums.AdGroupPrimaryStatus, g.primary_status),
      primaryStatusReasons: names(g.primary_status_reasons, enums.AdGroupPrimaryStatusReason),
      // "Eligible" means it can actually serve right now: enabled, not disapproved,
      // and not still sitting in review — an ad awaiting review shows zero
      // impressions exactly like a paused one, so counting it as eligible would
      // hide the ads_under_review blocker.
      eligibleAds: mine.filter(
        (a) =>
          a.status === "ENABLED" &&
          a.approvalStatus !== "DISAPPROVED" &&
          !(a.reviewStatus !== null && UNDER_REVIEW.has(a.reviewStatus)),
      ).length,
      pausedAds: mine.filter((a) => a.status === "PAUSED").length,
      disapprovedAds: mine.filter((a) => a.approvalStatus === "DISAPPROVED").length,
      underReviewAds: mine.filter((a) => a.reviewStatus !== null && UNDER_REVIEW.has(a.reviewStatus))
        .length,
      eligibleKeywords: myKws.filter(
        (k) => k.status === "ENABLED" && k.approvalStatus !== "DISAPPROVED",
      ).length,
      rarelyServedKeywords: myKws.filter((k) => k.servingStatus === "RARELY_SERVED").length,
      disapprovedKeywords: myKws.filter((k) => k.approvalStatus === "DISAPPROVED").length,
    };
  });

  const diagnosis: Omit<ServingDiagnosis, "blockers"> = {
    campaign: {
      status: name(enums.CampaignStatus, cp.status),
      servingStatus: name(enums.CampaignServingStatus, cp.serving_status),
      primaryStatus: name(enums.CampaignPrimaryStatus, cp.primary_status),
      primaryStatusReasons: names(cp.primary_status_reasons, enums.CampaignPrimaryStatusReason),
      startDate: datePart(cp.start_date_time),
      endDate: datePart(cp.end_date_time),
      budget: {
        amountMicros: budget?.amount_micros ?? 0,
        status: name(enums.BudgetStatus, budget?.status),
        deliveryMethod: name(enums.BudgetDeliveryMethod, budget?.delivery_method),
      },
      networks: {
        googleSearch: ns?.target_google_search === true,
        searchPartners: ns?.target_search_network === true,
        display: ns?.target_content_network === true,
      },
    },
    ...(rows.billing
      ? { billing: { status: name(enums.BillingSetupStatus, rows.billing.billing_setup.status) } }
      : {}),
    adGroups,
    disapprovals: ads
      .filter((a) => a.approvalStatus === "DISAPPROVED")
      .map((a) => ({
        adId: a.adId,
        adGroup: a.adGroup,
        approvalStatus: a.approvalStatus,
        reviewStatus: a.reviewStatus,
        policyTopics: a.policyTopics,
      })),
    targeting: targetingOf(rows.campaignCriteria),
    negatives: {
      campaignLevel: campaignNegatives.length,
      sharedSets: rows.sharedSets.map((s) => ({
        name: s.shared_set.name ?? "",
        memberCount: s.shared_set.member_count ?? 0,
      })),
      matchTypes: countBy(
        campaignNegatives.map((c) => name(enums.KeywordMatchType, c.keyword?.match_type)),
      ),
    },
    notes: rows.notes,
  };

  const negativeTexts = [
    ...campaignNegatives.map((c) => c.keyword?.text ?? ""),
    ...rows.sharedNegatives.map((s) => s.shared_criterion.keyword?.text ?? ""),
  ].filter(Boolean);

  return { ...diagnosis, blockers: deriveBlockers(diagnosis, kws, ads, negativeTexts, today) };
}

// ---------------------------------------------------------------------------
// Blocker derivation — the point of the whole layer.
// ---------------------------------------------------------------------------

const NARROW_RADIUS_MILES = 15;
/** Share of a campaign's keywords that must be RARELY_SERVED before it's the story. */
const RARELY_SERVED_SHARE = 0.5;

/**
 * Ranked blockers, roughly in order of how often each is the real answer. Pure.
 * An empty result is impossible: every-signal-green yields `no_blocker_found`,
 * which is the verdict that tells the operator to stop hunting for a switch.
 */
export function deriveBlockers(
  d: Omit<ServingDiagnosis, "blockers">,
  keywords: KeywordView[],
  ads: AdView[],
  negativeTexts: string[],
  today: string,
): Blocker[] {
  const positives = keywords.filter((k) => !k.negative && k.status !== "REMOVED");
  const liveAdGroups = d.adGroups.filter((g) => g.status !== "REMOVED");
  const rarely = positives.filter((k) => k.servingStatus === "RARELY_SERVED");
  const disapprovedKws = positives.filter((k) => k.approvalStatus === "DISAPPROVED");
  const narrow = d.targeting.proximity.filter((p) => radiusMiles(p) < NARROW_RADIUS_MILES);
  const blockingNegatives =
    positives.length > 0
      ? negativeTexts.filter((n) => positives.every((k) => negativeBlocks(n, k.text)))
      : [];

  const adGroupAds = (g: AdGroupDiagnosis) => ads.filter((a) => a.adGroupId === g.id);

  const candidates: Array<Blocker | null> = [
    d.billing && d.billing.status !== null && d.billing.status !== "APPROVED"
      ? {
          code: "account_not_billed",
          detail: `billing setup is ${d.billing.status}, not APPROVED`,
          fix: "Add or re-approve a payment method in Google Ads → Billing. An unbilled or cancelled account serves nothing, whatever the campaign says.",
        }
      : null,
    d.campaign.startDate && d.campaign.startDate > today
      ? {
          code: "campaign_pending",
          detail: `campaign starts ${d.campaign.startDate} (today is ${today})`,
          fix: "Move the campaign start date to today (Ads UI → Campaign settings → Start date) if it should already be running.",
        }
      : null,
    d.campaign.endDate && d.campaign.endDate < today
      ? {
          code: "campaign_ended",
          detail: `campaign ended ${d.campaign.endDate} (today is ${today})`,
          fix: "Clear or extend the end date in Campaign settings.",
        }
      : null,
    d.campaign.budget.status === "REMOVED"
      ? {
          code: "budget_removed",
          detail: "the campaign's budget is REMOVED",
          fix: "Attach a live budget to the campaign; `/adkit update`'s `budgets` lever can then set the daily amount.",
        }
      : null,
    d.campaign.budget.status === "PAUSED" || d.campaign.budget.amountMicros === 0
      ? {
          code: "budget_paused",
          detail: `budget status ${d.campaign.budget.status ?? "unknown"}, amount ${d.campaign.budget.amountMicros} micros`,
          fix: "Re-enable the budget and set a non-zero daily amount (`/adkit update`'s `budgets` lever).",
        }
      : null,
    d.campaign.status === "PAUSED" || d.campaign.status === "REMOVED"
      ? {
          code: "campaign_paused",
          detail: `campaign status is ${d.campaign.status}`,
          fix: "Enable the campaign (`/adkit update`'s `campaignStatus` lever).",
        }
      : null,
    liveAdGroups.length === 0
      ? {
          code: "ad_group_removed",
          detail: "the campaign has no live ad groups",
          fix: "Add an ad group with keywords and RSAs (`/adkit update`'s `adGroups` lever, then publish ads).",
        }
      : liveAdGroups.every((g) => g.status === "PAUSED")
        ? {
            code: "ad_groups_paused",
            detail: `all ${liveAdGroups.length} ad group(s) are PAUSED`,
            fix: "Enable the ad groups (`/adkit update`'s `adGroupStatus` lever).",
          }
        : null,
    ...liveAdGroups
      .filter((g) => g.status !== "PAUSED" && adGroupAds(g).length === 0)
      .map(
        (g): Blocker => ({
          code: "no_eligible_ads",
          detail: `ad group '${g.name}' has no live ads`,
          fix: "Publish RSAs into the ad group — an ad group with no ad cannot serve.",
        }),
      ),
    ...liveAdGroups
      .filter((g) => g.status !== "PAUSED" && adGroupAds(g).length > 0 && g.eligibleAds === 0 && g.pausedAds > 0)
      .map(
        (g): Blocker => ({
          code: "ads_paused",
          detail: `${g.pausedAds} of ${adGroupAds(g).length} RSAs in '${g.name}' are PAUSED`,
          fix: "Enable the ads. `/adkit create` publishes RSAs PAUSED by design, so this is the most likely cause of a freshly-published campaign showing zero impressions — flip them on with `/adkit update`'s `adStatus` lever once the copy has been reviewed.",
        }),
      ),
    d.disapprovals.length > 0
      ? {
          code: "ads_disapproved",
          detail: `${d.disapprovals.length} ad(s) DISAPPROVED: ${[
            ...new Set(d.disapprovals.flatMap((x) => x.policyTopics)),
          ].join(", ") || "policy topic not reported"}`,
          fix: "Fix the flagged copy or landing page and resubmit for review in the Ads UI; policy edits are not something `/adkit update` can do for you.",
        }
      : null,
    d.adGroups.some((g) => g.underReviewAds > 0) && d.adGroups.every((g) => g.eligibleAds === 0)
      ? {
          code: "ads_under_review",
          detail: "every live ad is still under review",
          fix: "Wait — Google review typically clears within one business day. Nothing to change.",
        }
      : null,
    disapprovedKws.length > 0 && disapprovedKws.length === positives.length
      ? {
          code: "keywords_disapproved",
          detail: `all ${positives.length} keyword(s) are DISAPPROVED`,
          fix: "Review the keyword policy violations in the Ads UI and replace the offending terms.",
        }
      : null,
    positives.length === 0
      ? {
          code: "no_keywords",
          detail: "the campaign has no live positive keywords",
          fix: "Add keywords (`/adkit update`'s `keywords` lever) — a search campaign with no keyword matches no search.",
        }
      : rarely.length / positives.length >= RARELY_SERVED_SHARE
        ? {
            code: "keywords_rarely_served",
            detail: `${rarely.length}/${positives.length} keywords are RARELY_SERVED (too little search volume)`,
            fix: "Replace the low-volume terms with broader head terms — run `/adkit research` for volume-backed candidates.",
          }
        : null,
    blockingNegatives.length > 0
      ? {
          code: "negatives_block_everything",
          detail: `negative(s) ${blockingNegatives.slice(0, 5).join(", ")} block every one of the campaign's ${positives.length} keyword(s)`,
          fix: "Remove or narrow those negatives (`/adkit update`'s `negatives` lever) — a negative whose words are all contained in your own keyword blocks its traffic outright.",
        }
      : null,
    narrow.length > 0 && narrow.length === d.targeting.proximity.length
      ? {
          code: "targeting_too_narrow",
          detail: `proximity targeting is ${narrow
            .map((p) => `${p.radius} ${p.units ?? "?"}${p.city ? ` around ${p.city}` : ""}`)
            .join(", ")} — under ${NARROW_RADIUS_MILES} miles`,
          fix: "Widen the radius or add city/region targets (`/adkit update` cannot edit geo — Ads UI → Settings → Locations, or republish with `/adkit create`'s geo targeting).",
        }
      : null,
  ];

  const blockers = candidates.filter((b): b is Blocker => b !== null);
  if (blockers.length > 0) {
    return blockers;
  }
  return [
    {
      code: "no_blocker_found",
      detail:
        "every eligibility signal is green — checked billing, campaign status/dates, budget, " +
        `ad-group status, ad status + policy approval, ${positives.length} keyword(s) ` +
        "(approval + serving status), negatives, and geo/language/schedule targeting",
      fix: "This is a volume or bid question, not a config one: the setup can serve but isn't winning auctions. Raise bids/budget, broaden keywords, or check that the terms have real search volume (`/adkit research`).",
    },
  ];
}
