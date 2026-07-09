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


def _all_keywords(client: Any, customer_id: str, campaign_ids: list) -> dict[int, dict[str, list[str]]]:
    """One query for every campaign's ENABLED keywords → {campaignId: {adGroupName: [kw]}}.
    Replaces the old per-campaign + per-cannibalization-pair fetches."""
    if not campaign_ids:
        return {}
    q = audit_keywords_query(campaign_ids)
    out: dict[int, dict[str, list[str]]] = {}
    for r in _search(client, customer_id, q):
        out.setdefault(r.campaign.id, {}).setdefault(r.ad_group.name, []).append(
            r.ad_group_criterion.keyword.text)
    return out


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


def audit_campaign(client: Any, customer_id: str, camp: Any, banned: list[str],
                   ag_keywords: dict[str, list[str]]) -> dict:
    cid = camp.campaign.id
    findings: list[dict] = []
    sitelinks = _ext_count(client, customer_id, cid, "SITELINK")
    callouts = _ext_count(client, customer_id, cid, "CALLOUT")
    if sitelinks < MIN_SITELINKS:
        findings.append({"level": "campaign", "issue": "sitelinks_under",
                         "detail": f"{sitelinks}/{MIN_SITELINKS} sitelinks", "need": MIN_SITELINKS - sitelinks})
    if callouts < MIN_CALLOUTS:
        findings.append({"level": "campaign", "issue": "callouts_under",
                         "detail": f"{callouts}/{MIN_CALLOUTS} callouts", "need": MIN_CALLOUTS - callouts})

    q = audit_ad_group_ad_query(cid)
    rows = _search(client, customer_id, q)
    headline_groups: dict[str, set] = {}
    ads_out = []
    for r in rows:
        a = r.ad_group_ad
        rsa = a.ad.responsive_search_ad
        hs = [h.text for h in rsa.headlines]
        ds = [d.text for d in rsa.descriptions]
        # AdTextAsset exposes the pin as `pinned_field` (ServedAssetFieldType);
        # an unpinned asset reads UNSPECIFIED. Anything else (HEADLINE_1, …) is a pin.
        pins = [h.text for h in list(rsa.headlines) + list(rsa.descriptions)
                if getattr(getattr(h, "pinned_field", None), "name", "UNSPECIFIED")
                not in ("UNSPECIFIED", "UNKNOWN")]
        ad_issues = []
        if len(hs) < MIN_HEADLINES:
            ad_issues.append({"issue": "headlines_under", "have": len(hs), "need": MIN_HEADLINES})
        if len(ds) < MIN_DESCRIPTIONS:
            ad_issues.append({"issue": "descriptions_under", "have": len(ds), "need": MIN_DESCRIPTIONS})
        dup_h = sorted({h for h in hs if hs.count(h) > 1})
        if dup_h:
            ad_issues.append({"issue": "duplicate_headlines", "items": dup_h})
        # description that merely echoes a headline (the all-caps "headline-as-description" smell)
        echo = [d for d in ds if d in hs]
        if echo:
            ad_issues.append({"issue": "description_echoes_headline", "items": echo})
        hit = sorted({t for t in hs + ds for b in banned if b and b.lower() in t.lower()})
        if hit:
            ad_issues.append({"issue": "banned_phrase", "items": hit})
        if pins:
            ad_issues.append({"issue": "pinned_assets", "items": pins})
        # Me-too copy: flag ads whose message reads as a generic AI-tool promise and
        # name the absent differentiation axes (FR-014/FR-015).
        diff = _differentiation_gaps(hs, ds)
        if diff:
            ad_issues.append(diff)
        for h in hs:
            headline_groups.setdefault(h, set()).add(r.ad_group.name)
        ads_out.append({
            "adId": a.ad.id, "adGroup": r.ad_group.name,
            "strength": a.ad_strength.name, "status": a.status.name,
            # Full asset text (not just counts) so /adkit update can preserve good copy
            # when authoring rewrites/appends instead of re-fetching it live.
            "headlines": hs, "descriptions": ds,
            "finalUrl": (list(a.ad.final_urls) or [None])[0],
            "actionItems": list(a.action_items),
            "issues": ad_issues,
            "keywords": ag_keywords.get(r.ad_group.name, []),
            "pathToExcellent": _path_to_excellent(r.ad_group.name, ag_keywords.get(r.ad_group.name, []),
                                                  hs, ds, dup_h, echo, hit, pins,
                                                  list(a.action_items), a.ad_strength.name),
        })
    shared = {h: sorted(g) for h, g in headline_groups.items() if len(g) >= SHARED_HEADLINE_GROUPS}
    if shared:
        findings.append({"level": "campaign", "issue": "shared_boilerplate_headlines",
                         "detail": f"{len(shared)} headlines reused across >= {SHARED_HEADLINE_GROUPS} ad groups",
                         "items": shared})
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


def _campaign_serving(client: Any, customer_id: str, days: int, only_enabled: bool, campaign_id: str | None) -> list[dict]:
    q = audit_serving_query(days, only_enabled, campaign_id)
    out = []
    for r in _search(client, customer_id, q):
        cp, m = r.campaign, r.metrics
        impr, conv = m.impressions, m.conversions
        lost_budget, lost_rank = m.search_budget_lost_impression_share, m.search_rank_lost_impression_share
        flags, recs = [], []
        if impr == 0:
            flags.append("zero_impressions")
            if cp.bidding_strategy_type.name == "MAXIMIZE_CONVERSIONS" and conv == 0:
                flags.append("cold_start_throttle")
                recs.append("New campaign on Maximize Conversions with no conversions — it bids weakly and "
                            "stays starved. Feed it conversions or warm up on Maximize Clicks.")
        else:
            if lost_budget >= LOST_HI:
                flags.append("budget_constrained")
                recs.append(f"Losing {lost_budget*100:.0f}% of impression share to BUDGET — raise the daily "
                            f"budget (or tighten geo/schedule/keywords) to capture it.")
            if lost_rank >= LOST_HI:
                flags.append("rank_constrained")
                recs.append(f"Losing {lost_rank*100:.0f}% of impression share to AD RANK — lift Quality Score "
                            f"(ad relevance, ad strength, landing page) and/or bids; add negatives to raise CTR.")
            if m.search_impression_share and m.search_impression_share < IS_OPPORTUNITY:
                recs.append(f"Search impression share is {m.search_impression_share*100:.0f}% — headroom to "
                            f"{IS_OPPORTUNITY*100:.0f}%+; act on the dominant lost-IS reason above.")
        out.append({
            "campaignId": cp.id, "campaignName": cp.name, "bidStrategy": cp.bidding_strategy_type.name,
            "budgetMicros": r.campaign_budget.amount_micros, "impressions": impr, "conversions": conv,
            "searchImpressionShare": m.search_impression_share,
            "lostISBudget": lost_budget, "lostISRank": lost_rank,
            "flags": flags, "impressionShareRecs": recs,
        })
    return out


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
    out: dict[int, list[dict]] = {}
    for r in _search(client, customer_id, audit_keyword_metrics_query(days, campaign_ids)):
        micros = r.metrics.average_cpc
        out.setdefault(r.campaign.id, []).append({
            "text": r.ad_group_criterion.keyword.text,
            "avg_cpc": micros_to_currency(micros),
            "avg_cpc_micros": int(micros or 0),
        })
    for kws in out.values():
        kws.sort(key=lambda k: k["avg_cpc"], reverse=True)
    return out


def _cluster_splits(kw_cpc: dict[int, list[dict]], names: dict[int, str]) -> list[dict]:
    """Per-campaign cluster-split recommendations (only campaigns where the CPC
    spread crosses the threshold appear)."""
    splits = []
    for cid, kws in kw_cpc.items():
        rec = cluster_split_recommendation(kws)
        if rec:
            splits.append({"campaignId": cid, "campaignName": names.get(cid, str(cid)), **rec})
    return splits


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
    out: dict[int, list[dict]] = {}
    for r in _search(client, customer_id, audit_search_terms_query(days, campaign_ids)):
        m = r.metrics
        out.setdefault(r.campaign.id, []).append({
            "search_term": r.search_term_view.search_term,
            "clicks": m.clicks,
            "conversions": m.conversions,
            "cost": micros_to_currency(m.cost_micros),
            "impressions": m.impressions,
        })
    return out


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
    grouped: dict[int, list[dict]] = reduce(
        lambda acc, pair: {**acc, pair[0]: acc.get(pair[0], []) + [pair[1]]},
        rows,
        {},
    )
    return {cid: sorted(kws, key=lambda k: k["qualityScore"]) for cid, kws in grouped.items()}


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

    # impression-share + keyword-CPC + quality-score layers
    serving: list[dict] = []
    cannibalization: list[dict] = []
    keyword_cpc: dict[int, list[dict]] = {}
    cluster_splits: list[dict] = []
    add_negatives: dict[int, list[dict]] = {}
    promote_keywords: dict[int, list[dict]] = {}
    camp_ids = [c.campaign.id for c in camps]
    quality_score: dict[int, list[dict]] = _quality_score(client, args.customer, camp_ids)
    if not args.no_serving:
        serving = _campaign_serving(client, args.customer, args.days, not args.all, args.campaign)
        cannibalization = _cannibalization(serving, kw_by_campaign)
        keyword_cpc = _keyword_cpc(client, args.customer, args.days, camp_ids)
        cluster_splits = _cluster_splits(keyword_cpc, {c.campaign.id: c.campaign.name for c in camps})
        search_terms = _search_terms(client, args.customer, args.days, camp_ids)
        for cid, terms in search_terms.items():
            existing = [{"text": kw} for kws in kw_by_campaign.get(cid, {}).values() for kw in kws]
            negs = negatives_to_add(terms)
            proms = keywords_to_promote(terms, existing)
            if negs:
                add_negatives[cid] = negs
            if proms:
                promote_keywords[cid] = proms

    # human summary -> stderr (stdout stays clean JSON for piping)
    total = 0
    for c in report:
        cf = c["campaignFindings"]
        bad_ads = [a for a in c["ads"] if a["issues"]]
        total += len(cf) + len(bad_ads)
        print(f"\n{c['campaignName']} ({c['campaignId']}) [{c['status']}] "
              f"sitelinks={c['sitelinks']} callouts={c['callouts']}", file=sys.stderr)
        for f in cf:
            print(f"  ! {f['issue']}: {f['detail']}", file=sys.stderr)
        for a in c["ads"]:
            tag = ", ".join(i["issue"] for i in a["issues"]) or "ok"
            print(f"    [{a['strength']:9}] {a['adGroup']:34} {len(a['headlines'])}H/{len(a['descriptions'])}D  {tag}", file=sys.stderr)
            if a["strength"] != "EXCELLENT":
                for step in a["pathToExcellent"]:
                    print(f"        -> {step}", file=sys.stderr)
    print(f"\n{total} creative findings across {len(report)} campaigns", file=sys.stderr)

    if not args.no_serving:
        print(f"\n=== IMPRESSION SHARE (last {args.days} days) ===", file=sys.stderr)
        for c in serving:
            tag = ", ".join(c["flags"]) or "serving"
            is_pct = f"{c['searchImpressionShare']*100:.0f}%" if c["impressions"] else "  -"
            lb = f"{c['lostISBudget']*100:.0f}%"; lr = f"{c['lostISRank']*100:.0f}%"
            print(f"    {c['campaignName']:34} impr={c['impressions']:>6} IS={is_pct:>4} "
                  f"lostBudget={lb:>4} lostRank={lr:>4} conv={c['conversions']:.0f} [{tag}]", file=sys.stderr)
            for rec in c["impressionShareRecs"]:
                print(f"        -> {rec}", file=sys.stderr)
        for p2 in cannibalization:
            print(f"  ~ cannibalization: {p2['a']} <> {p2['b']} share {p2['shared']} "
                  f"(starved: {p2['starvedLikely']})", file=sys.stderr)

        print(f"\n=== KEYWORD CPC (last {args.days} days) ===", file=sys.stderr)
        for c in serving:
            kws = keyword_cpc.get(c["campaignId"], [])
            if not kws:
                continue
            top = ", ".join(f"{k['text']} ${k['avg_cpc']:.2f}" for k in kws[:3])
            print(f"    {c['campaignName']:34} top CPC: {top}", file=sys.stderr)
        for s in cluster_splits:
            print(f"  ! cluster split: {s['campaignName']} — {s['reason']}", file=sys.stderr)

        names = {c["campaignId"]: c["campaignName"] for c in serving}
        if add_negatives:
            print(f"\n=== SEARCH-TERM WASTE → NEGATIVE CANDIDATES (last {args.days} days) ===", file=sys.stderr)
            for cid, negs in add_negatives.items():
                waste = sum(n["cost"] for n in negs)
                top = ", ".join(f"{n['text']} (${n['cost']:.2f})" for n in negs[:5])
                print(f"    {names.get(cid, str(cid)):34} ${waste:.2f} wasted / {len(negs)} terms: {top}", file=sys.stderr)
        if promote_keywords:
            print(f"\n=== CONVERTING SEARCH TERMS → PROMOTE CANDIDATES (last {args.days} days) ===", file=sys.stderr)
            for cid, proms in promote_keywords.items():
                top = ", ".join(f"{p['text']} ({p['conversions']:.0f} conv)" for p in proms[:5])
                print(f"    {names.get(cid, str(cid)):34} {len(proms)} terms: {top}", file=sys.stderr)

    bad_lp = {cid: [k for k in kws if k["landingPageExp"] == "BELOW_AVERAGE"]
              for cid, kws in quality_score.items()}
    bad_lp = {k: v for k, v in bad_lp.items() if v}
    if bad_lp:
        camp_names = {c.campaign.id: c.campaign.name for c in camps}
        print(f"\n=== QUALITY SCORE — LANDING PAGE EXP. BELOW AVERAGE ===", file=sys.stderr)
        for cid, kws in bad_lp.items():
            top = ", ".join(f"{k['keyword']} (QS {k['qualityScore']})" for k in kws[:5])
            print(f"    {camp_names.get(cid, str(cid)):34} {len(kws)} keywords: {top}", file=sys.stderr)

    emit_json(ok(customer=args.customer, campaigns=report,
                 serving=serving, cannibalization=cannibalization,
                 keywordCpc={str(k): v for k, v in keyword_cpc.items()},
                 clusterSplits=cluster_splits,
                 addNegatives={str(k): v for k, v in add_negatives.items()},
                 promoteKeywords={str(k): v for k, v in promote_keywords.items()},
                 qualityScore={str(k): v for k, v in quality_score.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
