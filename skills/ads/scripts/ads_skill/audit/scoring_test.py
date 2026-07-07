"""Unit tests for the pure scoring/detection logic in audit.scoring — no google-ads needed."""
from __future__ import annotations

import pytest

from ads_skill.audit.scoring import (
    _cannibalization,
    _concept_words,
    _differentiation_gaps,
    _path_to_excellent,
    _require_digits,
)


# ---------- me-too copy (US5) ----------

def test_differentiation_flags_generic_copy_with_missing_axes() -> None:
    f = _differentiation_gaps(["AI Writer for everyone", "Best AI chatbot"], ["Generate content fast"])
    assert f is not None
    assert set(f["missingAxes"]) == {"integration", "consistency", "outcome"}


def test_differentiation_not_flagged_when_all_axes_present() -> None:
    hs = ["Voice-matched replies in your CRM", "On-brand replies, every channel"]
    ds = ["Integrates with HubSpot to lift your reply rate and conversions"]
    assert _differentiation_gaps(hs, ds) is None


def test_differentiation_not_flagged_when_not_generic() -> None:
    assert _differentiation_gaps(["DTC customer service software"], ["Built for CPG brands"]) is None


# ---------- _concept_words ----------

def test_concept_words_prefers_keywords() -> None:
    assert _concept_words("Commercial", ["best ai chatbot", "ai bot"]) == [
        "best", "chatbot", "bot",  # >2 chars, "ai" dropped
    ]


def test_concept_words_falls_back_to_name_when_not_a_tier() -> None:
    assert _concept_words("Best Ai Chatbot", []) == ["best", "chatbot"]


def test_concept_words_empty_for_bare_tier_name_without_keywords() -> None:
    # tier names are intent labels, not keywords — never score against them
    assert _concept_words("Commercial", []) == []
    assert _concept_words("transactional", []) == []


# ---------- _path_to_excellent ----------

def _full_h():  # 15 distinct headlines, all containing "chatbot"
    return [f"ai chatbot {i}" for i in range(15)]


def test_path_flags_underfill() -> None:
    steps = _path_to_excellent("Best Ai Chatbot", ["ai chatbot"], ["a", "b"], ["d"],
                               [], [], [], [], [], "POOR")
    joined = " ".join(steps)
    assert "Add 13 more headlines" in joined
    assert "Add 3 more descriptions" in joined


def test_path_flags_keyword_inclusion_gap() -> None:
    # 15 headlines, none contain the keyword "chatbot"
    hs = [f"generic line {i}" for i in range(15)]
    steps = _path_to_excellent("Best Ai Chatbot", ["ai chatbot"], hs, ["a", "b", "c", "d"],
                               [], [], [], [], [], "POOR")
    assert any("in >=3 headlines" in s for s in steps)


def test_path_dedups_google_hint_against_emitted_step() -> None:
    # under-filled headlines already emitted → Google's headline hint is skipped
    steps = _path_to_excellent("Best Ai Chatbot", ["ai chatbot"], ["a"], ["a", "b", "c", "d"],
                               [], [], [], [],
                               ["Try including more keywords in your headlines."], "POOR")
    assert not any(s.startswith("Google says") for s in steps)


def test_path_keeps_unrelated_google_hint() -> None:
    steps = _path_to_excellent("Best Ai Chatbot", ["ai chatbot"], _full_h(),
                               ["a", "b", "c", "d"], [], [], [], [],
                               ["Add 6 more sitelinks in your ad"], "GOOD")
    assert any("Google says: Add 6 more sitelinks" in s for s in steps)


def test_path_empty_for_excellent_full_ad() -> None:
    steps = _path_to_excellent("Best Ai Chatbot", ["ai chatbot"], _full_h(),
                               ["a", "b", "c", "d"], [], [], [], [], [], "EXCELLENT")
    assert steps == []


def test_path_flags_dup_echo_banned_and_pins_on_known_bad_ad() -> None:
    # a fully-loaded-but-contaminated ad: dup headline, echoing description,
    # banned phrase, and a pinned asset must each surface as their own step.
    hs = ["ai chatbot offer"] * 15  # 15 entries but all identical -> duplicate
    ds = ["ai chatbot offer", "b", "c", "d"]  # first echoes a headline
    steps = _path_to_excellent("Best Ai Chatbot", ["ai chatbot"], hs, ds,
                               dup_h=["ai chatbot offer"], echo=["ai chatbot offer"],
                               banned_hit=["Portugal"], pins=["pinned head"],
                               action_items=[], strength="GOOD")
    joined = " ".join(steps)
    assert "Replace duplicate headlines" in joined
    assert "Rewrite descriptions that just echo a headline" in joined
    assert "Remove off-product / contaminated copy" in joined
    assert "Unpin all assets" in joined


# ---------- _cannibalization ----------

def test_cannibalization_flags_shared_keyword_and_names_starved() -> None:
    serving = [
        {"campaignId": 1, "campaignName": "lineal-search", "impressions": 2500},
        {"campaignId": 2, "campaignName": "lineal-stag-search", "impressions": 0},
    ]
    kw = {1: {"ag": ["Retail Data Analytics"]}, 2: {"ag": ["retail data analytics", "other"]}}
    pairs = _cannibalization(serving, kw)
    assert len(pairs) == 1
    assert pairs[0]["shared"] == ["retail data analytics"]
    assert pairs[0]["starvedLikely"] == "lineal-stag-search"  # lower impressions


def test_cannibalization_no_overlap_no_pairs() -> None:
    serving = [
        {"campaignId": 1, "campaignName": "a", "impressions": 10},
        {"campaignId": 2, "campaignName": "b", "impressions": 20},
    ]
    kw = {1: {"ag": ["alpha"]}, 2: {"ag": ["beta"]}}
    assert _cannibalization(serving, kw) == []


def test_cannibalization_overlap_across_three_campaigns_yields_all_pairs() -> None:
    # three campaigns sharing one keyword -> 3 unordered pairs, each flagged.
    serving = [
        {"campaignId": 1, "campaignName": "a", "impressions": 30},
        {"campaignId": 2, "campaignName": "b", "impressions": 20},
        {"campaignId": 3, "campaignName": "c", "impressions": 10},
    ]
    kw = {
        1: {"ag": ["shared kw", "alpha"]},
        2: {"ag": ["Shared KW"]},
        3: {"ag": ["shared kw", "gamma"]},
    }
    pairs = _cannibalization(serving, kw)
    assert len(pairs) == 3
    assert all(p["shared"] == ["shared kw"] for p in pairs)
    # the lowest-impression member of each pair is named as starved
    by_members = {frozenset((p["a"], p["b"])): p["starvedLikely"] for p in pairs}
    assert by_members[frozenset(("a", "b"))] == "b"
    assert by_members[frozenset(("a", "c"))] == "c"
    assert by_members[frozenset(("b", "c"))] == "c"


# ---------- _require_digits ----------

def test_require_digits_accepts_digits_and_none() -> None:
    _require_digits("customer", "8911925499")
    _require_digits("campaign", None)  # absent is fine


def test_require_digits_rejects_injection() -> None:
    with pytest.raises(SystemExit):
        _require_digits("campaign", "1 OR 1=1")
