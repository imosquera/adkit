from __future__ import annotations

from ads_skill.lib.merge import (
    ApiIdea,
    MIN_VOLUME,
    comparison_key,
    union_candidates,
)


def _idea(phrase: str, volume: int = 20_000, comp: str = "LOW",
          low: int | None = 1_000_000, high: int | None = 2_000_000) -> ApiIdea:
    return ApiIdea(phrase=phrase, volume=volume, competition=comp, low_micros=low, high_micros=high)


def test_comparison_key_collapses_case_and_whitespace() -> None:
    assert comparison_key("Buy Now") == comparison_key("buy  now")
    assert comparison_key("  Sell My CAR  ") == "sell my car"


def test_union_drops_zero_volume_api_phrases() -> None:
    result = union_candidates(llm=(), api=[_idea("dead phrase", volume=0)])
    assert result == ()


def test_union_drops_api_below_min_volume() -> None:
    result = union_candidates(llm=(), api=[_idea("low vol", volume=MIN_VOLUME - 1)])
    assert result == ()


def test_union_keeps_api_at_min_volume() -> None:
    result = union_candidates(llm=(), api=[_idea("ok vol", volume=MIN_VOLUME)])
    assert len(result) == 1
    assert result[0].volume == MIN_VOLUME


def test_union_drops_api_phrases_over_80_chars() -> None:
    long = "a" * 81
    result = union_candidates(llm=(), api=[_idea(long, volume=50_000)])
    assert result == ()


def test_union_attributes_api_metrics_to_matching_llm_phrase() -> None:
    result = union_candidates(
        llm=["Buy Now"],
        api=[_idea("buy  now", volume=36_000, comp="HIGH", low=8_000_000, high=14_000_000)],
    )
    assert len(result) == 1
    c = result[0]
    assert c.phrase == "Buy Now"  # LLM casing preserved
    assert c.source == "both"
    assert c.volume == 36_000
    assert c.competition == "HIGH"


def test_union_keeps_api_only_phrases_and_drops_bare_llm() -> None:
    result = union_candidates(
        llm=["coffee maker"],  # no API backing → dropped, not kept bare
        api=[_idea("espresso machine", volume=20_000)],
    )
    phrases = {c.phrase for c in result}
    assert phrases == {"espresso machine"}


def test_union_drops_bare_llm_with_no_api_match() -> None:
    result = union_candidates(llm=["niche phrase"], api=())
    assert result == ()


