"""IO entry: audit ENABLED campaigns for RSA/extension best-practice gaps.

Report only — emits findings as JSON on stdout plus a human table on stderr.
Deterministic: it decides WHAT is wrong (under-fill, dupes, banned phrases,
extension gaps, Google's own ad_strength + action_items). Authoring the fix copy
is the model's job (see audit.md); applying it is apply_fixes.py's job.

Usage:
  ads.sh audit --customer 1111111111 [--campaign ID] [--all]
                [--login-customer-id MCC] [--banned "VAT,USD,EUR,Portugal"]
"""
from __future__ import annotations

import argparse
import sys
from functools import reduce
from typing import Any

from ads_skill.audit.scoring import (
    IS_OPPORTUNITY,
    LOST_HI,
    MIN_CALLOUTS,
    MIN_DESCRIPTIONS,
    MIN_HEADLINES,
    MIN_SITELINKS,
    SHARED_HEADLINE_GROUPS,
    _cannibalization,
    _differentiation_gaps,
    _path_to_excellent,
    _require_digits,
)
from ads_skill.cli.args import resolve_customer
from ads_skill.cli.output import emit_json, error_envelope, ok
from ads_skill.gaql.builders import (
    audit_ad_group_ad_query,
    audit_campaigns_query,
    audit_ext_count_query,
    audit_keyword_metrics_query,
    audit_keywords_query,
    audit_landing_page_mobile_query,
    audit_policy_topics_query,
    audit_quality_score_query,
    audit_search_terms_query,
    audit_serving_query,
)
from ads_skill.lib.auth import load_client
from ads_skill.lib.cluster import (
    cluster_split_recommendation,
    keywords_to_promote,
    negatives_to_add,
)
from ads_skill.lib.report import micros_to_currency


def _search(client: Any, customer_id: str, query: str) -> list[Any]:
    svc = client.get_service("GoogleAdsService")
    return list(svc.search(customer_id=customer_id, query=query))


def _group_by(pairs) -> dict:
    """Pure fold: an iterable of (key, value) -> {key: [values]}, first-seen key
    order preserved. The one place every campaignId/etc.-keyed grouping in this
    module goes through, instead of each caller hand-rolling a setdefault loop."""
    return reduce(lambda acc, kv: {**acc, kv[0]: acc.get(kv[0], []) + [kv[1]]}, pairs, {})


def _all_keywords(client: Any, customer_id: str, campaign_ids: list) -> dict[int, dict[str, list[str]]]:
    """One query for every campaign's ENABLED keywords → {campaignId: {adGroupName: [kw]}}.
    Replaces the old per-campaign + per-cannibalization-pair fetches."""
    if not campaign_ids:
        return {}
    rows = _search(client, customer_id, audit_keywords_query(campaign_ids))
    by_campaign = _group_by((r.campaign.id, r) for r in rows)
    return {
        cid: _group_by((r.ad_group.name, r.ad_group_criterion.keyword.text) for r in crows)
        for cid, crows in by_campaign.items()
    }


def _campaigns(client: Any, customer_id: str, only_enabled: bool, campaign_id: str | None) -> list[Any]:
    q = audit_campaigns_query(only_enabled, campaign_id)
    return _search(client, customer_id, q)


def _resolve_campaign(client: Any, customer_id: str, needle: str, only_enabled: bool) -> tuple[str | None, str | None]:
    """Resolve --campaign given as a name substring to its id → (id, error).

    Match happens in Python (the needle never touches GAQL), so there's no
    injection surface and digit ids skip this path entirely. 0 matches or >1
    match is an error the caller surfaces verbatim."""
    rows = _search(client, customer_id, audit_campaigns_query(only_enabled, None))
    matches = [(r.campaign.id, r.campaign.name) for r in rows
               if needle.lower() in r.campaign.name.lower()]
    if not matches:
        return None, f"no campaign name matches {needle!r}"
    if len(matches) > 1:
        names = ", ".join(n for _, n in matches)
        return None, f"campaign name {needle!r} is ambiguous, matches: {names}"
    return str(matches[0][0]), None


def _ext_count(client: Any, customer_id: str, camp_id: str, field_type: str) -> int:
    q = audit_ext_count_query(camp_id, field_type)
    return len(_search(client, customer_id, q))


def _score_ad(r: Any, banned: list[str], ag_keywords: dict[str, list[str]]) -> dict:
    """Pure: one ad_group_ad row -> its scored ad dict (issues, pathToExcellent, etc.)."""
    a = r.ad_group_ad
    rsa = a.ad.responsive_search_ad
    hs = [h.text for h in rsa.headlines]
    ds = [d.text for d in rsa.descriptions]
    # AdTextAsset exposes the pin as `pinned_field` (ServedAssetFieldType);
    # an unpinned asset reads UNSPECIFIED. Anything else (HEADLINE_1, …) is a pin.
    pins = [h.text for h in list(rsa.headlines) + list(rsa.descriptions)
            if getattr(getattr(h, "pinned_field", None), "name", "UNSPECIFIED")
            not in ("UNSPECIFIED", "UNKNOWN")]
    dup_h = sorted({h for h in hs if hs.count(h) > 1})
    # description that merely echoes a headline (the all-caps "headline-as-description" smell)
    echo = [d for d in ds if d in hs]
    hit = sorted({t for t in hs + ds for b in banned if b and b.lower() in t.lower()})
    # Me-too copy: flag ads whose message reads as a generic AI-tool promise and
    # name the absent differentiation axes (FR-014/FR-015).
    diff = _differentiation_gaps(hs, ds)
    ad_issues = [
        *([{"issue": "headlines_under", "have": len(hs), "need": MIN_HEADLINES}] if len(hs) < MIN_HEADLINES else []),
        *([{"issue": "descriptions_under", "have": len(ds), "need": MIN_DESCRIPTIONS}] if len(ds) < MIN_DESCRIPTIONS else []),
        *([{"issue": "duplicate_headlines", "items": dup_h}] if dup_h else []),
        *([{"issue": "description_echoes_headline", "items": echo}] if echo else []),
        *([{"issue": "banned_phrase", "items": hit}] if hit else []),
        *([{"issue": "pinned_assets", "items": pins}] if pins else []),
        *([diff] if diff else []),
    ]
    keywords = ag_keywords.get(r.ad_group.name, [])
    return {
        "adId": a.ad.id, "adGroup": r.ad_group.name,
        "strength": a.ad_strength.name, "status": a.status.name,
        # Full asset text (not just counts) so /adkit update can preserve good copy
        # when authoring rewrites/appends instead of re-fetching it live.
        "headlines": hs, "descriptions": ds,
        "finalUrl": (list(a.ad.final_urls) or [None])[0],
        "actionItems": list(a.action_items),
        "issues": ad_issues,
        "keywords": keywords,
        "pathToExcellent": _path_to_excellent(r.ad_group.name, keywords, hs, ds, dup_h, echo, hit, pins,
                                              list(a.action_items), a.ad_strength.name),
    }


def audit_campaign(client: Any, customer_id: str, camp: Any, banned: list[str],
                   ag_keywords: dict[str, list[str]]) -> dict:
    cid = camp.campaign.id
    sitelinks = _ext_count(client, customer_id, cid, "SITELINK")
    callouts = _ext_count(client, customer_id, cid, "CALLOUT")
    rows = _search(client, customer_id, audit_ad_group_ad_query(cid))
    ads_out = [_score_ad(r, banned, ag_keywords) for r in rows]

    # Headlines reused across many ad groups read as boilerplate — fold every
    # (headline, ad group name) pair across all rows, then dedupe per headline.
    headline_hits = (
        (h, r.ad_group.name) for r in rows for h in [t.text for t in r.ad_group_ad.ad.responsive_search_ad.headlines]
    )
    headline_groups = {h: sorted(set(names)) for h, names in _group_by(headline_hits).items()}
    shared = {h: g for h, g in headline_groups.items() if len(g) >= SHARED_HEADLINE_GROUPS}

    findings = [
        *([{"level": "campaign", "issue": "sitelinks_under",
           "detail": f"{sitelinks}/{MIN_SITELINKS} sitelinks", "need": MIN_SITELINKS - sitelinks}]
          if sitelinks < MIN_SITELINKS else []),
        *([{"level": "campaign", "issue": "callouts_under",
           "detail": f"{callouts}/{MIN_CALLOUTS} callouts", "need": MIN_CALLOUTS - callouts}]
          if callouts < MIN_CALLOUTS else []),
        *([{"level": "campaign", "issue": "shared_boilerplate_headlines",
           "detail": f"{len(shared)} headlines reused across >= {SHARED_HEADLINE_GROUPS} ad groups",
           "items": shared}] if shared else []),
    ]
    return {
        "campaignId": cid, "campaignName": camp.campaign.name, "status": camp.campaign.status.name,
        "sitelinks": sitelinks, "callouts": callouts,
        "campaignFindings": findings, "ads": ads_out,
    }


# ---------------------------------------------------------------------------
# Impression-share layer — WHY a campaign isn't winning more impressions (a separate
# axis from ad strength: an EXCELLENT ad can still hold tiny IS). Reports lost IS to
# budget vs Ad Rank, the cold-start throttle, and self-competition between campaigns.
# IS_OPPORTUNITY / LOST_HI thresholds live in audit.scoring (pure).
# ---------------------------------------------------------------------------


def _score_serving(r: Any) -> dict:
    """Pure: one serving-query row -> its scored campaign dict (flags/recs)."""
    cp, m = r.campaign, r.metrics
    impr, conv = m.impressions, m.conversions
    lost_budget, lost_rank = m.search_budget_lost_impression_share, m.search_rank_lost_impression_share
    if impr == 0:
        cold_start = cp.bidding_strategy_type.name == "MAXIMIZE_CONVERSIONS" and conv == 0
        flags = ["zero_impressions", *(["cold_start_throttle"] if cold_start else [])]
        recs = (["New campaign on Maximize Conversions with no conversions — it bids weakly and "
                "stays starved. Feed it conversions or warm up on Maximize Clicks."] if cold_start else [])
    else:
        budget_constrained = lost_budget >= LOST_HI
        rank_constrained = lost_rank >= LOST_HI
        has_headroom = bool(m.search_impression_share and m.search_impression_share < IS_OPPORTUNITY)
        flags = [*(["budget_constrained"] if budget_constrained else []),
                 *(["rank_constrained"] if rank_constrained else [])]
        recs = [
            *([f"Losing {lost_budget*100:.0f}% of impression share to BUDGET — raise the daily "
               f"budget (or tighten geo/schedule/keywords) to capture it."] if budget_constrained else []),
            *([f"Losing {lost_rank*100:.0f}% of impression share to AD RANK — lift Quality Score "
               f"(ad relevance, ad strength, landing page) and/or bids; add negatives to raise CTR."]
              if rank_constrained else []),
            *([f"Search impression share is {m.search_impression_share*100:.0f}% — headroom to "
               f"{IS_OPPORTUNITY*100:.0f}%+; act on the dominant lost-IS reason above."] if has_headroom else []),
        ]
    return {
        "campaignId": cp.id, "campaignName": cp.name, "bidStrategy": cp.bidding_strategy_type.name,
        "budgetMicros": r.campaign_budget.amount_micros, "impressions": impr, "conversions": conv,
        "searchImpressionShare": m.search_impression_share,
        "lostISBudget": lost_budget, "lostISRank": lost_rank,
        "flags": flags, "impressionShareRecs": recs,
    }


def _campaign_serving(client: Any, customer_id: str, days: int, only_enabled: bool, campaign_id: str | None) -> list[dict]:
    q = audit_serving_query(days, only_enabled, campaign_id)
    return [_score_serving(r) for r in _search(client, customer_id, q)]


# ---------------------------------------------------------------------------
# Keyword-CPC layer — per-keyword average CPC over the window, plus the
# cluster-split detector: a campaign whose priciest keyword costs many times the
# cheapest is mixing cheap-broad + expensive-intent terms under one budget (the
# reputation-split pattern). Detection logic is pure (lib/cluster).
# ---------------------------------------------------------------------------


def _keyword_cpc(client: Any, customer_id: str, days: int, campaign_ids: list) -> dict[int, list[dict]]:
    """{campaignId: [{text, avg_cpc(dollars), avg_cpc_micros}]} for ENABLED keywords,
    highest CPC first. avg_cpc is the currency value the cluster detector reads."""
    if not campaign_ids:
        return {}
    rows = _search(client, customer_id, audit_keyword_metrics_query(days, campaign_ids))
    grouped = _group_by(
        (r.campaign.id, {
            "text": r.ad_group_criterion.keyword.text,
            "avg_cpc": micros_to_currency(r.metrics.average_cpc),
            "avg_cpc_micros": int(r.metrics.average_cpc or 0),
        })
        for r in rows
    )
    return {cid: sorted(kws, key=lambda k: k["avg_cpc"], reverse=True) for cid, kws in grouped.items()}


def _cluster_splits(kw_cpc: dict[int, list[dict]], names: dict[int, str]) -> list[dict]:
    """Per-campaign cluster-split recommendations (only campaigns where the CPC
    spread crosses the threshold appear)."""
    scored = ((cid, cluster_split_recommendation(kws)) for cid, kws in kw_cpc.items())
    return [{"campaignId": cid, "campaignName": names.get(cid, str(cid)), **rec} for cid, rec in scored if rec]


# ---------------------------------------------------------------------------
# Search-term layer — the same wasted-spend / scale-up signal /adkit report derives,
# pulled into the audit so negatives can be chosen from real query data (not
# guessed). negatives_to_add = terms that spent without converting (→ /adkit update
# negative keywords); keywords_to_promote = converting terms not yet keywords
# (→ /adkit update positive-keyword adds). Pure logic lives in lib/cluster.
# ---------------------------------------------------------------------------


def _search_terms(client: Any, customer_id: str, days: int, campaign_ids: list) -> dict[int, list[dict]]:
    """{campaignId: [{search_term, clicks, conversions, cost(dollars), impressions}]}
    over the window, for the negatives/promote derivation."""
    if not campaign_ids:
        return {}
    rows = _search(client, customer_id, audit_search_terms_query(days, campaign_ids))
    return _group_by(
        (r.campaign.id, {
            "search_term": r.search_term_view.search_term,
            "clicks": r.metrics.clicks,
            "conversions": r.metrics.conversions,
            "cost": micros_to_currency(r.metrics.cost_micros),
            "impressions": r.metrics.impressions,
        })
        for r in rows
    )


def _negatives_and_promotions(search_terms: dict[int, list[dict]],
                              kw_by_campaign: dict[int, dict[str, list[str]]]) -> tuple[dict, dict]:
    """Pure: search-term rows -> (addNegatives, promoteKeywords), each keyed by
    campaignId and only present where non-empty."""
    scored = {
        cid: (negatives_to_add(terms),
              keywords_to_promote(terms, [{"text": kw} for kws in kw_by_campaign.get(cid, {}).values() for kw in kws]))
        for cid, terms in search_terms.items()
    }
    add_negatives = {cid: negs for cid, (negs, _proms) in scored.items() if negs}
    promote_keywords = {cid: proms for cid, (_negs, proms) in scored.items() if proms}
    return add_negatives, promote_keywords


def _quality_score(client: Any, customer_id: str, campaign_ids: list) -> dict[int, list[dict]]:
    """{campaignId: [{keyword, qualityScore, landingPageExp, adRelevance, expectedCtr}]}
    from the current-state Quality Score snapshot. Keywords with no score yet (new/
    low-traffic) are omitted — quality_score returns 0 in that case."""
    if not campaign_ids:
        return {}

    def _row(r: Any) -> tuple[int, dict] | None:
        qi = r.ad_group_criterion.quality_info
        score = qi.quality_score
        if not score:
            return None
        return (r.campaign.id, {
            "keyword": r.ad_group_criterion.keyword.text,
            "qualityScore": int(score),
            "landingPageExp": qi.post_click_quality_score.name,
            "adRelevance": qi.creative_quality_score.name,
            "expectedCtr": qi.search_predicted_ctr.name,
        })

    rows = filter(None, map(_row, _search(client, customer_id, audit_quality_score_query(campaign_ids))))
    grouped = _group_by(rows)
    return {cid: sorted(kws, key=lambda k: k["qualityScore"]) for cid, kws in grouped.items()}


# ---------------------------------------------------------------------------
# Landing page health — mobile/AMP click quality + page speed from
# landing_page_view (windowed, like the rest of the serving layer), and
# URL/redirect policy findings (DESTINATION_NOT_WORKING, DESTINATION_MISMATCH)
# from ad_group_ad.policy_summary (current-state, not windowed). Both land in
# the same {campaignId: [{url, issue, detail}]} shape.
# ---------------------------------------------------------------------------

_SLOW_SPEED_SCORE = 3  # speed_score is 1(slowest)-10(fastest); Google buckets 1-3 as "Slow"

_POLICY_TOPIC_FIXES = {
    "DESTINATION_NOT_WORKING": "Page not found (404) or unreachable — bad final URL, broken tracking "
                               "template, or AdsBot blocked by robots.txt. Fix the URL or unblock Googlebot-Ads.",
    "DESTINATION_MISMATCH": "Final URL mismatch — the redirect chain doesn't resolve to the final URL's "
                            "domain. Align the tracking template and final URL to the same domain.",
}


def _mobile_findings(m: Any) -> list[dict]:
    """Pure: one landing_page_view row's metrics -> 0-3 finding dicts (issue/detail)."""
    mobile_pct = m.mobile_friendly_clicks_percentage
    amp_pct = m.valid_accelerated_mobile_pages_clicks_percentage
    speed = m.speed_score
    candidates = [
        {"issue": "mobile_unfriendly_clicks",
         "detail": f"only {mobile_pct*100:.0f}% of mobile clicks reach a mobile-friendly page — remove "
                   'viewport-blocking elements, set <meta name="viewport">, compress images.'}
        if mobile_pct is not None and mobile_pct < 1.0 else None,
        {"issue": "invalid_amp_clicks",
         "detail": f"only {amp_pct*100:.0f}% of AMP clicks reach valid AMP markup — validate at the AMP Validator."}
        if amp_pct is not None and amp_pct < 1.0 else None,
        {"issue": "slow_landing_page",
         "detail": f"speed_score {speed}/10 — a 1-second mobile delay can cut conversions "
                   "up to 20%; cut render-blocking assets and server response time."}
        if speed and speed <= _SLOW_SPEED_SCORE else None,
    ]
    return [f for f in candidates if f is not None]


def _landing_page_mobile(client: Any, customer_id: str, days: int, campaign_ids: list) -> dict[int, list[dict]]:
    """{campaignId: [{url, issue, detail}]} for URLs failing the mobile-friendly
    or valid-AMP click-rate checks, or scoring slow on speed_score, over the window."""
    if not campaign_ids:
        return {}
    rows = _search(client, customer_id, audit_landing_page_mobile_query(days, campaign_ids))
    entries = (
        (r.campaign.id, {"url": r.landing_page_view.unexpanded_final_url,
                        "clicks": r.metrics.clicks, "impressions": r.metrics.impressions,
                        "ctr": r.metrics.ctr, **finding})
        for r in rows
        for finding in _mobile_findings(r.metrics)
    )
    return _group_by(entries)


def _landing_page_policy(client: Any, customer_id: str, campaign_ids: list) -> dict[int, list[dict]]:
    """{campaignId: [{url, issue, detail}]} for enabled ads carrying a
    DESTINATION_NOT_WORKING/DESTINATION_MISMATCH policy topic entry (current
    approval state — not windowed)."""
    entries = (
        (cid, {"url": (list(r.ad_group_ad.ad.final_urls) or [None])[0],
              "issue": entry.topic.lower(), "detail": _POLICY_TOPIC_FIXES[entry.topic]})
        for cid in campaign_ids
        for r in _search(client, customer_id, audit_policy_topics_query(cid))
        for entry in r.ad_group_ad.policy_summary.policy_topic_entries
        if entry.topic in _POLICY_TOPIC_FIXES
    )
    return _group_by(entries)


def _merge_lists(a: dict[int, list], b: dict[int, list]) -> dict[int, list]:
    """Pure merge of two {key: [list]} dicts, concatenating lists for shared keys."""
    keys = dict.fromkeys([*a, *b])
    return {k: a.get(k, []) + b.get(k, []) for k in keys}


# ---------------------------------------------------------------------------
# stderr rendering — every _render_* function is a pure data -> list[str]
# transform; main() is the only place that actually prints (via _emit_lines).
# ---------------------------------------------------------------------------


def _emit_lines(lines: list[str]) -> None:
    for line in lines:
        print(line, file=sys.stderr)


def _render_creative_summary(report: list[dict]) -> list[str]:
    def _campaign_lines(c: dict) -> list[str]:
        bad_ads = [a for a in c["ads"] if a["issues"]]
        header = [f"\n{c['campaignName']} ({c['campaignId']}) [{c['status']}] "
                  f"sitelinks={c['sitelinks']} callouts={c['callouts']}"]
        finding_lines = [f"  ! {f['issue']}: {f['detail']}" for f in c["campaignFindings"]]
        ad_lines = [
            line
            for a in c["ads"]
            for line in [
                f"    [{a['strength']:9}] {a['adGroup']:34} {len(a['headlines'])}H/{len(a['descriptions'])}D  "
                f"{', '.join(i['issue'] for i in a['issues']) or 'ok'}",
                *([f"        -> {step}" for step in a["pathToExcellent"]] if a["strength"] != "EXCELLENT" else []),
            ]
        ]
        return header + finding_lines + ad_lines, len(c["campaignFindings"]) + len(bad_ads)

    per_campaign = [_campaign_lines(c) for c in report]
    lines = [line for campaign_lines, _ in per_campaign for line in campaign_lines]
    total = sum(count for _, count in per_campaign)
    return lines + [f"\n{total} creative findings across {len(report)} campaigns"]


def _render_impression_share(serving: list[dict], cannibalization: list[dict], days: int) -> list[str]:
    def _row(c: dict) -> list[str]:
        tag = ", ".join(c["flags"]) or "serving"
        is_pct = f"{c['searchImpressionShare']*100:.0f}%" if c["impressions"] else "  -"
        lb, lr = f"{c['lostISBudget']*100:.0f}%", f"{c['lostISRank']*100:.0f}%"
        return [
            f"    {c['campaignName']:34} impr={c['impressions']:>6} IS={is_pct:>4} "
            f"lostBudget={lb:>4} lostRank={lr:>4} conv={c['conversions']:.0f} [{tag}]",
            *[f"        -> {rec}" for rec in c["impressionShareRecs"]],
        ]

    return (
        [f"\n=== IMPRESSION SHARE (last {days} days) ==="]
        + [line for c in serving for line in _row(c)]
        + [f"  ~ cannibalization: {p['a']} <> {p['b']} share {p['shared']} (starved: {p['starvedLikely']})"
           for p in cannibalization]
    )


def _render_keyword_cpc(serving: list[dict], keyword_cpc: dict[int, list[dict]],
                        cluster_splits: list[dict], days: int) -> list[str]:
    def _row(c: dict) -> list[str]:
        kws = keyword_cpc.get(c["campaignId"], [])
        if not kws:
            return []
        top = ", ".join(f"{k['text']} ${k['avg_cpc']:.2f}" for k in kws[:3])
        return [f"    {c['campaignName']:34} top CPC: {top}"]

    return (
        [f"\n=== KEYWORD CPC (last {days} days) ==="]
        + [line for c in serving for line in _row(c)]
        + [f"  ! cluster split: {s['campaignName']} — {s['reason']}" for s in cluster_splits]
    )


def _render_search_term_candidates(add_negatives: dict[int, list[dict]], promote_keywords: dict[int, list[dict]],
                                   names: dict[int, str], days: int) -> list[str]:
    def _negatives_row(cid: int, negs: list[dict]) -> str:
        top = ", ".join(f"{n['text']} (${n['cost']:.2f})" for n in negs[:5])
        return f"    {names.get(cid, str(cid)):34} ${sum(n['cost'] for n in negs):.2f} wasted / {len(negs)} terms: {top}"

    def _promote_row(cid: int, proms: list[dict]) -> str:
        top = ", ".join(f"{p['text']} ({p['conversions']:.0f} conv)" for p in proms[:5])
        return f"    {names.get(cid, str(cid)):34} {len(proms)} terms: {top}"

    negatives_section = (
        [f"\n=== SEARCH-TERM WASTE → NEGATIVE CANDIDATES (last {days} days) ==="]
        + [_negatives_row(cid, negs) for cid, negs in add_negatives.items()]
    ) if add_negatives else []
    promote_section = (
        [f"\n=== CONVERTING SEARCH TERMS → PROMOTE CANDIDATES (last {days} days) ==="]
        + [_promote_row(cid, proms) for cid, proms in promote_keywords.items()]
    ) if promote_keywords else []
    return negatives_section + promote_section


def _render_quality_score_section(title: str, component: str, quality_score: dict[int, list[dict]],
                                  camp_names: dict[int, str]) -> list[str]:
    bad = {cid: [k for k in kws if k[component] == "BELOW_AVERAGE"] for cid, kws in quality_score.items()}
    bad = {cid: kws for cid, kws in bad.items() if kws}
    if not bad:
        return []

    def _row(cid: int, kws: list[dict]) -> str:
        top = ", ".join(f"{k['keyword']} (QS {k['qualityScore']})" for k in kws[:5])
        return f"    {camp_names.get(cid, str(cid)):34} {len(kws)} keywords: {top}"

    return [f"\n=== {title} ==="] + [_row(cid, kws) for cid, kws in bad.items()]


def _render_landing_page_health(landing_page_health: dict[int, list[dict]], camp_names: dict[int, str]) -> list[str]:
    if not landing_page_health:
        return []
    return [f"\n=== LANDING PAGE HEALTH ==="] + [
        line
        for cid, items in landing_page_health.items()
        for line in [
            f"    {camp_names.get(cid, str(cid)):34} {len(items)} issue(s):",
            *[f"        -> [{it['issue']}] {it['url']}: {it['detail']}" for it in items],
        ]
    ]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--customer", default=None, help="10-digit customer id (no dashes); falls back to login_customer_id in yaml")
    p.add_argument("--login-customer-id", default=None, help="MCC id, only if the account is reached via a manager")
    p.add_argument("--campaign", default=None, help="audit a single campaign by id (digits) or name substring")
    p.add_argument("--all", action="store_true", help="include non-ENABLED campaigns")
    p.add_argument("--banned", default="", help="comma-separated phrases to flag as off-product contamination")
    p.add_argument("--days", type=int, default=7, choices=[7, 14, 30], help="impression-share window (default 7)")
    p.add_argument("--no-serving", action="store_true", help="skip the impression-share layer (creative-only)")
    args = p.parse_args(argv)
    args.customer = resolve_customer(args.customer)
    if not args.customer:
        emit_json(error_envelope("Provide --customer (or set login_customer_id in yaml)"))
        return 2
    _require_digits("customer", args.customer)
    _require_digits("login-customer-id", args.login_customer_id)
    banned = [b.strip() for b in args.banned.split(",") if b.strip()]
    client = load_client(args.login_customer_id)
    # --campaign accepts an id (digits) or a name substring; resolve the name to an id once.
    if args.campaign and not args.campaign.isdigit():
        args.campaign, err = _resolve_campaign(client, args.customer, args.campaign, only_enabled=not args.all)
        if err:
            emit_json(error_envelope(err))
            return 2
    _require_digits("campaign", args.campaign)
    camps = _campaigns(client, args.customer, only_enabled=not args.all, campaign_id=args.campaign)
    kw_by_campaign = _all_keywords(client, args.customer, [c.campaign.id for c in camps])
    report = [audit_campaign(client, args.customer, c, banned, kw_by_campaign.get(c.campaign.id, {}))
              for c in camps]

    camp_ids = [c.campaign.id for c in camps]
    quality_score: dict[int, list[dict]] = _quality_score(client, args.customer, camp_ids)
    landing_page_health: dict[int, list[dict]] = _landing_page_policy(client, args.customer, camp_ids)

    serving: list[dict] = []
    cannibalization: list[dict] = []
    keyword_cpc: dict[int, list[dict]] = {}
    cluster_splits: list[dict] = []
    add_negatives: dict[int, list[dict]] = {}
    promote_keywords: dict[int, list[dict]] = {}
    if not args.no_serving:
        serving = _campaign_serving(client, args.customer, args.days, not args.all, args.campaign)
        cannibalization = _cannibalization(serving, kw_by_campaign)
        keyword_cpc = _keyword_cpc(client, args.customer, args.days, camp_ids)
        cluster_splits = _cluster_splits(keyword_cpc, {c.campaign.id: c.campaign.name for c in camps})
        landing_page_health = _merge_lists(
            landing_page_health, _landing_page_mobile(client, args.customer, args.days, camp_ids))
        search_terms = _search_terms(client, args.customer, args.days, camp_ids)
        add_negatives, promote_keywords = _negatives_and_promotions(search_terms, kw_by_campaign)

    # human summary -> stderr (stdout stays clean JSON for piping)
    _emit_lines(_render_creative_summary(report))
    if not args.no_serving:
        names = {c["campaignId"]: c["campaignName"] for c in serving}
        _emit_lines(_render_impression_share(serving, cannibalization, args.days))
        _emit_lines(_render_keyword_cpc(serving, keyword_cpc, cluster_splits, args.days))
        _emit_lines(_render_search_term_candidates(add_negatives, promote_keywords, names, args.days))

    camp_names = {c.campaign.id: c.campaign.name for c in camps}
    _emit_lines(_render_quality_score_section(
        "QUALITY SCORE — LANDING PAGE EXP. BELOW AVERAGE", "landingPageExp", quality_score, camp_names))
    _emit_lines(_render_quality_score_section(
        "QUALITY SCORE — AD RELEVANCE BELOW AVERAGE", "adRelevance", quality_score, camp_names))
    _emit_lines(_render_quality_score_section(
        "QUALITY SCORE — EXPECTED CTR BELOW AVERAGE", "expectedCtr", quality_score, camp_names))
    _emit_lines(_render_landing_page_health(landing_page_health, camp_names))

    emit_json(ok(customer=args.customer, campaigns=report,
                 serving=serving, cannibalization=cannibalization,
                 keywordCpc={str(k): v for k, v in keyword_cpc.items()},
                 clusterSplits=cluster_splits,
                 addNegatives={str(k): v for k, v in add_negatives.items()},
                 promoteKeywords={str(k): v for k, v in promote_keywords.items()},
                 qualityScore={str(k): v for k, v in quality_score.items()},
                 landingPageHealth={str(k): v for k, v in landing_page_health.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
