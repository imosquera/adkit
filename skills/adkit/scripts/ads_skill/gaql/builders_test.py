"""Unit tests for the keyword GAQL builders — pure string functions."""
from __future__ import annotations

import pytest

from ads_skill.gaql.builders import (
    apply_positive_keywords_query,
    audit_search_terms_query,
)


def test_audit_search_terms_query_digits_only_guard() -> None:
    with pytest.raises(ValueError):
        audit_search_terms_query(7, ["123", "4x"])


def test_audit_search_terms_query_selects_terms_over_window() -> None:
    q = audit_search_terms_query(14, ["12345", "67890"])
    assert "FROM search_term_view" in q
    assert "campaign.id IN (12345,67890)" in q
    assert "search_term_view.search_term" in q
    assert "metrics.cost_micros" in q
    assert "segments.date DURING LAST_14_DAYS" in q


def test_positive_keywords_query_digits_only_guard() -> None:
    with pytest.raises(ValueError):
        apply_positive_keywords_query(["123", "4x"])


def test_positive_keywords_query_selects_non_negative_keyword_criteria() -> None:
    q = apply_positive_keywords_query(["12345", "67890"])
    assert "ad_group.id IN (12345,67890)" in q
    assert "ad_group_criterion.negative = FALSE" in q
    assert "ad_group_criterion.type = KEYWORD" in q
    assert "ad_group_criterion.status != 'REMOVED'" in q
