from __future__ import annotations

from ads_skill.lib.markdown import format_bullet_text
from ads_skill.lib.merge import Candidate


def test_decorated_bullet_full_form() -> None:
    c = Candidate(
        phrase="single keyword ad group",
        source="both",
        volume=3600,
        competition="HIGH",
        low_micros=8_200_000,
        high_micros=14_000_000,
    )
    assert format_bullet_text(c) == "single keyword ad group (3.6k, HIGH, $8.20–$14.00)"


def test_undecorated_bullet_is_bare_phrase() -> None:
    c = Candidate(phrase="long tail variant", source="llm")
    assert format_bullet_text(c) == "long tail variant"


def test_decorated_bullet_with_missing_cpc_high() -> None:
    c = Candidate(
        phrase="info query",
        source="api",
        volume=150,
        competition="LOW",
        low_micros=500_000,
        high_micros=None,
    )
    assert format_bullet_text(c) == "info query (150, LOW, $0.50–$–)"


def test_deterministic() -> None:
    c = Candidate(
        phrase="x",
        source="both",
        volume=1_500_000,
        competition="MEDIUM",
        low_micros=1_000_000,
        high_micros=2_000_000,
    )
    assert format_bullet_text(c) == format_bullet_text(c)
