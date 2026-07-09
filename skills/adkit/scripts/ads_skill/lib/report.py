"""Pure helpers for the /adkit report skill: date window, GAQL query builders,
and metric derivation. No SDK imports — every function is referentially
transparent and covered by report_test.py.

The IO entrypoint (bin/report.py) injects the as-of date and feeds raw API
values into these functions; nothing here reads the clock or mutates input."""

from __future__ import annotations

# GAQL builders now live in the central gaql package; re-exported here so callers
# (and report_test.py) keep importing them from ads_skill.lib.report unchanged.
from ..gaql.builders import (  # noqa: F401
    ad_group_query,
    ad_query,
    campaign_daily_query,
    campaign_totals_query,
    date_window,
    keyword_query,
    search_term_query,
)


def remediation_hint(message: str, customer: str, manager: str) -> str:
    """Map a Google Ads API error message to an actionable next step. Bad/expired
    tokens surface at query time (not at credential load), so route those to
    render-yaml; permission/access problems point at the customer/manager ids."""
    low = message.lower()
    if any(k in low for k in ("authenticat", "credential", "developer token", "oauth")):
        return "Re-render credentials: bash ads.sh render-yaml"
    if any(k in low for k in ("permission", "authoriz", "not authorized")):
        return f"Verify customer {customer} is accessible under manager {manager}."
    return ""


def micros_to_currency(micros: int | None) -> float:
    """Google money fields are micros (1/1,000,000 of the account currency)."""
    return (micros or 0) / 1_000_000


def safe_ratio(numerator: float, denominator: float) -> float:
    """Zero-denominator → 0.0 (never raise), so 'spent nothing' stays
    distinguishable from an error. See spec Edge Cases."""
    return numerator / denominator if denominator else 0.0


def metric_dict(
    *,
    cost_micros: int | None,
    impressions: int | None,
    clicks: int | None,
    ctr: float | None,
    avg_cpc_micros: int | None,
    conversions: float | None,
    cost_per_conv_micros: int | None,
) -> dict:
    """Normalise one row's raw API metric values into the report shape: micros
    converted to currency, counts coerced, CTR taken from the API but falling
    back to a guarded clicks/impressions ratio when absent."""
    imps = int(impressions or 0)
    clk = int(clicks or 0)
    return {
        "cost": micros_to_currency(cost_micros),
        "impressions": imps,
        "clicks": clk,
        "ctr": float(ctr) if ctr is not None else safe_ratio(clk, imps),
        "avg_cpc": micros_to_currency(avg_cpc_micros),
        "conversions": float(conversions or 0),
        "cost_per_conversion": micros_to_currency(cost_per_conv_micros),
    }
