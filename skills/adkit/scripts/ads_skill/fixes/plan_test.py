"""Unit tests for the SDK-free validation/coercion in ads_skill.fixes.plan."""
from __future__ import annotations

from ads_skill.fixes.plan import (
    _ad_group_status_plan,
    _campaign_status_plan,
    _coerce_keyword,
    _neg_key,
    _new_negatives,
    _new_positive_keywords,
    _pos_key,
    _validate,
)


def _h(n: int) -> list[str]:
    return [f"headline {i}" for i in range(n)]


def _d(n: int) -> list[str]:
    return [f"description {i}" for i in range(n)]


# ---------- rewrites ----------

def test_rewrite_valid_passes() -> None:
    plan = {"rewrites": [{"adId": 1, "headlines": _h(15), "descriptions": _d(4)}]}
    assert _validate(plan, {}, {}) == []


def test_rewrite_wrong_counts_flagged() -> None:
    plan = {"rewrites": [{"adId": 1, "headlines": _h(14), "descriptions": _d(3)}]}
    errs = _validate(plan, {}, {})
    assert any("14 headlines" in e for e in errs)
    assert any("3 descriptions" in e for e in errs)


def test_rewrite_duplicate_and_overlength_flagged() -> None:
    hs = _h(14) + ["headline 0"]          # 15 but one dup
    ds = _d(3) + ["x" * 91]               # 4 but one >90
    errs = _validate({"rewrites": [{"adId": 1, "headlines": hs, "descriptions": ds}]}, {}, {})
    assert any("duplicate headline" in e for e in errs)
    assert any("description >90" in e for e in errs)


def test_rewrite_headline_over_30_flagged() -> None:
    hs = _h(14) + ["x" * 31]
    errs = _validate({"rewrites": [{"adId": 1, "headlines": hs, "descriptions": _d(4)}]}, {}, {})
    assert any("headline >30" in e for e in errs)


# ---------- appendHeadlines ----------

def test_append_to_15_passes() -> None:
    plan = {"appendHeadlines": [{"adId": 9, "add": ["new one"]}]}
    live = {9: _h(14)}
    assert _validate(plan, live, {}) == []


def test_append_overshoot_flagged() -> None:
    plan = {"appendHeadlines": [{"adId": 9, "add": ["a", "b"]}]}  # 14 + 2 = 16
    errs = _validate(plan, {9: _h(14)}, {})
    assert any("16H" in e for e in errs)


def test_append_dedups_existing_then_short() -> None:
    # adding a headline that already exists doesn't count → stays at 14 → flagged
    plan = {"appendHeadlines": [{"adId": 9, "add": ["headline 0"]}]}
    errs = _validate(plan, {9: _h(14)}, {})
    assert any("14H" in e for e in errs)


# ---------- sitelinks & callouts ----------

def test_sitelink_both_or_neither_and_lengths() -> None:
    plan = {"sitelinks": [{"campaignId": 1, "add": [
        {"text": "x" * 26, "description1": "only one"},   # text >25 AND lone description
    ]}]}
    errs = _validate(plan, {}, {})
    assert any("sitelink text >25" in e for e in errs)
    assert any("both-or-neither" in e for e in errs)


def test_sitelink_description_overlength_flagged() -> None:
    plan = {"sitelinks": [{"campaignId": 1, "add": [
        {"text": "ok", "description1": "x" * 36, "description2": "y"},  # d1 >35
    ]}]}
    errs = _validate(plan, {}, {})
    assert any("sitelink desc >35" in e for e in errs)


def test_callout_overlength_flagged() -> None:
    errs = _validate({"callouts": [{"campaignId": 1, "add": ["x" * 26]}]}, {}, {})
    assert any("callout >25" in e for e in errs)


# ---------- coercion ----------

def test_coerce_keyword_bare_string_defaults_phrase() -> None:
    kw, err = _coerce_keyword("free trial")
    assert err is None and kw.text == "free trial" and kw.matchType == "PHRASE"


def test_coerce_keyword_rejects_non_string_non_dict() -> None:
    kw, err = _coerce_keyword(123)
    assert kw is None and "string or object" in err


def test_neg_key_is_case_insensitive_on_text() -> None:
    assert _neg_key("Free Trial", "PHRASE") == ("free trial", "PHRASE")


# ---------- negative keywords ----------

def test_negatives_string_and_object_valid() -> None:
    plan = {"negatives": [{"campaignId": 1, "add": ["free", {"text": "talk to ai", "matchType": "PHRASE"}]}]}
    assert _validate(plan, {}, {}) == []


def test_negatives_matchtype_case_insensitive() -> None:
    kw, err = _coerce_keyword({"text": "roleplay", "matchType": "exact"})
    assert err is None and kw.matchType == "EXACT"


def test_negatives_bad_matchtype_flagged() -> None:
    errs = _validate({"negatives": [{"campaignId": 1, "add": [{"text": "x", "matchType": "FUZZY"}]}]}, {}, {})
    assert any("FUZZY" in e or "matchType" in e.lower() for e in errs)


def test_negatives_missing_campaign_and_empty_add_flagged() -> None:
    errs = _validate({"negatives": [{"add": ["free"]}, {"campaignId": 2, "add": []}]}, {}, {})
    assert any("missing campaignId" in e for e in errs)
    assert any("empty add list" in e for e in errs)


def test_new_negatives_skips_live_duplicates() -> None:
    group = {"campaignId": 5, "add": ["free", {"text": "Talk To AI", "matchType": "PHRASE"}, "novel"]}
    live = {5: {("free", "PHRASE"), ("talk to ai", "PHRASE")}}  # case-insensitive match
    fresh = _new_negatives(group, live)
    assert [k.text for k in fresh] == ["novel"]


def test_new_negatives_dedups_within_group() -> None:
    # repeats + case variants collapse to one op so the batch has no duplicates
    group = {"campaignId": 5, "add": ["free", "free", {"text": "Free", "matchType": "PHRASE"}, "novel"]}
    fresh = _new_negatives(group, {})
    assert [k.text for k in fresh] == ["free", "novel"]


def test_new_negatives_distinct_match_types_kept() -> None:
    group = {"campaignId": 5, "add": [{"text": "free", "matchType": "PHRASE"},
                                      {"text": "free", "matchType": "EXACT"}]}
    fresh = _new_negatives(group, {})
    assert [(k.text, k.matchType) for k in fresh] == [("free", "PHRASE"), ("free", "EXACT")]


def test_new_negatives_non_numeric_campaign_does_not_raise() -> None:
    # validation flags it; _new_negatives must not crash building the dry-run summary
    assert _new_negatives({"campaignId": "abc", "add": ["free"]}, {}) != []


def test_negatives_non_numeric_campaign_flagged() -> None:
    errs = _validate({"negatives": [{"campaignId": "23x", "add": ["free"]}]}, {}, {})
    assert any("must be numeric" in e for e in errs)


# ---------- budget guardrail ----------

_BUDGETS = {5: {"resource": "r", "amountMicros": 30_000_000}}  # $30/day


def test_budget_within_50pct_passes() -> None:
    plan = {"budgets": [{"campaignId": 5, "dailyMicros": 45_000_000}]}  # exactly +50%
    assert _validate(plan, {}, _BUDGETS) == []


def test_budget_over_50pct_rejected() -> None:
    plan = {"budgets": [{"campaignId": 5, "dailyMicros": 46_000_000}]}
    assert any("exceeds guardrail" in e for e in _validate(plan, {}, _BUDGETS))


def test_budget_maxraisepct_cannot_exceed_hard_cap() -> None:
    # plan asks for 200% headroom; hard cap clamps to 50% → $60 still rejected vs $45
    plan = {"budgets": [{"campaignId": 5, "dailyMicros": 60_000_000, "maxRaisePct": 200}]}
    errs = _validate(plan, {}, _BUDGETS)
    assert any("+50%" in e for e in errs)


def test_budget_lowering_always_allowed() -> None:
    plan = {"budgets": [{"campaignId": 5, "dailyMicros": 10_000_000}]}
    assert _validate(plan, {}, _BUDGETS) == []


def test_budget_non_positive_and_missing_current_flagged() -> None:
    bad = _validate({"budgets": [{"campaignId": 5, "dailyMicros": 0}]}, {}, _BUDGETS)
    assert any("positive int" in e for e in bad)
    missing = _validate({"budgets": [{"campaignId": 7, "dailyMicros": 1_000_000}]}, {}, _BUDGETS)
    assert any("no current budget" in e for e in missing)


# ---------- positive keywords (US1) ----------

# live ad-group positive keywords: {adGroupId: {(text.lower, matchType)}}
_LIVE_POS = {12345: {("ai writing", "BROAD"), ("ai chatbot", "PHRASE")}}


def test_keywords_add_phrase_valid_passes() -> None:
    plan = {"keywords": [{"adGroupId": 12345, "add": [{"text": "brand voice ai", "matchType": "PHRASE"}]}]}
    assert _validate(plan, {}, {}, _LIVE_POS) == []


def test_keywords_missing_adgroup_and_empty_ops_flagged() -> None:
    errs = _validate({"keywords": [{"add": ["x"]}, {"adGroupId": 12345}]}, {}, {}, _LIVE_POS)
    assert any("missing adGroupId" in e for e in errs)
    assert any("empty operation lists" in e for e in errs)


def test_keywords_non_numeric_adgroup_flagged() -> None:
    errs = _validate({"keywords": [{"adGroupId": "9x", "add": ["a"]}]}, {}, {}, _LIVE_POS)
    assert any("must be numeric" in e for e in errs)


def test_keywords_bad_add_matchtype_flagged() -> None:
    errs = _validate({"keywords": [{"adGroupId": 12345, "add": [{"text": "x", "matchType": "FUZZY"}]}]},
                     {}, {}, _LIVE_POS)
    assert any("matchType" in e.lower() or "FUZZY" in e for e in errs)


def test_keywords_remove_absent_keyword_rejected() -> None:
    # acceptance scenario 6 / edge case: removing a keyword not on the ad group is rejected
    plan = {"keywords": [{"adGroupId": 12345, "remove": [{"text": "nope", "matchType": "EXACT"}]}]}
    errs = _validate(plan, {}, {}, _LIVE_POS)
    assert any("not present on the ad group" in e for e in errs)


def test_keywords_remove_present_keyword_passes() -> None:
    plan = {"keywords": [{"adGroupId": 12345, "remove": [{"text": "AI Writing", "matchType": "BROAD"}]}]}
    assert _validate(plan, {}, {}, _LIVE_POS) == []


def test_keywords_match_type_change_remove_plus_add_passes() -> None:
    # acceptance scenario 4: change match type = remove broad + add phrase of same text
    plan = {"keywords": [{"adGroupId": 12345,
                          "remove": [{"text": "ai writing", "matchType": "BROAD"}],
                          "add": [{"text": "ai writing", "matchType": "PHRASE"}]}]}
    assert _validate(plan, {}, {}, _LIVE_POS) == []


def test_new_positive_keywords_skips_live_and_dedups_within_group() -> None:
    group = {"adGroupId": 12345, "add": [
        {"text": "AI Writing", "matchType": "BROAD"},   # already live (case-insensitive) → skip
        "novel keyword",                                 # bare string → PHRASE, fresh
        "novel keyword",                                 # in-group dup → collapse
    ]}
    fresh = _new_positive_keywords(group, _LIVE_POS)
    assert [(k.text, k.matchType) for k in fresh] == [("novel keyword", "PHRASE")]


def test_new_positive_keywords_match_type_change_not_collide() -> None:
    # removing broad then adding phrase of the same text: the add is fresh (different MT)
    group = {"adGroupId": 12345, "add": [{"text": "ai writing", "matchType": "PHRASE"}]}
    fresh = _new_positive_keywords(group, _LIVE_POS)
    assert [(k.text, k.matchType) for k in fresh] == [("ai writing", "PHRASE")]


def test_pos_key_includes_match_type() -> None:
    assert _pos_key("AI Writing", "BROAD") == ("ai writing", "BROAD")


# ---------- campaignStatus (campaign on/off, CHANGE 1) ----------

def test_campaign_status_plan_splits_changes_and_skips() -> None:
    blocks = [
        {"campaignId": "1", "status": "ENABLED"},   # currently PAUSED -> change
        {"campaignId": "2", "status": "PAUSED"},    # currently PAUSED -> skip (no-op)
        {"campaignId": "3", "status": "PAUSED"},    # currently ENABLED -> change
    ]
    live = {1: "PAUSED", 2: "PAUSED", 3: "ENABLED"}
    changes, skips = _campaign_status_plan(blocks, live)
    assert [c["campaignId"] for c in changes] == ["1", "3"]
    assert [c["current"] for c in changes] == ["PAUSED", "ENABLED"]
    assert [s["campaignId"] for s in skips] == ["2"]


def test_campaign_status_plan_unknown_live_status_is_a_change() -> None:
    # No live status read (campaign not in the map) => never a no-op skip.
    changes, skips = _campaign_status_plan([{"campaignId": "9", "status": "ENABLED"}], {})
    assert len(changes) == 1 and skips == []
    assert changes[0]["current"] is None


def test_campaign_status_validation_valid_passes() -> None:
    plan = {"campaignStatus": [{"campaignId": "123", "status": "ENABLED"},
                               {"campaignId": 456, "status": "PAUSED"}]}
    assert _validate(plan, {}, {}) == []


def test_campaign_status_validation_rejects_bad_status_and_id() -> None:
    plan = {"campaignStatus": [{"campaignId": "abc", "status": "ENABLED"},
                               {"campaignId": "123", "status": "LIVE"}]}
    errs = _validate(plan, {}, {})
    assert any("abc" in e for e in errs)
    assert any("123" in e and "status" in e for e in errs)


# ---------- adGroupStatus (ad group on/off) ----------

def test_ad_group_status_plan_splits_changes_and_skips() -> None:
    blocks = [
        {"adGroupId": "1", "status": "ENABLED"},   # currently PAUSED -> change
        {"adGroupId": "2", "status": "PAUSED"},     # currently PAUSED -> skip (no-op)
        {"adGroupId": "3", "status": "PAUSED"},     # currently ENABLED -> change
    ]
    live = {1: "PAUSED", 2: "PAUSED", 3: "ENABLED"}
    changes, skips = _ad_group_status_plan(blocks, live)
    assert [c["adGroupId"] for c in changes] == ["1", "3"]
    assert [c["current"] for c in changes] == ["PAUSED", "ENABLED"]
    assert [s["adGroupId"] for s in skips] == ["2"]


def test_ad_group_status_plan_unknown_live_status_is_a_change() -> None:
    # No live status read (ad group not in the map) => never a no-op skip.
    changes, skips = _ad_group_status_plan([{"adGroupId": "9", "status": "PAUSED"}], {})
    assert len(changes) == 1 and skips == []
    assert changes[0]["current"] is None


def test_ad_group_status_validation_valid_passes() -> None:
    plan = {"adGroupStatus": [{"adGroupId": "789", "status": "PAUSED"},
                              {"adGroupId": 200325112680, "status": "ENABLED"}]}
    assert _validate(plan, {}, {}) == []


def test_ad_group_status_validation_rejects_bad_status_and_id() -> None:
    plan = {"adGroupStatus": [{"adGroupId": "xyz", "status": "PAUSED"},
                              {"adGroupId": "789", "status": "OFF"}]}
    errs = _validate(plan, {}, {})
    assert any("xyz" in e for e in errs)
    assert any("789" in e and "status" in e for e in errs)
