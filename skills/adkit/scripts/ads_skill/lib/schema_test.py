from __future__ import annotations

import pytest
from pydantic import ValidationError

from ads_skill.lib.schema import Brief


def _ad_group(name: str = "Waitlist Core", root: str = "vontevo") -> dict:
    return {
        "name": name,
        "defaultBidMicros": 1_500_000,
        "responsiveSearchAd": {
            "headlines": [{"text": f"Vontevo headline {i}"} for i in range(15)],
            "descriptions": [{"text": f"Vontevo description {i}"} for i in range(4)],
            "finalUrl": "https://www.example.com/waitlist",
        },
        "keywords": [
            {"text": root, "matchType": "PHRASE"},
            {"text": root, "matchType": "EXACT"},
        ],
    }


def _valid_brief_dict() -> dict:
    return {
        "name": "vontevo-waitlist-q3",
        "version": 1,
        "campaign": {
            "name": "Vontevo Waitlist Q3",
            "budgetMicros": 10_000_000,
            "networkSettings": "search-only",
        },
        "adGroups": [_ad_group()],
    }


def test_valid_brief_parses() -> None:
    Brief.model_validate(_valid_brief_dict())


def test_brief_at_max_ad_groups_parses() -> None:
    from ads_skill.lib.schema import MAX_AD_GROUPS
    raw = _valid_brief_dict()
    raw["adGroups"] = [
        _ad_group(name=f"Ag-{i}", root=f"root-{i}") for i in range(MAX_AD_GROUPS)
    ]
    Brief.model_validate(raw)


def test_brief_over_max_ad_groups_rejected() -> None:
    from ads_skill.lib.schema import MAX_AD_GROUPS
    raw = _valid_brief_dict()
    raw["adGroups"] = [_ad_group(name=f"Ag-{i}", root=f"root-{i}") for i in range(MAX_AD_GROUPS + 1)]
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_brief_with_zero_ad_groups_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"] = []
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_duplicate_ad_group_names_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"] = [_ad_group(name="Same"), _ad_group(name="Same", root="x")]
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_unknown_top_level_key_rejected() -> None:
    raw = _valid_brief_dict()
    raw["extraField"] = "nope"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_invalid_name_pattern_rejected() -> None:
    raw = _valid_brief_dict()
    raw["name"] = "Has_Underscores_Caps"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_non_https_final_url_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["finalUrl"] = "http://www.example.com/waitlist"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_display_paths_omitted_by_default() -> None:
    brief = Brief.model_validate(_valid_brief_dict())
    rsa = brief.adGroups[0].responsiveSearchAd
    assert rsa.path1 is None and rsa.path2 is None


def test_display_paths_parse_and_lowercase() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["path1"] = "Review-Replies"
    raw["adGroups"][0]["responsiveSearchAd"]["path2"] = "Free-Trial"
    brief = Brief.model_validate(raw)
    rsa = brief.adGroups[0].responsiveSearchAd
    # mixed-case input is coerced to lower case
    assert rsa.path1 == "review-replies" and rsa.path2 == "free-trial"


def test_display_path_over_15_chars_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["path1"] = "WayTooLongPathSegment"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_display_path_with_slash_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["path1"] = "a/b"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_display_path_with_space_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["path1"] = "free trial"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_display_path2_without_path1_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["path2"] = "Free-Trial"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_display_path_todo_placeholder_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["path1"] = "TODO-keyword"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_too_few_headlines_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["headlines"] = (
        raw["adGroups"][0]["responsiveSearchAd"]["headlines"][:14]
    )
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_duplicate_headlines_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["headlines"][1] = {"text": "Vontevo headline 0"}
    with pytest.raises(ValidationError, match="headlines must be unique"):
        Brief.model_validate(raw)


def test_pinned_headline_rejected() -> None:
    # Pinning is disabled skill-wide; pin is locked to "NONE".
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["headlines"][0] = {
        "text": "Vontevo headline 0", "pin": "HEADLINE_1"
    }
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_pinned_description_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["descriptions"][0] = {
        "text": "A description ending in act now.", "pin": "DESCRIPTION_1"
    }
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_too_many_descriptions_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["responsiveSearchAd"]["descriptions"] = [
        {"text": f"D{i}"} for i in range(5)
    ]
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_version_must_be_positive() -> None:
    raw = _valid_brief_dict()
    raw["version"] = 0
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)




def test_default_bid_strategy_is_maximize_clicks() -> None:
    # new campaigns launch on Maximize Clicks to seed conversion data (cold-start escape)
    brief = Brief.model_validate(_valid_brief_dict())
    assert brief.campaign.bidStrategy == "maximize-clicks"


def test_cpc_ceiling_requires_maximize_clicks() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "maximize-conversions"
    raw["campaign"]["cpcBidCeilingMicros"] = 2_000_000
    with pytest.raises(ValidationError, match="cpcBidCeilingMicros only valid"):
        Brief.model_validate(raw)


def test_cpc_ceiling_ok_with_maximize_clicks() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "maximize-clicks"
    raw["campaign"]["cpcBidCeilingMicros"] = 2_000_000
    Brief.model_validate(raw)


def test_manual_cpc_bid_strategy_parses() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "manual-cpc"
    brief = Brief.model_validate(raw)
    assert brief.campaign.bidStrategy == "manual-cpc"


def test_target_cpa_requires_target_cpa_micros() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "target-cpa"
    with pytest.raises(ValidationError, match="targetCpaMicros"):
        Brief.model_validate(raw)


def test_target_cpa_with_target_cpa_micros_ok() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "target-cpa"
    raw["campaign"]["targetCpaMicros"] = 5_000_000
    Brief.model_validate(raw)


def test_target_roas_requires_target_roas() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "target-roas"
    with pytest.raises(ValidationError, match="targetRoas"):
        Brief.model_validate(raw)


def test_target_roas_with_target_roas_ok() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "target-roas"
    raw["campaign"]["targetRoas"] = 4.0
    Brief.model_validate(raw)


def test_target_cpa_micros_rejected_when_strategy_does_not_need_it() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "maximize-conversions"
    raw["campaign"]["targetCpaMicros"] = 5_000_000
    with pytest.raises(ValidationError, match="targetCpaMicros only valid"):
        Brief.model_validate(raw)


def test_unknown_bid_strategy_rejected() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["bidStrategy"] = "secret-sauce"
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def _sitelink(text: str = "How It Works") -> dict:
    return {"text": text, "finalUrl": "https://www.example.com/page.html"}


def test_six_sitelinks_ok() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["sitelinks"] = [_sitelink(f"Link {i}") for i in range(6)]
    Brief.model_validate(raw)


def test_zero_sitelinks_ok_legacy() -> None:
    Brief.model_validate(_valid_brief_dict())  # no sitelinks key


def test_five_sitelinks_rejected() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["sitelinks"] = [_sitelink(f"Link {i}") for i in range(5)]
    with pytest.raises(ValidationError, match="exactly 6"):
        Brief.model_validate(raw)


def test_seven_sitelinks_rejected() -> None:
    raw = _valid_brief_dict()
    raw["campaign"]["sitelinks"] = [_sitelink(f"Link {i}") for i in range(7)]
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_sitelink_text_over_25_chars_rejected() -> None:
    raw = _valid_brief_dict()
    sl = [_sitelink(f"Link {i}") for i in range(6)]
    sl[0]["text"] = "x" * 26
    raw["campaign"]["sitelinks"] = sl
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_sitelink_one_description_rejected() -> None:
    raw = _valid_brief_dict()
    sl = [_sitelink(f"Link {i}") for i in range(6)]
    sl[0]["description1"] = "only one line"
    raw["campaign"]["sitelinks"] = sl
    with pytest.raises(ValidationError, match="both description1 and description2"):
        Brief.model_validate(raw)


def test_default_bid_over_15_dollars_rejected() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["defaultBidMicros"] = 15_000_001
    with pytest.raises(ValidationError):
        Brief.model_validate(raw)


def test_default_bid_at_15_dollars_ok() -> None:
    raw = _valid_brief_dict()
    raw["adGroups"][0]["defaultBidMicros"] = 15_000_000
    Brief.model_validate(raw)
