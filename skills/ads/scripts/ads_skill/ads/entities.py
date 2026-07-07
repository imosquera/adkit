"""SDK entity builders for publish_v1 — one function per Google Ads service hit
(budget, campaign, criteria, assets, ad groups, RSAs, keywords) plus the lookup
tables they share. Each builder is a thin wrapper that constructs the proto
operation(s) and mutates; publish.py sequences them under `_step`.

All Google Ads SDK imports are deferred (inside functions) so the pure libs and
tests can import this without google-ads installed.
"""

from __future__ import annotations

from typing import Any

from .errors import _StepError, _gaql_string
from ..lib.schema import AdGroup, Brief

# ---------- SDK call wrappers (one per Google Ads service hit) ----------


def _apply_bid_strategy(client: Any, campaign: Any, brief: Brief) -> None:
    """New campaigns default to Maximize Clicks (TargetSpend) to seed conversion
    data and avoid the Smart-Bidding cold start; switch to Maximize Conversions in
    the UI once ~15-30 conversions/30d exist. bidStrategy='maximize-conversions'
    launches straight on Smart Bidding. Only these two launch modes are supported;
    any other value falls back to Maximize Clicks."""
    if brief.campaign.bidStrategy == "maximize-conversions":
        campaign.maximize_conversions.target_cpa_micros = 0
        return
    target_spend = client.get_type("TargetSpend")
    if brief.campaign.cpcBidCeilingMicros:
        target_spend.cpc_bid_ceiling_micros = brief.campaign.cpcBidCeilingMicros
    campaign.target_spend = target_spend


def _create_campaign_budget(client: Any, customer_id: str, brief: Brief) -> str:
    service = client.get_service("CampaignBudgetService")
    op = client.get_type("CampaignBudgetOperation")
    budget = op.create
    budget.name = f"{brief.campaign.name} Budget"
    budget.amount_micros = brief.campaign.budgetMicros
    budget.delivery_method = client.enums.BudgetDeliveryMethodEnum.STANDARD
    budget.explicitly_shared = False
    return service.mutate_campaign_budgets(customer_id=customer_id, operations=[op]).results[0].resource_name


def _find_existing_campaign(client: Any, customer_id: str, brief: Brief) -> tuple[str, str | None] | None:
    ga_service = client.get_service("GoogleAdsService")
    query = (
        "SELECT campaign.resource_name, campaign.campaign_budget "
        "FROM campaign "
        f"WHERE campaign.name = '{_gaql_string(brief.campaign.name)}' "
        "AND campaign.status != 'REMOVED'"
    )
    rows = list(ga_service.search(customer_id=customer_id, query=query))
    if not rows:
        return None
    if len(rows) > 1:
        raise _StepError(
            "find-existing-campaign",
            f"multiple non-removed campaigns named {brief.campaign.name!r}; remove duplicates before retrying",
            None,
        )
    campaign = rows[0].campaign
    return campaign.resource_name, campaign.campaign_budget or None


def _create_search_campaign(client: Any, customer_id: str, brief: Brief, budget_rn: str) -> str:
    service = client.get_service("CampaignService")
    op = client.get_type("CampaignOperation")
    campaign = op.create
    campaign.name = brief.campaign.name
    campaign.advertising_channel_type = client.enums.AdvertisingChannelTypeEnum.SEARCH
    campaign.status = client.enums.CampaignStatusEnum.PAUSED
    _apply_bid_strategy(client, campaign, brief)
    campaign.campaign_budget = budget_rn
    # "search-only" = Google search results only. "search-partners-display"
    # also serves on Google search partner sites (target_search_network).
    # The Display Network (target_content_network) is intentionally always OFF —
    # we never want Search-with-Display-Select serving display impressions.
    expanded = brief.campaign.networkSettings != "search-only"
    campaign.network_settings.target_google_search = True
    campaign.network_settings.target_search_network = True
    campaign.network_settings.target_content_network = False
    campaign.network_settings.target_partner_search_network = False
    # PRESENCE = serve only to people physically in the targeted locations.
    # Default (PRESENCE_OR_INTEREST) would also serve people elsewhere who
    # merely search about the US/Canada, which we don't want.
    campaign.geo_target_type_setting.positive_geo_target_type = (
        client.enums.PositiveGeoTargetTypeEnum.PRESENCE
    )
    # AI Max: lets Google AI expand beyond the SKAG's exact/phrase keywords via
    # broad-match tech and match landing-page/asset content to more queries.
    # Search-term matching is on by default once enabled; disable per ad group
    # via AdGroup.ai_max_ad_group_setting.disable_search_term_matching.
    campaign.ai_max_setting.enable_ai_max = brief.campaign.aiMax
    campaign.contains_eu_political_advertising = client.enums.EuPoliticalAdvertisingStatusEnum.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING
    return service.mutate_campaigns(customer_id=customer_id, operations=[op]).results[0].resource_name


def set_campaign_status(client: Any, customer_id: str, campaign_id: str, status: str) -> str:
    """Flip a live campaign's serving status to ENABLED or PAUSED via
    CampaignService.mutate_campaigns (an update with update_mask=['status']). This is
    the isolated IO edge for the fixes-plan `campaignStatus` block; the on/off DECISION
    (skip a no-op, shout before an ENABLE that starts live spend) stays pure in the
    apply path. Mirrors the create path's CampaignStatusEnum usage. Returns the
    mutated campaign resource name."""
    service = client.get_service("CampaignService")
    op = client.get_type("CampaignOperation")
    op.update.resource_name = f"customers/{customer_id}/campaigns/{campaign_id}"
    op.update.status = client.enums.CampaignStatusEnum[status]
    op.update_mask.paths.append("status")
    return service.mutate_campaigns(customer_id=customer_id, operations=[op]).results[0].resource_name


def set_ad_group_status(client: Any, customer_id: str, ad_group_id: str, status: str) -> str:
    """Flip a live ad group's serving status to ENABLED or PAUSED via
    AdGroupService.mutate_ad_groups (an update with update_mask=['status']). The isolated
    IO edge for the fixes-plan `adGroupStatus` block; the on/off DECISION (skip a no-op,
    shout before an ENABLE that resumes live spend) stays pure in the apply path. Mirrors
    set_campaign_status one level down. Returns the mutated ad group resource name."""
    service = client.get_service("AdGroupService")
    op = client.get_type("AdGroupOperation")
    op.update.resource_name = f"customers/{customer_id}/adGroups/{ad_group_id}"
    op.update.status = client.enums.AdGroupStatusEnum[status]
    op.update_mask.paths.append("status")
    return service.mutate_ad_groups(customer_id=customer_id, operations=[op]).results[0].resource_name


def _create_sitelinks(client: Any, customer_id: str, brief: Brief, campaign_rn: str) -> list[str]:
    """Create each sitelink as a SitelinkAsset, then link all of them to the
    campaign via CampaignAsset(field_type=SITELINK). Returns the CampaignAsset
    resource names. No-op (returns []) when the brief carries no sitelinks."""
    sitelinks = brief.campaign.sitelinks
    if not sitelinks:
        return []
    asset_service = client.get_service("AssetService")
    asset_ops = []
    for sl in sitelinks:
        op = client.get_type("AssetOperation")
        sitelink = op.create.sitelink_asset
        sitelink.link_text = sl.text
        if sl.description1 is not None:
            sitelink.description1 = sl.description1
            sitelink.description2 = sl.description2
        op.create.final_urls.append(str(sl.finalUrl))
        asset_ops.append(op)
    asset_rns = [
        r.resource_name
        for r in asset_service.mutate_assets(customer_id=customer_id, operations=asset_ops).results
    ]
    link_service = client.get_service("CampaignAssetService")
    link_ops = []
    for asset_rn in asset_rns:
        op = client.get_type("CampaignAssetOperation")
        op.create.campaign = campaign_rn
        op.create.asset = asset_rn
        op.create.field_type = client.enums.AssetFieldTypeEnum.SITELINK
        link_ops.append(op)
    return [
        r.resource_name
        for r in link_service.mutate_campaign_assets(customer_id=customer_id, operations=link_ops).results
    ]


def _create_callouts(client: Any, customer_id: str, brief: Brief, campaign_rn: str) -> list[str]:
    """Create each callout as a CalloutAsset, then link all of them to the
    campaign via CampaignAsset(field_type=CALLOUT). Returns the CampaignAsset
    resource names. No-op (returns []) when the brief carries no callouts."""
    callouts = brief.campaign.callouts
    if not callouts:
        return []
    asset_service = client.get_service("AssetService")
    asset_ops = []
    for text in callouts:
        op = client.get_type("AssetOperation")
        op.create.callout_asset.callout_text = text
        asset_ops.append(op)
    asset_rns = [
        r.resource_name
        for r in asset_service.mutate_assets(customer_id=customer_id, operations=asset_ops).results
    ]
    link_service = client.get_service("CampaignAssetService")
    link_ops = []
    for asset_rn in asset_rns:
        op = client.get_type("CampaignAssetOperation")
        op.create.campaign = campaign_rn
        op.create.asset = asset_rn
        op.create.field_type = client.enums.AssetFieldTypeEnum.CALLOUT
        link_ops.append(op)
    return [
        r.resource_name
        for r in link_service.mutate_campaign_assets(customer_id=customer_id, operations=link_ops).results
    ]


def _create_price_asset(client: Any, customer_id: str, brief: Brief, campaign_rn: str) -> list[str]:
    """Create and attach the brief's campaign-level PriceAsset, if present."""
    price_asset = brief.campaign.priceAsset
    if price_asset is None:
        return []
    asset_service = client.get_service("AssetService")
    op = client.get_type("AssetOperation")
    asset = op.create.price_asset
    asset.type_ = getattr(client.enums.PriceExtensionTypeEnum, price_asset.type)
    asset.language_code = price_asset.languageCode
    # proto-plus repeated message fields have no .add(); append a dict instead.
    for offering in price_asset.offerings:
        asset.price_offerings.append({
            "header": offering.header,
            "description": offering.description,
            "price": {
                "amount_micros": offering.priceMicros,
                "currency_code": price_asset.currencyCode,
            },
            "final_url": str(offering.finalUrl),
        })
    asset_rn = asset_service.mutate_assets(customer_id=customer_id, operations=[op]).results[0].resource_name
    link_service = client.get_service("CampaignAssetService")
    link_op = client.get_type("CampaignAssetOperation")
    link_op.create.campaign = campaign_rn
    link_op.create.asset = asset_rn
    link_op.create.field_type = client.enums.AssetFieldTypeEnum.PRICE
    return [
        r.resource_name
        for r in link_service.mutate_campaign_assets(customer_id=customer_id, operations=[link_op]).results
    ]


# StructuredSnippetAsset.header is a free-text string Google validates against a
# fixed predefined list — NOT an enum. Map the schema's enum-style names to the
# exact header strings the API accepts.
_SNIPPET_HEADERS = {
    "AMENITIES": "Amenities", "BRANDS": "Brands", "COURSES": "Courses",
    "DEGREES": "Degree programs", "DESTINATIONS": "Destinations",
    "FEATURED_HOTELS": "Featured hotels", "INSURANCE_COVERAGE": "Insurance coverage",
    "MODELS": "Models", "NEIGHBORHOODS": "Neighborhoods",
    "SERVICE_CATALOG": "Service catalog", "SHOWS": "Shows",
    "STYLES": "Styles", "TYPES": "Types",
}


def _create_structured_snippet(client: Any, customer_id: str, brief: Brief, campaign_rn: str) -> list[str]:
    """Create and attach the brief's campaign-level StructuredSnippetAsset, if present."""
    snippet = brief.campaign.structuredSnippet
    if snippet is None:
        return []
    asset_service = client.get_service("AssetService")
    op = client.get_type("AssetOperation")
    asset = op.create.structured_snippet_asset
    asset.header = _SNIPPET_HEADERS[snippet.header]
    asset.values.extend(snippet.values)
    asset_rn = asset_service.mutate_assets(customer_id=customer_id, operations=[op]).results[0].resource_name
    link_service = client.get_service("CampaignAssetService")
    link_op = client.get_type("CampaignAssetOperation")
    link_op.create.campaign = campaign_rn
    link_op.create.asset = asset_rn
    link_op.create.field_type = client.enums.AssetFieldTypeEnum.STRUCTURED_SNIPPET
    return [
        r.resource_name
        for r in link_service.mutate_campaign_assets(customer_id=customer_id, operations=[link_op]).results
    ]


# United States (2840) + Canada (2124). Campaigns target these only;
# without this a Search campaign serves worldwide by default.
_GEO_TARGETS = ("geoTargetConstants/2840", "geoTargetConstants/2124")


# brief device name -> DeviceEnum member. "tv" = CONNECTED_TV (smart TVs/consoles).
_DEVICE_ENUM = {"computer": "DESKTOP", "mobile": "MOBILE", "tablet": "TABLET", "tv": "CONNECTED_TV"}
_ALL_DEVICES = ("computer", "mobile", "tablet", "tv")


def _target_devices(client: Any, customer_id: str, campaign_rn: str, devices: list[str] | None) -> None:
    """Restrict serving to `devices` by setting a -100% (bid_modifier=0) criterion
    on every device NOT listed. None (field omitted) => default brief, which
    excludes mobile at -100% (computer/tablet/tv serve). List every device to
    serve everywhere. Exclusion via bid_modifier=0 is honored even under
    Smart Bidding, where non-zero device adjustments would otherwise be ignored."""
    if devices is None:
        devices = [d for d in _ALL_DEVICES if d != "mobile"]  # default: mobile -100%
    excluded = [d for d in _ALL_DEVICES if d not in devices]
    if not excluded:
        return
    ops = []
    for d in excluded:
        op = client.get_type("CampaignCriterionOperation")
        op.create.campaign = campaign_rn
        op.create.device.type_ = getattr(client.enums.DeviceEnum, _DEVICE_ENUM[d])
        op.create.bid_modifier = 0.0  # -100% = device excluded
        ops.append(op)
    service = client.get_service("CampaignCriterionService")
    service.mutate_campaign_criteria(customer_id=customer_id, operations=ops)


def build_negative_keyword_ops(client: Any, campaign_rn: str, negatives: list) -> list:
    """Build CampaignCriterionOperations for campaign-level negative keywords.

    `negatives` is any iterable of items exposing `.text` and `.matchType`
    (matchType one of EXACT/PHRASE/BROAD) — e.g. schema.Keyword. Shared by the
    /ads:create publish path and the /ads:audit apply-fixes path so both add
    negatives the same way. Returns the ops; the caller mutates."""
    match_enum = client.enums.KeywordMatchTypeEnum
    ops = []
    for kw in negatives:
        op = client.get_type("CampaignCriterionOperation")
        crit = op.create
        crit.campaign = campaign_rn
        crit.negative = True
        crit.keyword.text = kw.text
        crit.keyword.match_type = getattr(match_enum, kw.matchType)
        ops.append(op)
    return ops


def build_keyword_ops(client: Any, ad_group_rn: str, adds: list, remove_resources: list,
                      pause_resources: list) -> list:
    """Build AdGroupCriterionOperations for a positive-keyword edit on one ad group:
    create each ADD keyword, remove each REMOVE criterion (by resource name), and
    pause each PAUSE criterion (update status=PAUSED). `adds` exposes .text/.matchType
    (schema.Keyword); remove/pause are live criterion resource names already resolved by
    the shell. Pure op-construction (no mutate) so it is unit-testable with a fake client;
    the caller mutates. Match type is immutable on a live criterion (PC-001), so a
    'change match type' arrives here as a REMOVE + an ADD, never an update."""
    match_enum = client.enums.KeywordMatchTypeEnum
    paused = client.enums.AdGroupCriterionStatusEnum.PAUSED
    ops = []
    for kw in adds:
        op = client.get_type("AdGroupCriterionOperation")
        crit = op.create
        crit.ad_group = ad_group_rn
        crit.keyword.text = kw.text
        crit.keyword.match_type = getattr(match_enum, kw.matchType)
        ops.append(op)
    for rn in remove_resources:
        op = client.get_type("AdGroupCriterionOperation")
        op.remove = rn
        ops.append(op)
    for rn in pause_resources:
        op = client.get_type("AdGroupCriterionOperation")
        op.update.resource_name = rn
        op.update.status = paused
        op.update_mask.paths.append("status")
        ops.append(op)
    return ops


def _create_negative_keywords(client: Any, customer_id: str, campaign_rn: str, negatives: list) -> list[str]:
    """Campaign-level negative keywords — shared across every ad group. Blocks
    close-variant / broad-match (incl. AI Max) expansion onto off-theme queries.
    No-op when the brief lists none."""
    if not negatives:
        return []
    service = client.get_service("CampaignCriterionService")
    ops = build_negative_keyword_ops(client, campaign_rn, negatives)
    response = service.mutate_campaign_criteria(customer_id=customer_id, operations=ops)
    return [r.resource_name for r in response.results]


def _target_us_canada(client: Any, customer_id: str, campaign_rn: str) -> None:
    ops = []
    for geo in _GEO_TARGETS:
        op = client.get_type("CampaignCriterionOperation")
        op.create.campaign = campaign_rn
        op.create.location.geo_target_constant = geo
        ops.append(op)
    service = client.get_service("CampaignCriterionService")
    service.mutate_campaign_criteria(customer_id=customer_id, operations=ops)


def _find_existing_ad_group(
    client: Any, customer_id: str, ad_group: AdGroup, campaign_rn: str
) -> str | None:
    ga_service = client.get_service("GoogleAdsService")
    query = (
        "SELECT ad_group.resource_name "
        "FROM ad_group "
        f"WHERE campaign.resource_name = '{_gaql_string(campaign_rn)}' "
        f"AND ad_group.name = '{_gaql_string(ad_group.name)}' "
        "AND ad_group.status != 'REMOVED'"
    )
    rows = list(ga_service.search(customer_id=customer_id, query=query))
    if not rows:
        return None
    if len(rows) > 1:
        raise _StepError(
            "find-existing-ad-group",
            f"multiple non-removed ad groups named {ad_group.name!r} in campaign {campaign_rn}",
            None,
            ad_group_name=ad_group.name,
        )
    return rows[0].ad_group.resource_name


def _create_ad_group(client: Any, customer_id: str, ad_group: AdGroup, campaign_rn: str) -> str:
    service = client.get_service("AdGroupService")
    op = client.get_type("AdGroupOperation")
    ag = op.create
    ag.name = ad_group.name
    ag.campaign = campaign_rn
    ag.status = client.enums.AdGroupStatusEnum.ENABLED
    ag.type_ = client.enums.AdGroupTypeEnum.SEARCH_STANDARD
    ag.cpc_bid_micros = ad_group.defaultBidMicros
    return service.mutate_ad_groups(customer_id=customer_id, operations=[op]).results[0].resource_name


def _make_text_assets(client: Any, items: list[dict[str, Any]]) -> list[Any]:
    # No pinned_field is ever set: pinning is disabled skill-wide (schema locks
    # pin to "NONE") so Google can test every headline/description combination.
    assets = []
    for item in items:
        asset = client.get_type("AdTextAsset")
        asset.text = item["text"]
        assets.append(asset)
    return assets


def _create_responsive_search_ad(
    client: Any, customer_id: str, ad_group: AdGroup, ad_group_rn: str
) -> str:
    service = client.get_service("AdGroupAdService")
    op = client.get_type("AdGroupAdOperation")
    ad_group_ad = op.create
    ad_group_ad.ad_group = ad_group_rn
    ad_group_ad.status = client.enums.AdGroupAdStatusEnum.PAUSED
    rsa = ad_group_ad.ad.responsive_search_ad
    for asset in _make_text_assets(client, [h.model_dump() for h in ad_group.responsiveSearchAd.headlines]):
        rsa.headlines.append(asset)
    for asset in _make_text_assets(client, [d.model_dump() for d in ad_group.responsiveSearchAd.descriptions]):
        rsa.descriptions.append(asset)
    ad_group_ad.ad.final_urls.append(str(ad_group.responsiveSearchAd.finalUrl))
    # Display-URL paths: the shown URL is the finalUrl host + these keyword-rich
    # segments, independent of the (long, tracking-heavy) finalUrl that is clicked.
    if ad_group.responsiveSearchAd.path1 is not None:
        rsa.path1 = ad_group.responsiveSearchAd.path1
    if ad_group.responsiveSearchAd.path2 is not None:
        rsa.path2 = ad_group.responsiveSearchAd.path2
    return service.mutate_ad_group_ads(customer_id=customer_id, operations=[op]).results[0].resource_name


def _create_keywords(client: Any, customer_id: str, ad_group: AdGroup, ad_group_rn: str) -> list[str]:
    service = client.get_service("AdGroupCriterionService")
    match_enum = client.enums.KeywordMatchTypeEnum
    ops = []
    for kw in ad_group.keywords:
        op = client.get_type("AdGroupCriterionOperation")
        crit = op.create
        crit.ad_group = ad_group_rn
        crit.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
        crit.keyword.text = kw.text
        crit.keyword.match_type = getattr(match_enum, kw.matchType)
        ops.append(op)
    response = service.mutate_ad_group_criteria(customer_id=customer_id, operations=ops)
    return [r.resource_name for r in response.results]


def _archive_campaigns_by_name(client: Any, customer_id: str, name: str) -> tuple[str, ...]:
    """Remove (soft-delete) every campaign with this name. Idempotent: returns ()
    when no match. Used by --archive-existing to clear a prior identically-named
    campaign before v1-fresh publish."""
    ga_service = client.get_service("GoogleAdsService")
    query = (
        f"SELECT campaign.resource_name FROM campaign "
        f"WHERE campaign.name = '{_gaql_string(name)}' AND campaign.status != 'REMOVED'"
    )
    rows = ga_service.search(customer_id=customer_id, query=query)
    resource_names = tuple(row.campaign.resource_name for row in rows)
    if not resource_names:
        return ()
    campaign_service = client.get_service("CampaignService")
    ops = []
    for rn in resource_names:
        op = client.get_type("CampaignOperation")
        op.remove = rn
        ops.append(op)
    campaign_service.mutate_campaigns(customer_id=customer_id, operations=ops)
    return resource_names
