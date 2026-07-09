"""Tests for the data-driven cluster analysis shared by report and audit.

Pure-function tests — feed performance rows, assert the proposals. No IO."""

from __future__ import annotations

from ads_skill.lib.cluster import (
    cluster_split_recommendation,
    keywords_to_promote,
    negatives_to_add,
)


def _st(term: str, *, clicks: int = 0, conversions: float = 0.0, cost: float = 0.0,
        impressions: int = 0, ad_group_id: str = "1") -> dict:
    return {
        "search_term": term, "ad_group_id": ad_group_id, "clicks": clicks,
        "conversions": conversions, "cost": cost, "impressions": impressions,
    }


class TestKeywordsToPromote:
    def test_promotes_converting_and_clicked_terms(self) -> None:
        rows = [
            _st("online reputation software", clicks=5, conversions=2, cost=40),
            _st("reputation monitoring", clicks=4, conversions=0, cost=12),
            _st("free review widget", clicks=1, conversions=0, cost=1),  # below bar
        ]
        out = keywords_to_promote(rows)
        texts = [p["text"] for p in out]
        assert texts == ["online reputation software", "reputation monitoring"]
        assert all(p["matchType"] == "PHRASE" for p in out)

    def test_excludes_existing_keywords_case_insensitively(self) -> None:
        rows = [_st("Online Reputation Software", clicks=9, conversions=3, cost=50)]
        out = keywords_to_promote(rows, [{"text": "online reputation software"}])
        assert out == []

    def test_aggregates_same_term_across_ad_groups(self) -> None:
        rows = [
            _st("review software", clicks=2, conversions=0, cost=6, ad_group_id="1"),
            _st("review software", clicks=2, conversions=1, cost=8, ad_group_id="2"),
        ]
        out = keywords_to_promote(rows)
        assert len(out) == 1
        assert out[0]["clicks"] == 4
        assert out[0]["conversions"] == 1.0
        assert out[0]["cost"] == 14.0

    def test_sorted_strongest_first_and_capped_by_limit(self) -> None:
        rows = [_st(f"kw {i}", clicks=10, conversions=i) for i in range(5)]
        out = keywords_to_promote(rows, limit=2)
        assert [p["text"] for p in out] == ["kw 4", "kw 3"]


class TestNegativesToAdd:
    def test_flags_zero_conversion_spend(self) -> None:
        rows = [
            _st("cheap reviews free", clicks=6, conversions=0, cost=9),
            _st("reputation software pricing", clicks=3, conversions=2, cost=20),  # converted → keep
        ]
        out = negatives_to_add(rows)
        assert [n["text"] for n in out] == ["cheap reviews free"]
        assert out[0]["cost"] == 9.0

    def test_ignores_terms_under_min_cost(self) -> None:
        rows = [_st("barely spent", clicks=1, conversions=0, cost=0.4)]
        assert negatives_to_add(rows, min_cost=1.0) == []

    def test_sorted_by_wasted_cost_desc(self) -> None:
        rows = [
            _st("waste a", clicks=2, conversions=0, cost=5),
            _st("waste b", clicks=9, conversions=0, cost=30),
        ]
        out = negatives_to_add(rows)
        assert [n["text"] for n in out] == ["waste b", "waste a"]


class TestClusterSplitRecommendation:
    def _kw(self, text: str, cpc: float) -> dict:
        return {"text": text, "avg_cpc": cpc}

    def test_recommends_split_on_wide_cpc_spread(self) -> None:
        kws = [
            self._kw("client engagement software", 0.99),
            self._kw("engagement tool", 1.10),
            self._kw("online reputation software", 12.00),
            self._kw("reputation management software", 18.00),
        ]
        rec = cluster_split_recommendation(kws)
        assert rec is not None
        assert rec["ratio"] >= 3.0
        assert "online reputation software" in rec["expensive"]
        assert "client engagement software" in rec["cheap"]

    def test_none_when_spread_is_tight(self) -> None:
        kws = [self._kw(f"kw {i}", 2.0 + i * 0.1) for i in range(5)]
        assert cluster_split_recommendation(kws) is None

    def test_none_when_too_few_priced_keywords(self) -> None:
        kws = [self._kw("a", 1.0), self._kw("b", 10.0), {"text": "c", "avg_cpc": 0}]
        assert cluster_split_recommendation(kws, min_keywords=4) is None
