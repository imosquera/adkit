from __future__ import annotations

from types import SimpleNamespace

from ads_skill.lib.executor import _GEO_TARGETS, _target_us_canada


class _FakeService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list]] = []

    def mutate_campaign_criteria(self, *, customer_id: str, operations: list) -> None:
        self.calls.append((customer_id, operations))


class _FakeClient:
    def __init__(self) -> None:
        self.service = _FakeService()

    def get_service(self, _name: str) -> _FakeService:
        return self.service

    def get_type(self, _name: str):  # CampaignCriterionOperation
        return SimpleNamespace(create=SimpleNamespace(campaign=None, location=SimpleNamespace(geo_target_constant=None)))


def test_target_us_canada_sets_both_geos_on_campaign() -> None:
    client = _FakeClient()
    _target_us_canada(client, "123", "customers/123/campaigns/9")

    customer_id, ops = client.service.calls[0]
    assert customer_id == "123"
    assert all(op.create.campaign == "customers/123/campaigns/9" for op in ops)
    geos = [op.create.location.geo_target_constant for op in ops]
    assert geos == list(_GEO_TARGETS)
    # US (2840) + Canada (2124), nothing else.
    assert geos == ["geoTargetConstants/2840", "geoTargetConstants/2124"]


from ads_skill.lib.executor import _create_sitelinks
from ads_skill.lib.schema import Brief


def _brief_with_sitelinks(sitelinks: list[dict]) -> Brief:
    return Brief.model_validate({
        "name": "konnect-test",
        "version": 1,
        "campaign": {
            "name": "konnect-test-search",
            "budgetMicros": 10_000_000,
            "networkSettings": "search-only",
            "sitelinks": sitelinks,
        },
        "adGroups": [{
            "name": "Ag",
            "defaultBidMicros": 1_500_000,
            "responsiveSearchAd": {
                "headlines": [{"text": f"H{i}"} for i in range(15)],
                "descriptions": [{"text": f"D{i}"} for i in range(4)],
                "finalUrl": "https://www.example.com/x",
            },
            "keywords": [{"text": "kw", "matchType": "PHRASE"}],
        }],
    })


class _Result:
    def __init__(self, rn: str) -> None:
        self.resource_name = rn


class _AssetService:
    def __init__(self) -> None:
        self.ops: list = []

    def mutate_assets(self, *, customer_id: str, operations: list):
        self.ops = operations
        return SimpleNamespace(results=[_Result(f"assets/{i}") for i in range(len(operations))])


class _CampaignAssetService:
    def __init__(self) -> None:
        self.ops: list = []

    def mutate_campaign_assets(self, *, customer_id: str, operations: list):
        self.ops = operations
        return SimpleNamespace(results=[_Result(f"campaignAssets/{i}") for i in range(len(operations))])


class _SitelinkFakeClient:
    def __init__(self) -> None:
        self.asset_service = _AssetService()
        self.link_service = _CampaignAssetService()
        self.enums = SimpleNamespace(AssetFieldTypeEnum=SimpleNamespace(SITELINK="SITELINK"))

    def get_service(self, name: str):
        return self.asset_service if name == "AssetService" else self.link_service

    def get_type(self, name: str):
        if name == "AssetOperation":
            return SimpleNamespace(create=SimpleNamespace(
                sitelink_asset=SimpleNamespace(link_text=None, description1=None, description2=None),
                final_urls=[],
            ))
        return SimpleNamespace(create=SimpleNamespace(campaign=None, asset=None, field_type=None))


def test_create_sitelinks_links_all_to_campaign() -> None:
    brief = _brief_with_sitelinks([
        {"text": "How It Works", "finalUrl": "https://www.example.com/a"},
        {"text": "Pricing", "finalUrl": "https://www.example.com/b",
         "description1": "line one", "description2": "line two"},
        {"text": "Trial", "finalUrl": "https://www.example.com/c"},
        {"text": "Brands", "finalUrl": "https://www.example.com/d"},
        {"text": "Demo", "finalUrl": "https://www.example.com/e"},
        {"text": "Contact", "finalUrl": "https://www.example.com/f"},
    ])
    client = _SitelinkFakeClient()
    rns = _create_sitelinks(client, "123", brief, "customers/123/campaigns/9")

    assert len(client.asset_service.ops) == 6
    assert client.asset_service.ops[0].create.sitelink_asset.link_text == "How It Works"
    # descriptions set only on the one that supplied them
    assert client.asset_service.ops[1].create.sitelink_asset.description1 == "line one"
    assert client.asset_service.ops[0].create.sitelink_asset.description1 is None
    # every campaign-asset link uses the SITELINK field type
    assert all(op.create.field_type == "SITELINK" for op in client.link_service.ops)
    assert len(rns) == 6


def test_create_sitelinks_noop_when_none() -> None:
    brief = _brief_with_sitelinks([])
    client = _SitelinkFakeClient()
    assert _create_sitelinks(client, "123", brief, "customers/123/campaigns/9") == []


from ads_skill.lib.executor import _create_callouts


def _brief_with_callouts(callouts: list[str]) -> Brief:
    return Brief.model_validate({
        "name": "konnect-test",
        "version": 1,
        "campaign": {
            "name": "konnect-test-search",
            "budgetMicros": 10_000_000,
            "networkSettings": "search-only",
            "callouts": callouts,
        },
        "adGroups": [{
            "name": "Ag",
            "defaultBidMicros": 1_500_000,
            "responsiveSearchAd": {
                "headlines": [{"text": f"H{i}"} for i in range(15)],
                "descriptions": [{"text": f"D{i}"} for i in range(4)],
                "finalUrl": "https://www.example.com/x",
            },
            "keywords": [{"text": "kw", "matchType": "PHRASE"}],
        }],
    })


class _CalloutFakeClient:
    def __init__(self) -> None:
        self.asset_service = _AssetService()
        self.link_service = _CampaignAssetService()
        self.enums = SimpleNamespace(AssetFieldTypeEnum=SimpleNamespace(CALLOUT="CALLOUT"))

    def get_service(self, name: str):
        return self.asset_service if name == "AssetService" else self.link_service

    def get_type(self, name: str):
        if name == "AssetOperation":
            return SimpleNamespace(create=SimpleNamespace(
                callout_asset=SimpleNamespace(callout_text=None),
            ))
        return SimpleNamespace(create=SimpleNamespace(campaign=None, asset=None, field_type=None))


def test_create_callouts_links_all_to_campaign() -> None:
    brief = _brief_with_callouts(["No new integrations", "Live in 30 days", "Mid-market CPG", "Real promo ROI"])
    client = _CalloutFakeClient()
    rns = _create_callouts(client, "123", brief, "customers/123/campaigns/9")

    assert len(client.asset_service.ops) == 4
    assert client.asset_service.ops[0].create.callout_asset.callout_text == "No new integrations"
    assert all(op.create.field_type == "CALLOUT" for op in client.link_service.ops)
    assert len(rns) == 4


def test_create_callouts_noop_when_none() -> None:
    brief = _brief_with_callouts([])
    client = _CalloutFakeClient()
    assert _create_callouts(client, "123", brief, "customers/123/campaigns/9") == []


def test_callouts_below_minimum_rejected() -> None:
    import pytest
    with pytest.raises(Exception):
        _brief_with_callouts(["only one", "two", "three"])


from ads_skill.lib.executor import _create_search_campaign


class _CampaignFakeService:
    def mutate_campaigns(self, *, customer_id: str, operations: list):
        return SimpleNamespace(results=[SimpleNamespace(resource_name="customers/123/campaigns/9")])


class _CampaignFakeClient:
    def __init__(self) -> None:
        # nested submessages must pre-exist; real protos auto-create them.
        self.campaign = SimpleNamespace(
            maximize_conversions=SimpleNamespace(target_cpa_micros=None),
            network_settings=SimpleNamespace(),
            geo_target_type_setting=SimpleNamespace(),
            ai_max_setting=SimpleNamespace(enable_ai_max=None),
        )
        self.enums = SimpleNamespace(
            AdvertisingChannelTypeEnum=SimpleNamespace(SEARCH="SEARCH"),
            CampaignStatusEnum=SimpleNamespace(PAUSED="PAUSED"),
            PositiveGeoTargetTypeEnum=SimpleNamespace(PRESENCE="PRESENCE"),
            EuPoliticalAdvertisingStatusEnum=SimpleNamespace(
                DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING="NO"),
        )

    def get_service(self, _name: str) -> _CampaignFakeService:
        return _CampaignFakeService()

    def get_type(self, name: str):
        if name == "TargetSpend":
            return SimpleNamespace(cpc_bid_ceiling_micros=None)
        return SimpleNamespace(create=self.campaign)  # CampaignOperation


def _brief_with_ai_max(ai_max: bool) -> Brief:
    return Brief.model_validate({
        "name": "konnect-test",
        "version": 1,
        "campaign": {
            "name": "konnect-test-search",
            "budgetMicros": 10_000_000,
            "networkSettings": "search-only",
            "aiMax": ai_max,
        },
        "adGroups": [{
            "name": "Ag",
            "defaultBidMicros": 1_500_000,
            "responsiveSearchAd": {
                "headlines": [{"text": f"H{i}"} for i in range(15)],
                "descriptions": [{"text": f"D{i}"} for i in range(4)],
                "finalUrl": "https://www.example.com/x",
            },
            "keywords": [{"text": "k", "matchType": "EXACT"}],
        }],
    })


def test_create_search_campaign_defaults_to_maximize_clicks() -> None:
    client = _CampaignFakeClient()
    _create_search_campaign(client, "123", _brief_with_ai_max(True), "customers/123/budgets/1")
    # default brief => Maximize Clicks (TargetSpend), not maximize_conversions
    assert hasattr(client.campaign, "target_spend")


def test_create_search_campaign_applies_cpc_ceiling() -> None:
    client = _CampaignFakeClient()
    brief = Brief.model_validate({
        "name": "konnect-test", "version": 1,
        "campaign": {"name": "konnect-test-search", "budgetMicros": 10_000_000,
                     "bidStrategy": "maximize-clicks", "cpcBidCeilingMicros": 2_000_000},
        "adGroups": _brief_with_ai_max(True).model_dump()["adGroups"],
    })
    _create_search_campaign(client, "123", brief, "customers/123/budgets/1")
    assert client.campaign.target_spend.cpc_bid_ceiling_micros == 2_000_000


def test_create_search_campaign_enables_ai_max_by_default() -> None:
    client = _CampaignFakeClient()
    _create_search_campaign(client, "123", _brief_with_ai_max(True), "customers/123/budgets/1")
    assert client.campaign.ai_max_setting.enable_ai_max is True


def test_create_search_campaign_respects_ai_max_off() -> None:
    client = _CampaignFakeClient()
    _create_search_campaign(client, "123", _brief_with_ai_max(False), "customers/123/budgets/1")
    assert client.campaign.ai_max_setting.enable_ai_max is False


def _brief_with_networks(networks: str) -> Brief:
    return Brief.model_validate({
        "name": "konnect-test",
        "version": 1,
        "campaign": {
            "name": "konnect-test-search",
            "budgetMicros": 10_000_000,
            "networkSettings": networks,
        },
        "adGroups": [{
            "name": "Ag",
            "defaultBidMicros": 1_500_000,
            "responsiveSearchAd": {
                "headlines": [{"text": f"H{i}"} for i in range(15)],
                "descriptions": [{"text": f"D{i}"} for i in range(4)],
                "finalUrl": "https://www.example.com/x",
            },
            "keywords": [{"text": "k", "matchType": "EXACT"}],
        }],
    })


def test_create_search_campaign_expands_networks_by_default() -> None:
    client = _CampaignFakeClient()
    _create_search_campaign(client, "123", _brief_with_networks("search-partners-display"), "customers/123/budgets/1")
    ns = client.campaign.network_settings
    assert ns.target_google_search is True
    assert ns.target_search_network is True  # search partners on
    assert ns.target_content_network is False  # Display Network always off


def test_create_search_campaign_search_only_keeps_search_partners() -> None:
    client = _CampaignFakeClient()
    _create_search_campaign(client, "123", _brief_with_networks("search-only"), "customers/123/budgets/1")
    ns = client.campaign.network_settings
    assert ns.target_google_search is True
    assert ns.target_search_network is True
    assert ns.target_content_network is False


from ads_skill.lib.executor import _ALL_DEVICES, _target_devices


class _DeviceFakeService:
    def __init__(self) -> None:
        self.ops: list = []

    def mutate_campaign_criteria(self, *, customer_id: str, operations: list) -> None:
        self.ops = operations


class _DeviceFakeClient:
    def __init__(self) -> None:
        self.service = _DeviceFakeService()
        self.enums = SimpleNamespace(DeviceEnum=SimpleNamespace(
            DESKTOP="DESKTOP", MOBILE="MOBILE", TABLET="TABLET", CONNECTED_TV="CONNECTED_TV"))

    def get_service(self, _name: str) -> _DeviceFakeService:
        return self.service

    def get_type(self, _name: str):  # CampaignCriterionOperation
        return SimpleNamespace(create=SimpleNamespace(
            campaign=None, bid_modifier=None, device=SimpleNamespace(type_=None)))


def test_target_devices_excludes_the_unlisted_at_minus_100() -> None:
    client = _DeviceFakeClient()
    _target_devices(client, "123", "customers/123/campaigns/9", ["computer"])
    # computer kept (no criterion); mobile/tablet/tv excluded via bid_modifier=0
    excluded_types = {op.create.device.type_ for op in client.service.ops}
    assert excluded_types == {"MOBILE", "TABLET", "CONNECTED_TV"}
    assert all(op.create.bid_modifier == 0.0 for op in client.service.ops)
    assert all(op.create.campaign == "customers/123/campaigns/9" for op in client.service.ops)


def test_target_devices_default_excludes_mobile() -> None:
    client = _DeviceFakeClient()
    # None (field omitted) => default brief: mobile excluded at -100%, rest serve
    _target_devices(client, "123", "customers/123/campaigns/9", None)
    excluded_types = {op.create.device.type_ for op in client.service.ops}
    assert excluded_types == {"MOBILE"}
    assert all(op.create.bid_modifier == 0.0 for op in client.service.ops)


def test_target_devices_noop_when_all() -> None:
    client = _DeviceFakeClient()
    # listing every device explicitly excludes nothing
    _target_devices(client, "123", "customers/123/campaigns/9", list(_ALL_DEVICES))
    assert client.service.ops == []


from ads_skill.lib.executor import _create_negative_keywords
from ads_skill.lib.schema import Keyword


class _NegFakeService:
    def __init__(self) -> None:
        self.ops: list = []

    def mutate_campaign_criteria(self, *, customer_id: str, operations: list):
        self.ops = operations
        return SimpleNamespace(results=[SimpleNamespace(resource_name=f"rn/{i}") for i in range(len(operations))])


class _NegFakeClient:
    def __init__(self) -> None:
        self.service = _NegFakeService()
        self.enums = SimpleNamespace(KeywordMatchTypeEnum=SimpleNamespace(PHRASE="PHRASE", EXACT="EXACT", BROAD="BROAD"))

    def get_service(self, _name: str) -> _NegFakeService:
        return self.service

    def get_type(self, _name: str):  # CampaignCriterionOperation
        return SimpleNamespace(create=SimpleNamespace(
            campaign=None, negative=None, keyword=SimpleNamespace(text=None, match_type=None)))


def test_create_negative_keywords_sets_negative_flag() -> None:
    client = _NegFakeClient()
    negs = [Keyword(text="jobs", matchType="PHRASE"), Keyword(text="near me", matchType="BROAD")]
    rns = _create_negative_keywords(client, "123", "customers/123/campaigns/9", negs)
    assert len(rns) == 2
    assert all(op.create.negative is True for op in client.service.ops)
    assert [op.create.keyword.text for op in client.service.ops] == ["jobs", "near me"]
    assert [op.create.keyword.match_type for op in client.service.ops] == ["PHRASE", "BROAD"]
    assert all(op.create.campaign == "customers/123/campaigns/9" for op in client.service.ops)


def test_create_negative_keywords_noop_when_empty() -> None:
    client = _NegFakeClient()
    assert _create_negative_keywords(client, "123", "customers/123/campaigns/9", []) == []
    assert client.service.ops == []


# --- price asset + structured snippet (regression for PR #43 publish bugs) ---

from ads_skill.lib.executor import _create_price_asset, _create_structured_snippet


def _brief_with_price_and_snippet() -> Brief:
    return Brief.model_validate({
        "name": "asset-test",
        "version": 1,
        "campaign": {
            "name": "asset-test-search",
            "budgetMicros": 10_000_000,
            "networkSettings": "search-only",
            "priceAsset": {
                "type": "SERVICES",
                "languageCode": "en",
                "currencyCode": "USD",
                "offerings": [
                    {"header": "One Pack", "description": "Branded SOW", "priceMicros": 249_000_000,
                     "finalUrl": "https://www.example.com/x"},
                    {"header": "Three Pack", "description": "Templates", "priceMicros": 699_000_000,
                     "finalUrl": "https://www.example.com/x"},
                    {"header": "Eight Pack", "description": "Controls", "priceMicros": 1_499_000_000,
                     "finalUrl": "https://www.example.com/x"},
                ],
            },
            "structuredSnippet": {"header": "SERVICE_CATALOG", "values": ["SOW generator", "Guardrail page", "Closeout"]},
        },
        "adGroups": [{
            "name": "Ag",
            "defaultBidMicros": 1_500_000,
            "responsiveSearchAd": {
                "headlines": [{"text": f"H{i}"} for i in range(15)],
                "descriptions": [{"text": f"D{i}"} for i in range(4)],
                "finalUrl": "https://www.example.com/x",
            },
            "keywords": [{"text": "kw", "matchType": "PHRASE"}],
        }],
    })


class _PriceFakeClient:
    def __init__(self) -> None:
        self.asset_service = _AssetService()
        self.link_service = _CampaignAssetService()
        self.enums = SimpleNamespace(
            PriceExtensionTypeEnum=SimpleNamespace(SERVICES="SERVICES"),
            AssetFieldTypeEnum=SimpleNamespace(PRICE="PRICE"),
        )

    def get_service(self, name: str):
        return self.asset_service if name == "AssetService" else self.link_service

    def get_type(self, name: str):
        if name == "AssetOperation":
            # price_offerings is a real list — a revert to `.add()` would AttributeError here.
            return SimpleNamespace(create=SimpleNamespace(
                price_asset=SimpleNamespace(type_=None, language_code=None, price_offerings=[])))
        return SimpleNamespace(create=SimpleNamespace(campaign=None, asset=None, field_type=None))


def test_create_price_asset_appends_offerings() -> None:
    client = _PriceFakeClient()
    rns = _create_price_asset(client, "123", _brief_with_price_and_snippet(), "customers/123/campaigns/9")
    offerings = client.asset_service.ops[0].create.price_asset.price_offerings
    assert len(offerings) == 3
    # dict-shaped append with the correct singular final_url key (not final_urls)
    assert offerings[0]["header"] == "One Pack"
    assert offerings[0]["final_url"] == "https://www.example.com/x"
    assert offerings[0]["price"]["amount_micros"] == 249_000_000
    assert len(rns) == 1


class _SnippetFakeClient:
    def __init__(self) -> None:
        self.asset_service = _AssetService()
        self.link_service = _CampaignAssetService()
        self.enums = SimpleNamespace(
            AssetFieldTypeEnum=SimpleNamespace(STRUCTURED_SNIPPET="STRUCTURED_SNIPPET"))

    def get_service(self, name: str):
        return self.asset_service if name == "AssetService" else self.link_service

    def get_type(self, name: str):
        if name == "AssetOperation":
            return SimpleNamespace(create=SimpleNamespace(
                structured_snippet_asset=SimpleNamespace(header=None, values=[])))
        return SimpleNamespace(create=SimpleNamespace(campaign=None, asset=None, field_type=None))


def test_create_structured_snippet_maps_header_to_string() -> None:
    client = _SnippetFakeClient()
    rns = _create_structured_snippet(client, "123", _brief_with_price_and_snippet(), "customers/123/campaigns/9")
    asset = client.asset_service.ops[0].create.structured_snippet_asset
    # header must be the API display string, not the enum-style schema name
    assert asset.header == "Service catalog"
    assert list(asset.values) == ["SOW generator", "Guardrail page", "Closeout"]
    assert len(rns) == 1


# --- positive keyword edit ops (US1) ---

from ads_skill.lib.executor import build_keyword_ops


class _AgcFakeService:
    def __init__(self) -> None:
        self.ops: list = []

    def mutate_ad_group_criteria(self, *, customer_id: str, operations: list):
        self.ops = operations
        return SimpleNamespace(results=[SimpleNamespace(resource_name=f"agc/{i}") for i in range(len(operations))])


class _AgcFakeClient:
    def __init__(self) -> None:
        self.service = _AgcFakeService()
        self.enums = SimpleNamespace(
            KeywordMatchTypeEnum=SimpleNamespace(PHRASE="PHRASE", EXACT="EXACT", BROAD="BROAD"),
            AdGroupCriterionStatusEnum=SimpleNamespace(ENABLED="ENABLED", PAUSED="PAUSED"))

    def get_service(self, _name: str) -> _AgcFakeService:
        return self.service

    def get_type(self, _name: str):  # AdGroupCriterionOperation
        return SimpleNamespace(
            create=SimpleNamespace(ad_group=None, keyword=SimpleNamespace(text=None, match_type=None)),
            update=SimpleNamespace(resource_name=None, status=None),
            update_mask=SimpleNamespace(paths=[]),
            remove=None)


def test_build_keyword_ops_create_remove_pause() -> None:
    client = _AgcFakeClient()
    ag = "customers/123/adGroups/9"
    adds = [Keyword(text="brand voice ai", matchType="PHRASE")]
    ops = build_keyword_ops(client, ag, adds, ["customers/123/adGroupCriteria/9~111"],
                            ["customers/123/adGroupCriteria/9~222"])
    # 1 create + 1 remove + 1 pause
    assert len(ops) == 3
    assert ops[0].create.ad_group == ag
    assert ops[0].create.keyword.text == "brand voice ai"
    assert ops[0].create.keyword.match_type == "PHRASE"
    assert ops[1].remove == "customers/123/adGroupCriteria/9~111"
    assert ops[2].update.status == "PAUSED"
    assert "status" in ops[2].update_mask.paths


def test_build_keyword_ops_add_only() -> None:
    client = _AgcFakeClient()
    ops = build_keyword_ops(client, "customers/1/adGroups/2",
                            [Keyword(text="dtc customer service ai", matchType="EXACT")], [], [])
    assert len(ops) == 1 and ops[0].create.keyword.match_type == "EXACT"


# ---------- set_campaign_status (campaign on/off, CHANGE 1) ----------

from ads_skill.lib.executor import set_campaign_status


class _StatusEnum:
    def __getitem__(self, name: str) -> str:
        return f"CampaignStatusEnum::{name}"


class _CampaignMutateSvc:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list]] = []

    def mutate_campaigns(self, *, customer_id: str, operations: list):
        self.calls.append((customer_id, operations))
        return SimpleNamespace(results=[SimpleNamespace(resource_name="customers/123/campaigns/9")])


class _StatusFakeClient:
    def __init__(self) -> None:
        self.svc = _CampaignMutateSvc()
        self.enums = SimpleNamespace(CampaignStatusEnum=_StatusEnum())

    def get_service(self, _name: str) -> _CampaignMutateSvc:
        return self.svc

    def get_type(self, _name: str):  # CampaignOperation
        return SimpleNamespace(
            update=SimpleNamespace(resource_name=None, status=None),
            update_mask=SimpleNamespace(paths=[]),
        )


def test_set_campaign_status_updates_status_with_mask() -> None:
    client = _StatusFakeClient()
    rn = set_campaign_status(client, "123", "9", "ENABLED")

    customer_id, ops = client.svc.calls[0]
    assert customer_id == "123"
    op = ops[0]
    assert op.update.resource_name == "customers/123/campaigns/9"
    assert op.update.status == "CampaignStatusEnum::ENABLED"
    assert list(op.update_mask.paths) == ["status"]
    assert rn == "customers/123/campaigns/9"


def test_set_campaign_status_pause_uses_pause_enum() -> None:
    client = _StatusFakeClient()
    set_campaign_status(client, "123", "9", "PAUSED")
    op = client.svc.calls[0][1][0]
    assert op.update.status == "CampaignStatusEnum::PAUSED"
    assert list(op.update_mask.paths) == ["status"]
