"""SDK-free unit tests for the pure report layer."""

from __future__ import annotations

from datetime import date

from ads_skill.lib.report import (
    ad_group_query,
    ad_query,
    campaign_daily_query,
    campaign_totals_query,
    date_window,
    keyword_query,
    metric_dict,
    micros_to_currency,
    remediation_hint,
    safe_ratio,
    search_term_query,
)


def test_date_window_excludes_partial_today() -> None:
    # 14 complete days ending yesterday (2026-06-08..2026-06-21), not today.
    assert date_window(date(2026, 6, 22), 14) == ("2026-06-08", "2026-06-21")


def test_date_window_single_day() -> None:
    assert date_window(date(2026, 6, 22), 1) == ("2026-06-21", "2026-06-21")


def test_all_queries_filter_enabled_and_date_range() -> None:
    builders = (
        campaign_totals_query,
        campaign_daily_query,
        ad_group_query,
        ad_query,
        keyword_query,
        search_term_query,
    )
    for build in builders:
        q = build("2026-06-08", "2026-06-21")
        assert "campaign.status = 'ENABLED'" in q
        assert "segments.date BETWEEN '2026-06-08' AND '2026-06-21'" in q


def test_queries_use_correct_from_resources() -> None:
    assert "FROM campaign " in campaign_totals_query("a", "b")
    assert "FROM ad_group " in ad_group_query("a", "b")
    assert "FROM ad_group_ad " in ad_query("a", "b")
    assert "FROM keyword_view" in keyword_query("a", "b")
    assert "FROM search_term_view" in search_term_query("a", "b")


def test_ad_query_selects_ad_strength() -> None:
    assert "ad_group_ad.ad_strength" in ad_query("2026-06-08", "2026-06-21")


def test_campaign_daily_is_date_segmented_and_ordered() -> None:
    q = campaign_daily_query("a", "b")
    assert "segments.date" in q
    assert "ORDER BY segments.date" in q


def test_campaign_daily_carries_full_metric_schema() -> None:
    # Daily rows must select the same metrics as the other arrays (CTR/CPC/per-conv).
    q = campaign_daily_query("a", "b")
    for field in ("metrics.ctr", "metrics.average_cpc", "metrics.cost_per_conversion"):
        assert field in q


def test_remediation_hint_routes_token_errors_to_render_yaml() -> None:
    assert "render-yaml" in remediation_hint(
        "Request had invalid authentication credentials", "111", "222"
    )
    assert "render-yaml" in remediation_hint("OAuth token expired", "111", "222")


def test_remediation_hint_routes_permission_errors_to_ids() -> None:
    h = remediation_hint("User doesn't have permission to access customer", "111", "222")
    assert "111" in h and "222" in h


def test_remediation_hint_empty_for_unknown_errors() -> None:
    assert remediation_hint("some unrelated quota message", "111", "222") == ""


def test_micros_to_currency() -> None:
    assert micros_to_currency(1_500_000) == 1.5
    assert micros_to_currency(None) == 0.0


def test_safe_ratio_zero_denominator() -> None:
    assert safe_ratio(5, 0) == 0.0
    assert safe_ratio(2, 4) == 0.5


def test_metric_dict_zeroed_row() -> None:
    d = metric_dict(
        cost_micros=None, impressions=0, clicks=0, ctr=None,
        avg_cpc_micros=None, conversions=None, cost_per_conv_micros=None,
    )
    assert d == {
        "cost": 0.0, "impressions": 0, "clicks": 0, "ctr": 0.0,
        "avg_cpc": 0.0, "conversions": 0.0, "cost_per_conversion": 0.0,
    }


def test_metric_dict_ctr_fallback() -> None:
    # API ctr absent → guarded clicks/impressions.
    d = metric_dict(
        cost_micros=2_000_000, impressions=100, clicks=5, ctr=None,
        avg_cpc_micros=400_000, conversions=2.0, cost_per_conv_micros=1_000_000,
    )
    assert d["ctr"] == 0.05
    assert d["cost"] == 2.0
    assert d["avg_cpc"] == 0.4
    assert d["cost_per_conversion"] == 1.0


def test_metric_dict_uses_api_ctr_when_zero() -> None:
    # A genuine API ctr of 0.0 must be kept, not recomputed (is-not-None, not truthiness).
    d = metric_dict(
        cost_micros=0, impressions=100, clicks=0, ctr=0.0,
        avg_cpc_micros=None, conversions=None, cost_per_conv_micros=None,
    )
    assert d["ctr"] == 0.0
