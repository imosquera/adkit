"""Unit tests for the immutable differentiation reference (no SDK needed)."""
from __future__ import annotations

from ads_skill.lib.brand import (
    DIFFERENTIATION_AXES,
    GENERIC_AI_PHRASES,
)


def test_differentiation_axes_are_the_three_expected() -> None:
    assert tuple(a.name for a in DIFFERENTIATION_AXES) == ("integration", "consistency", "outcome")
    # every axis carries at least one trigger lexeme
    assert all(a.triggers for a in DIFFERENTIATION_AXES)


def test_generic_ai_phrases_present() -> None:
    assert "ai writer" in GENERIC_AI_PHRASES and "ai chatbot" in GENERIC_AI_PHRASES
