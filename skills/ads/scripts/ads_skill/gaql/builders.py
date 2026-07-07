"""Named GAQL query builders — the single home for every Google Ads Query the
skill issues. Replaces inline f-strings scattered across bin/audit.py,
bin/apply_fixes.py, and lib/report.py so the queries are reviewable in one place
and every id interpolation is routed through `gaql_id` (digits-only guard).

Builders here are pure string functions (no SDK import); the IO shells run them.
The /ads:report builders historically lived in lib/report.py and are re-exported
from there for backwards compatibility.
"""

from __future__ import annotations

from datetime import date, timedelta

from .escape import gaql_id

# ===========================================================================
# /ads:report builders (moved here from lib.report; re-exported by lib.report)
# ===========================================================================

# Shared GAQL fragments — defined once, reused by every builder (DRY).
_ENABLED = "campaign.status = 'ENABLED'"
_METRICS = (
    "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, "
    "metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion"
)


def date_window(as_of: date, days: int) -> tuple[str, str]:
    """The last `days` COMPLETE days ending yesterday (partial current day
    excluded so day-over-day trends are comparable). Returns ISO date strings."""
    end = as_of - timedelta(days=1)
    start = end - timedelta(days=days - 1)
    return start.isoformat(), end.isoformat()


def _where(start: str, end: str) -> str:
    return f"WHERE {_ENABLED} AND segments.date BETWEEN '{start}' AND '{end}'"


def campaign_totals_query(start: str, end: str) -> str:
    return (
        f"SELECT campaign.id, campaign.name, campaign.status, {_METRICS} "
        f"FROM campaign {_where(start, end)}"
    )


def campaign_daily_query(start: str, end: str) -> str:
    return (
        f"SELECT campaign.id, campaign.name, segments.date, {_METRICS} "
        f"FROM campaign {_where(start, end)} ORDER BY segments.date"
    )


def ad_group_query(start: str, end: str) -> str:
    return (
        f"SELECT campaign.id, ad_group.id, ad_group.name, {_METRICS} "
        f"FROM ad_group {_where(start, end)}"
    )


def ad_query(start: str, end: str) -> str:
    # ad_group_ad.ad.name is often blank for search ads; bin/report.py falls
    # back to the id so every ad has a label. ad_strength is Google's creative
    # quality grade (POOR/AVERAGE/GOOD/EXCELLENT) — a fix-the-ad signal.
    return (
        "SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, "
        "ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad_strength, "
        f"{_METRICS} FROM ad_group_ad {_where(start, end)}"
    )


def keyword_query(start: str, end: str) -> str:
    return (
        "SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.text, "
        f"ad_group_criterion.keyword.match_type, {_METRICS} "
        f"FROM keyword_view {_where(start, end)}"
    )


def search_term_query(start: str, end: str) -> str:
    return (
        "SELECT campaign.id, ad_group.id, search_term_view.search_term, "
        f"{_METRICS} FROM search_term_view {_where(start, end)}"
    )


# ===========================================================================
# /ads:audit builders (bin/audit.py)
# ===========================================================================


def audit_keywords_query(campaign_ids: list) -> str:
    """Every campaign's ENABLED keywords in one query → caller groups by
    {campaignId: {adGroupName: [kw]}}. Ids are guarded digits-only."""
    ids = ",".join(gaql_id(c) for c in campaign_ids)
    return (
        "SELECT campaign.id, ad_group.name, ad_group_criterion.keyword.text "
        f"FROM ad_group_criterion WHERE campaign.id IN ({ids}) "
        "AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'"
    )


def audit_keyword_metrics_query(days: int, campaign_ids: list) -> str:
    """Every campaign's ENABLED keywords with average CPC over the window → caller
    groups by campaignId to detect cheap-broad vs expensive-intent clusters."""
    ids = ",".join(gaql_id(c) for c in campaign_ids)
    return (
        "SELECT campaign.id, ad_group_criterion.keyword.text, metrics.average_cpc "
        f"FROM keyword_view WHERE campaign.id IN ({ids}) "
        f"AND segments.date DURING LAST_{int(days)}_DAYS"
    )


def audit_search_terms_query(days: int, campaign_ids: list) -> str:
    """Each campaign's search terms with metrics over the window → caller derives
    negative-keyword + promote candidates with the same lib/cluster logic
    /ads:report uses. Ids guarded digits-only."""
    ids = ",".join(gaql_id(c) for c in campaign_ids)
    return (
        "SELECT campaign.id, search_term_view.search_term, "
        "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions "
        f"FROM search_term_view WHERE campaign.id IN ({ids}) "
        f"AND segments.date DURING LAST_{int(days)}_DAYS"
    )


def audit_campaigns_query(only_enabled: bool, campaign_id: str | None) -> str:
    """List campaigns to audit: a single id, ENABLED-only, or all."""
    where = []
    if campaign_id:
        where.append(f"campaign.id = {gaql_id(campaign_id)}")
    elif only_enabled:
        where.append("campaign.status = 'ENABLED'")
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    return f"SELECT campaign.id, campaign.name, campaign.status FROM campaign{clause} ORDER BY campaign.name"


def audit_ext_count_query(camp_id: str, field_type: str) -> str:
    """Count campaign assets of one extension field_type (SITELINK/CALLOUT)."""
    return (
        f"SELECT campaign.id FROM campaign_asset WHERE campaign.id = {gaql_id(camp_id)} "
        f"AND campaign_asset.field_type = '{field_type}'"
    )


def audit_quality_score_query(campaign_ids: list) -> str:
    """Current Quality Score snapshot per keyword: overall score (1-10) plus the
    three component ratings (BELOW_AVERAGE/AVERAGE/ABOVE_AVERAGE) for expected CTR,
    ad relevance, and landing page experience. No date segmentation — these are
    current-state fields on ad_group_criterion."""
    ids = ",".join(gaql_id(c) for c in campaign_ids)
    return (
        "SELECT campaign.id, ad_group_criterion.keyword.text, "
        "ad_group_criterion.quality_info.quality_score, "
        "ad_group_criterion.quality_info.search_predicted_ctr, "
        "ad_group_criterion.quality_info.creative_quality_score, "
        "ad_group_criterion.quality_info.post_click_quality_score "
        f"FROM keyword_view WHERE campaign.id IN ({ids}) "
        "AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'"
    )


def audit_ad_group_ad_query(camp_id: str) -> str:
    """All non-removed RSAs in a campaign with the fields the creative audit reads."""
    return (
        "SELECT ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad_strength, ad_group_ad.status, "
        "ad_group_ad.action_items, ad_group_ad.ad.responsive_search_ad.headlines, "
        "ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls "
        f"FROM ad_group_ad WHERE campaign.id = {gaql_id(camp_id)} AND ad_group_ad.status != 'REMOVED' "
        "ORDER BY ad_group.name"
    )


def audit_serving_query(days: int, only_enabled: bool, campaign_id: str | None) -> str:
    """Impression-share / budget / rank metrics for the serving layer."""
    where = [f"segments.date DURING LAST_{int(days)}_DAYS"]
    if campaign_id:
        where.append(f"campaign.id = {gaql_id(campaign_id)}")
    elif only_enabled:
        where.append("campaign.status = 'ENABLED'")
    return (
        "SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign_budget.amount_micros, "
        "metrics.impressions, metrics.conversions, metrics.search_impression_share, "
        "metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share "
        f"FROM campaign WHERE {' AND '.join(where)}"
    )


# ===========================================================================
# /ads:update builders (bin/apply_fixes.py)
# ===========================================================================


def apply_negatives_query(campaign_ids: list) -> str:
    """Existing campaign-level negative keywords, to dedup a fixes plan against."""
    ids = ",".join(gaql_id(i) for i in campaign_ids)
    return (
        "SELECT campaign.id, campaign_criterion.keyword.text, "
        "campaign_criterion.keyword.match_type FROM campaign_criterion "
        f"WHERE campaign.id IN ({ids}) AND campaign_criterion.negative = TRUE "
        "AND campaign_criterion.type = KEYWORD"
    )


def apply_budgets_query(campaign_ids: list) -> str:
    """Each campaign's current budget resource + amount, for the budget guardrail."""
    ids = ",".join(gaql_id(i) for i in campaign_ids)
    return (
        "SELECT campaign.id, campaign_budget.resource_name, campaign_budget.amount_micros "
        f"FROM campaign WHERE campaign.id IN ({ids})"
    )


def apply_campaign_statuses_query(campaign_ids: list) -> str:
    """Each campaign's current serving status, so a campaignStatus fixes block can skip
    a no-op flip (a campaign already in the requested status)."""
    ids = ",".join(gaql_id(i) for i in campaign_ids)
    return (
        "SELECT campaign.id, campaign.status "
        f"FROM campaign WHERE campaign.id IN ({ids})"
    )


def apply_ad_group_statuses_query(ad_group_ids: list) -> str:
    """Each ad group's current serving status, so an adGroupStatus fixes block can skip
    a no-op flip (an ad group already in the requested status)."""
    ids = ",".join(gaql_id(i) for i in ad_group_ids)
    return (
        "SELECT ad_group.id, ad_group.status "
        f"FROM ad_group WHERE ad_group.id IN ({ids})"
    )


def apply_headlines_query(ad_ids: list) -> str:
    """Live RSA headlines for the ads an appendHeadlines plan touches."""
    ids = ",".join(gaql_id(i) for i in ad_ids)
    return (
        "SELECT ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines "
        f"FROM ad_group_ad WHERE ad_group_ad.ad.id IN ({ids})"
    )


def apply_positive_keywords_query(ad_group_ids: list) -> str:
    """Live POSITIVE (non-negative) keyword criteria for the ad groups a fixes-plan
    `keywords` block touches → caller groups by
    {adGroupId: {(text.lower, matchType): criterionResource}}. Used to dedup ADDs
    against live state and to resolve the criterion to REMOVE/PAUSE. Ids guarded."""
    ids = ",".join(gaql_id(i) for i in ad_group_ids)
    return (
        "SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.resource_name, "
        "ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, "
        "ad_group_criterion.status FROM ad_group_criterion "
        f"WHERE ad_group.id IN ({ids}) AND ad_group_criterion.type = KEYWORD "
        "AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'"
    )
