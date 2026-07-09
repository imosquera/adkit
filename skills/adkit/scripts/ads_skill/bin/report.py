"""IO entry: pull last N days of Google Ads performance for ENABLED campaigns
and write a raw JSON report under ads/output/reports/.

Only module besides keyword_ideas that imports the google-ads SDK. All query
construction and metric math live in lib/report.py (pure, SDK-free, tested);
this module is the side-effecting shell that talks to the API and the disk.

Usage: ads.sh report [<customer>] [--manager <id>] [--days 14]
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from ads_skill.cli.args import normalize_id
from ads_skill.cli.output import sdk_error_message
from ads_skill.lib.auth import load_client
from ads_skill.lib.cluster import (
    cluster_split_recommendation,
    keywords_to_promote,
    negatives_to_add,
)
from ads_skill.lib.report import (
    ad_group_query,
    ad_query,
    campaign_daily_query,
    campaign_totals_query,
    date_window,
    keyword_query,
    metric_dict,
    remediation_hint,
    search_term_query,
)

# Defaults: the account/manager we report on by default (overridable via args).
DEFAULT_CUSTOMER = "1111111111"   # 111-111-1111
DEFAULT_MANAGER = "2222222222"    # 222-222-2222
DEFAULT_DAYS = 14


def _metrics(row: Any) -> dict:
    m = row.metrics
    return metric_dict(
        cost_micros=m.cost_micros,
        impressions=m.impressions,
        clicks=m.clicks,
        ctr=m.ctr,
        avg_cpc_micros=m.average_cpc,
        conversions=m.conversions,
        cost_per_conv_micros=m.cost_per_conversion,
    )


def _search(service: Any, customer_id: str, query: str) -> list[Any]:
    return list(service.search(customer_id=customer_id, query=query))


def _pull(service: Any, customer_id: str, start: str, end: str, daily_end: str) -> dict:
    campaigns = [
        {"id": str(r.campaign.id), "name": r.campaign.name,
         "status": r.campaign.status.name, **_metrics(r)}
        for r in _search(service, customer_id, campaign_totals_query(start, end))
    ]
    # Daily series runs through today (daily_end > end): the trailing day is the
    # partial current day, included so serving status "right now" is visible.
    campaign_daily = [
        {"id": str(r.campaign.id), "name": r.campaign.name, "date": r.segments.date,
         **_metrics(r)}
        for r in _search(service, customer_id, campaign_daily_query(start, daily_end))
    ]
    ad_groups = [
        {"campaign_id": str(r.campaign.id), "id": str(r.ad_group.id),
         "name": r.ad_group.name, **_metrics(r)}
        for r in _search(service, customer_id, ad_group_query(start, end))
    ]
    ads = [
        {"campaign_id": str(r.campaign.id), "ad_group_id": str(r.ad_group.id),
         "id": str(r.ad_group_ad.ad.id),
         "name": r.ad_group_ad.ad.name or f"Ad {r.ad_group_ad.ad.id}",
         "type": r.ad_group_ad.ad.type_.name,
         "ad_strength": r.ad_group_ad.ad_strength.name, **_metrics(r)}
        for r in _search(service, customer_id, ad_query(start, end))
    ]
    keywords = [
        {"campaign_id": str(r.campaign.id), "ad_group_id": str(r.ad_group.id),
         "text": r.ad_group_criterion.keyword.text,
         "match_type": r.ad_group_criterion.keyword.match_type.name, **_metrics(r)}
        for r in _search(service, customer_id, keyword_query(start, end))
    ]
    search_terms = [
        {"campaign_id": str(r.campaign.id), "ad_group_id": str(r.ad_group.id),
         "search_term": r.search_term_view.search_term, **_metrics(r)}
        for r in _search(service, customer_id, search_term_query(start, end))
    ]
    return {
        "campaigns": campaigns,
        "campaign_daily": campaign_daily,
        "ad_groups": ad_groups,
        "ads": ads,
        "keywords": keywords,
        "search_terms": search_terms,
    }


def _by_campaign(rows: list[dict], key: str = "campaign_id") -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(str(r[key]), []).append(r)
    return out


def _recommendations(data: dict) -> list[dict]:
    """Per-campaign, data-driven cluster analysis (pure cluster lib): which search
    terms to promote to keywords, which to add as negatives, and whether the
    campaign mixes cheap-broad + expensive-intent keywords and should be split."""
    st = _by_campaign(data["search_terms"])
    kw = _by_campaign(data["keywords"])
    recs = []
    for camp in data["campaigns"]:
        cid = str(camp["id"])
        terms, kws = st.get(cid, []), kw.get(cid, [])
        recs.append({
            "campaign_id": cid,
            "campaign_name": camp["name"],
            "promote_keywords": keywords_to_promote(terms, kws),
            "add_negatives": negatives_to_add(terms),
            "split": cluster_split_recommendation(kws),
        })
    return recs


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="ads.sh report")
    p.add_argument("customer", nargs="?", default=DEFAULT_CUSTOMER)
    p.add_argument("--manager", default=DEFAULT_MANAGER)
    p.add_argument("--days", type=int, default=DEFAULT_DAYS)
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    customer = normalize_id(args.customer)
    manager = normalize_id(args.manager)

    try:
        client = load_client(manager)
    except Exception as exc:  # noqa: BLE001 — surface a clear, actionable message
        sys.stderr.write(
            f"error: could not load Google Ads credentials ({exc}). "
            "Run: bash ads.sh render-yaml\n"
        )
        return 1

    service = client.get_service("GoogleAdsService")

    today = date.today()  # ponytail: the one clock read; injected into the pure layer
    start, end = date_window(today, args.days)
    daily_end = today.isoformat()  # daily series runs through today (partial)
    try:
        data = _pull(service, customer, start, end, daily_end)
    except Exception as exc:  # noqa: BLE001 — GoogleAdsException et al.; show the API message, not a traceback
        msgs = sdk_error_message(exc)
        hint = remediation_hint(msgs, customer, manager)
        sys.stderr.write(
            f"error: Google Ads query failed for customer {customer} via manager {manager}: "
            f"{msgs}{'. ' + hint if hint else ''}\n"
        )
        return 1

    if not data["campaigns"]:
        sys.stderr.write(
            f"no ENABLED campaigns with activity in {customer} "
            f"between {start} and {end}; nothing written.\n"
        )
        return 1

    report = {
        "customer_id": customer,
        "manager_id": manager,
        "window": {"start": start, "end": end, "days": args.days, "partial_day": daily_end},
        "generated_at": today.isoformat(),
        **data,
        # Deterministic cluster analysis computed here so it ships in the raw
        # report and the LLM-authored markdown can lean on it rather than re-derive.
        "recommendations": _recommendations(data),
    }

    out_dir = Path.cwd() / "ads" / "output" / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{today.isoformat()}-{customer}-raw.yaml"
    out_path.write_text(yaml.safe_dump(report, sort_keys=False, allow_unicode=True))
    sys.stdout.write(f"{out_path}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
