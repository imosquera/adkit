"""IO entry: apply a fixes plan (JSON) produced from an /ads:audit run.

The model authors the plan (product-specific copy); this script validates it against
the same RSA rules /ads:create enforces, then mutates. Dry-run unless --apply.

Plan JSON shape (all sections optional):
{
  "customerId": "1111111111",
  "loginCustomerId": null,
  "landingUrl": "https://www.example.com/ideas/<slug>",   # default for new sitelinks
  "rewrites":  [{"adId": 123, "headlines": [<15>], "descriptions": [<4>]}],   # full replace
  "appendHeadlines": [{"adId": 123, "add": ["..."]}],      # merge with live, keep existing
  "sitelinks": [{"campaignId": 456, "add": [{"text","finalUrl","description1","description2"}]}],
  "callouts":  [{"campaignId": 456, "add": ["No new portal", "Live in 30 days"]}],
  "negatives": [{"campaignId": 456, "add": ["free", {"text": "talk to ai", "matchType": "PHRASE"}]}],
  "keywords":  [{"adGroupId": 789, "add": ["ai reply tool"], "remove": [{"text":"ai writing","matchType":"BROAD"}], "pause": [{"text":"ai chatbot","matchType":"PHRASE"}]}],
  "budgets":   [{"campaignId": 456, "dailyMicros": 50000000, "maxRaisePct": 100}],
  "campaignStatus": [{"campaignId": "456", "status": "ENABLED"}],  # flip a campaign on/off
  "adGroupStatus": [{"adGroupId": "789", "status": "PAUSED"}]      # flip an ad group on/off
}

Negative keywords block off-theme search terms (the "you're spending on clicks you
don't need" nag). Each `add` item is a bare string (defaults to PHRASE match) or
{"text","matchType"} with matchType EXACT/PHRASE/BROAD. Negatives already present
on the campaign are skipped (so a plan is safe to re-run).

Positive `keywords` edit an ad group's own keywords (the horizontal->vertical pivot):
ADD (string=PHRASE, or {"text","matchType"}), REMOVE, PAUSE. Match type is immutable
on a live criterion, so a "change match type" is REMOVE(old)+ADD(new) in one block.
REMOVE/PAUSE of a keyword not on the ad group rejects the whole plan; ADDs already
live are skipped (idempotent).

Budgets spend real money, so they carry a hard guardrail: a raise above 50% over
the current budget is rejected (a plan's `maxRaisePct` can only lower that, never
exceed it). Lowering is always allowed.
Note: a budget shared by multiple campaigns is changed for all of them.

campaignStatus flips a campaign on (ENABLED) or off (PAUSED). It is idempotent —
each campaign's live status is read first and a flip into the status it is already in
is reported as skipped, not mutated. PAUSE is always allowed; ENABLE starts live
spend, so it is surfaced loudly (a warning line + a distinct key in the JSON
envelope) — never silent. The harness/permission layer gates the live-spend action.

adGroupStatus is the same, one level down: flip an ad group on/off. Idempotent (live
status read first, no-op flips skipped); PAUSE always safe (stops that ad group's
keywords from serving without touching the keywords themselves); ENABLE resumes live
spend and is surfaced loudly (warning line + adGroupEnableStartsLiveSpend key).

Usage: ads.sh update plan.json [--apply]   (alias: ads.sh apply-fixes)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from ads_skill.cli.output import emit_json, error_envelope, ok
from ads_skill.fixes.plan import (
    _ad_group_status_plan,
    _campaign_status_plan,
    _coerce_keyword,
    _neg_key,
    _new_negatives,
    _new_positive_keywords,
    _pos_key,
    _validate,
)
from ads_skill.gaql.builders import (
    apply_ad_group_statuses_query,
    apply_budgets_query,
    apply_campaign_statuses_query,
    apply_headlines_query,
    apply_negatives_query,
    apply_positive_keywords_query,
)
from ads_skill.lib.auth import load_client


def _live_negatives(client, customer_id, campaign_ids) -> dict:
    """campaignId(int) -> set of (text.lower(), matchType) already on the campaign."""
    if not campaign_ids:
        return {}
    svc = client.get_service("GoogleAdsService")
    q = apply_negatives_query(campaign_ids)
    out: dict = {}
    for r in svc.search(customer_id=customer_id, query=q):
        out.setdefault(r.campaign.id, set()).add(
            _neg_key(r.campaign_criterion.keyword.text, r.campaign_criterion.keyword.match_type.name))
    return out


def _live_campaign_statuses(client, customer_id, campaign_ids) -> dict:
    """campaignId(int) -> current campaign.status name (e.g. 'ENABLED'/'PAUSED'),
    so a campaignStatus block can skip a no-op flip (idempotent)."""
    if not campaign_ids:
        return {}
    svc = client.get_service("GoogleAdsService")
    q = apply_campaign_statuses_query(campaign_ids)
    return {r.campaign.id: r.campaign.status.name
            for r in svc.search(customer_id=customer_id, query=q)}


def _live_ad_group_statuses(client, customer_id, ad_group_ids) -> dict:
    """adGroupId(int) -> current ad_group.status name (e.g. 'ENABLED'/'PAUSED'),
    so an adGroupStatus block can skip a no-op flip (idempotent)."""
    if not ad_group_ids:
        return {}
    svc = client.get_service("GoogleAdsService")
    q = apply_ad_group_statuses_query(ad_group_ids)
    return {r.ad_group.id: r.ad_group.status.name
            for r in svc.search(customer_id=customer_id, query=q)}


def _campaign_budgets(client, customer_id, campaign_ids) -> dict:
    """campaignId -> {resource, amountMicros} for the campaign's current budget."""
    if not campaign_ids: return {}
    svc = client.get_service("GoogleAdsService")
    q = apply_budgets_query(campaign_ids)
    return {r.campaign.id: {"resource": r.campaign_budget.resource_name,
                            "amountMicros": r.campaign_budget.amount_micros}
            for r in svc.search(customer_id=customer_id, query=q)}


def _live_positive_keywords(client, customer_id, ad_group_ids) -> dict:
    """adGroupId(int) -> {(text.lower, matchType): criterionResource} for the live
    POSITIVE keywords on each ad group — used to dedup ADDs and resolve REMOVE/PAUSE
    targets to their criterion resource name."""
    if not ad_group_ids:
        return {}
    svc = client.get_service("GoogleAdsService")
    q = apply_positive_keywords_query(ad_group_ids)
    out: dict = {}
    for r in svc.search(customer_id=customer_id, query=q):
        out.setdefault(r.ad_group.id, {})[
            _pos_key(r.ad_group_criterion.keyword.text, r.ad_group_criterion.keyword.match_type.name)
        ] = r.ad_group_criterion.resource_name
    return out


def _live_headlines(client, customer_id, ad_ids) -> dict:
    if not ad_ids: return {}
    svc = client.get_service("GoogleAdsService")
    q = apply_headlines_query(ad_ids)
    return {r.ad_group_ad.ad.id: [h.text for h in r.ad_group_ad.ad.responsive_search_ad.headlines]
            for r in svc.search(customer_id=customer_id, query=q)}


def _set_rsa(client, ad, headlines, descriptions, mask):
    if headlines is not None:
        for t in headlines:
            a = client.get_type("AdTextAsset"); a.text = t; ad.responsive_search_ad.headlines.append(a)
        mask.append("responsive_search_ad.headlines")
    if descriptions is not None:
        for t in descriptions:
            a = client.get_type("AdTextAsset"); a.text = t; ad.responsive_search_ad.descriptions.append(a)
        mask.append("responsive_search_ad.descriptions")


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    apply = "--apply" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if not paths:
        emit_json(error_envelope("Provide a fixes plan JSON path")); return 2
    plan_path = Path(paths[0])
    if not plan_path.is_file():
        emit_json(error_envelope(f"plan file not found: {plan_path}")); return 2
    plan = json.loads(plan_path.read_text())
    if "customerId" not in plan:
        emit_json(error_envelope("plan is missing required 'customerId'")); return 2
    customer = str(plan["customerId"])
    login = plan.get("loginCustomerId")
    default_url = plan.get("landingUrl")

    client = load_client(login)
    live = _live_headlines(client, customer, [a["adId"] for a in plan.get("appendHeadlines", [])])
    budgets = _campaign_budgets(client, customer, [b["campaignId"] for b in plan.get("budgets", [])])
    live_neg = _live_negatives(client, customer, [n["campaignId"] for n in plan.get("negatives", [])])
    live_pos = _live_positive_keywords(client, customer, [k["adGroupId"] for k in plan.get("keywords", [])])
    live_status = _live_campaign_statuses(
        client, customer, [c["campaignId"] for c in plan.get("campaignStatus", [])])
    live_ag_status = _live_ad_group_statuses(
        client, customer, [g["adGroupId"] for g in plan.get("adGroupStatus", [])])

    errs = _validate(plan, live, budgets, live_pos)
    if errs:
        print("VALIDATION FAILED:"); [print("  -", e) for e in errs]; return 1

    status_changes, status_skips = _campaign_status_plan(plan.get("campaignStatus", []), live_status)
    enable_changes = [c for c in status_changes if c["status"] == "ENABLED"]
    ag_status_changes, ag_status_skips = _ad_group_status_plan(plan.get("adGroupStatus", []), live_ag_status)
    ag_enable_changes = [g for g in ag_status_changes if g["status"] == "ENABLED"]

    def _emit_status_envelope(applied: bool) -> None:
        # Surface the campaign/ad-group on/off plan as a machine-readable envelope so the
        # changes/skips (and any live-spend ENABLE) are never lost in narration.
        if not (plan.get("campaignStatus") or plan.get("adGroupStatus")):
            return
        emit_json(ok(
            applied=applied,
            campaignStatusChanges=status_changes,
            campaignStatusSkipped=status_skips,
            enableStartsLiveSpend=[c["campaignId"] for c in enable_changes],
            adGroupStatusChanges=ag_status_changes,
            adGroupStatusSkipped=ag_status_skips,
            adGroupEnableStartsLiveSpend=[g["adGroupId"] for g in ag_enable_changes],
        ))

    actions = ([f"rewrite ad {r['adId']} -> 15H/4D" for r in plan.get("rewrites", [])]
               + [f"append {len([h for h in a['add'] if h not in live.get(a['adId'], [])])} headlines to ad {a['adId']}"
                  for a in plan.get("appendHeadlines", [])]
               + [f"+{len(s['add'])} sitelinks on campaign {s['campaignId']}" for s in plan.get("sitelinks", [])]
               + [f"+{len(c['add'])} callouts on campaign {c['campaignId']}" for c in plan.get("callouts", [])]
               + [f"+{len(_new_negatives(n, live_neg))} negative keywords on campaign {n['campaignId']}"
                  f" ({len(n['add']) - len(_new_negatives(n, live_neg))} already present)"
                  for n in plan.get("negatives", [])]
               + [f"keywords adGroup {k['adGroupId']}: +{len(_new_positive_keywords(k, live_pos))} add"
                  f" ({len(k.get('add', [])) - len(_new_positive_keywords(k, live_pos))} already present),"
                  f" -{len(k.get('remove', []))} remove, ~{len(k.get('pause', []))} pause"
                  for k in plan.get("keywords", [])]
               + [f"budget campaign {b['campaignId']}: "
                  f"${budgets[b['campaignId']]['amountMicros']/1e6:.2f} -> ${b['dailyMicros']/1e6:.2f}/day"
                  for b in plan.get("budgets", [])]
               + [f"campaign {c['campaignId']}: status {c['current']} -> {c['status']}"
                  for c in status_changes]
               + [f"campaign {c['campaignId']}: status already {c['status']}, skipped"
                  for c in status_skips]
               + [f"adGroup {g['adGroupId']}: status {g['current']} -> {g['status']}"
                  for g in ag_status_changes]
               + [f"adGroup {g['adGroupId']}: status already {g['status']}, skipped"
                  for g in ag_status_skips])
    print("validation ok. planned actions:")
    for a in actions: print("  -", a)
    if enable_changes:
        # ENABLE starts live spend — make it impossible to miss (the permission
        # layer gates the actual mutation; this just guarantees it is never silent).
        print("WARNING: ENABLE starts live spend on campaign(s): "
              + ", ".join(str(c["campaignId"]) for c in enable_changes))
    if ag_enable_changes:
        # Enabling an ad group resumes live spend on its keywords — same loud surface.
        print("WARNING: ENABLE resumes live spend on ad group(s): "
              + ", ".join(str(g["adGroupId"]) for g in ag_enable_changes))
    if not apply:
        print("\nDry run. Re-run with --apply.")
        _emit_status_envelope(applied=False); return 0

    # 1) RSA rewrites + appends
    ad_svc = client.get_service("AdService"); ops = []
    for rw in plan.get("rewrites", []):
        op = client.get_type("AdOperation"); op.update.resource_name = f"customers/{customer}/ads/{rw['adId']}"
        _set_rsa(client, op.update, rw["headlines"], rw["descriptions"], op.update_mask.paths); ops.append(op)
    for ap in plan.get("appendHeadlines", []):
        cur = live.get(ap["adId"], [])
        full = cur + [h for h in ap["add"] if h not in cur]
        op = client.get_type("AdOperation"); op.update.resource_name = f"customers/{customer}/ads/{ap['adId']}"
        _set_rsa(client, op.update, full, None, op.update_mask.paths); ops.append(op)
    if ops:
        for r in ad_svc.mutate_ads(customer_id=customer, operations=ops).results:
            print("  mutated", r.resource_name)

    # 2) sitelinks
    asset_svc = client.get_service("AssetService"); ca_svc = client.get_service("CampaignAssetService")
    for sl in plan.get("sitelinks", []):
        for s in sl["add"]:
            aop = client.get_type("AssetOperation"); asset = aop.create
            asset.sitelink_asset.link_text = s["text"]
            if s.get("description1"): asset.sitelink_asset.description1 = s["description1"]
            if s.get("description2"): asset.sitelink_asset.description2 = s["description2"]
            asset.final_urls.append(s.get("finalUrl") or default_url)
            arn = asset_svc.mutate_assets(customer_id=customer, operations=[aop]).results[0].resource_name
            cop = client.get_type("CampaignAssetOperation")
            cop.create.campaign = f"customers/{customer}/campaigns/{sl['campaignId']}"
            cop.create.asset = arn
            cop.create.field_type = client.enums.AssetFieldTypeEnum.SITELINK
            ca_svc.mutate_campaign_assets(customer_id=customer, operations=[cop])
            print(f"  sitelink {s['text']!r} -> campaign {sl['campaignId']}")

    # 3) callouts
    for co in plan.get("callouts", []):
        for text in co["add"]:
            aop = client.get_type("AssetOperation"); aop.create.callout_asset.callout_text = text
            arn = asset_svc.mutate_assets(customer_id=customer, operations=[aop]).results[0].resource_name
            cop = client.get_type("CampaignAssetOperation")
            cop.create.campaign = f"customers/{customer}/campaigns/{co['campaignId']}"
            cop.create.asset = arn
            cop.create.field_type = client.enums.AssetFieldTypeEnum.CALLOUT
            ca_svc.mutate_campaign_assets(customer_id=customer, operations=[cop])
            print(f"  callout {text!r} -> campaign {co['campaignId']}")

    # 4) negative keywords (dedup against live, then add as campaign criteria)
    if plan.get("negatives"):
        from ads_skill.lib.executor import build_negative_keyword_ops
        crit_svc = client.get_service("CampaignCriterionService")
        for ng in plan["negatives"]:
            cid = ng["campaignId"]
            kws = _new_negatives(ng, live_neg)
            if not kws:
                print(f"  negatives campaign {cid}: all {len(ng['add'])} already present, skipped"); continue
            ops = build_negative_keyword_ops(client, f"customers/{customer}/campaigns/{cid}", kws)
            crit_svc.mutate_campaign_criteria(customer_id=customer, operations=ops)
            print(f"  +{len(kws)} negative keywords -> campaign {cid}: "
                  + ", ".join(f"{k.text}[{k.matchType[0]}]" for k in kws))

    # 4b) positive keyword edits (add / remove / pause on ad-group criteria)
    if plan.get("keywords"):
        from ads_skill.lib.executor import build_keyword_ops
        agc_svc = client.get_service("AdGroupCriterionService")
        for kb in plan["keywords"]:
            agid = kb["adGroupId"]
            adds = _new_positive_keywords(kb, live_pos)
            live_keys = live_pos.get(int(agid), {})

            def _rn(item):
                kw, _ = _coerce_keyword(item)
                return live_keys[_pos_key(kw.text, kw.matchType)]

            remove_rns = [_rn(item) for item in kb.get("remove", [])]
            pause_rns = [_rn(item) for item in kb.get("pause", [])]
            ops = build_keyword_ops(client, f"customers/{customer}/adGroups/{agid}",
                                    adds, remove_rns, pause_rns)
            if not ops:
                print(f"  keywords adGroup {agid}: nothing to do (all adds already present)"); continue
            agc_svc.mutate_ad_group_criteria(customer_id=customer, operations=ops)
            print(f"  keywords adGroup {agid}: +{len(adds)} add, -{len(remove_rns)} remove, "
                  f"~{len(pause_rns)} pause")

    # 5) budgets (guardrail already enforced in _validate)
    if plan.get("budgets"):
        bsvc = client.get_service("CampaignBudgetService")
        for b in plan["budgets"]:
            cid = b["campaignId"]
            op = client.get_type("CampaignBudgetOperation")
            op.update.resource_name = budgets[cid]["resource"]
            op.update.amount_micros = b["dailyMicros"]
            op.update_mask.paths.append("amount_micros")
            bsvc.mutate_campaign_budgets(customer_id=customer, operations=[op])
            print(f"  budget campaign {cid} -> ${b['dailyMicros']/1e6:.2f}/day")

    # 6) campaign on/off (enable/pause). No-op flips were already filtered into
    # status_skips and never reach the mutate (idempotent). PAUSE is always safe;
    # ENABLE starts live spend and was surfaced loudly above.
    if status_changes:
        from ads_skill.lib.executor import set_campaign_status
        for c in status_changes:
            set_campaign_status(client, customer, str(c["campaignId"]), c["status"])
            print(f"  campaign {c['campaignId']}: status {c['current']} -> {c['status']}")
    for c in status_skips:
        print(f"  campaign {c['campaignId']}: status already {c['status']}, skipped")

    # 7) ad group on/off (enable/pause). Same idempotent + loud-ENABLE contract as
    # campaigns, one level down: pause a dead-weight ad group without touching its keywords.
    if ag_status_changes:
        from ads_skill.lib.executor import set_ad_group_status
        for g in ag_status_changes:
            set_ad_group_status(client, customer, str(g["adGroupId"]), g["status"])
            print(f"  adGroup {g['adGroupId']}: status {g['current']} -> {g['status']}")
    for g in ag_status_skips:
        print(f"  adGroup {g['adGroupId']}: status already {g['status']}, skipped")
    _emit_status_envelope(applied=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
