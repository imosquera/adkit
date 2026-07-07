"""Pure validation/coercion for an /ads:audit fixes plan — no SDK, no stdout.

These functions take plain dicts/lists (the parsed plan plus live state already
fetched by the I/O shell) and return results: coerced keywords, dedup identities,
or a list of human-readable validation error strings. The shell in
``bin/apply_fixes.py`` runs the GAQL queries and mutations and prints; this module
holds the rules /ads:create also enforces, so they can be unit-tested without a
google-ads client.
"""
from __future__ import annotations

from pydantic import ValidationError

from ads_skill.lib.schema import AdGroupStatusChange, CampaignStatusChange, Keyword

H_MAX, D_MAX = 30, 90
H_TARGET, D_TARGET = 15, 4
SITELINK_TEXT_MAX, CALLOUT_MAX, SITELINK_DESC_MAX = 25, 25, 35
MAX_RAISE_PCT_CAP = 50  # hard ceiling: a budget raise beyond this % over current is refused
                        # (a plan's maxRaisePct can only lower this, never exceed it)


def _coerce_keyword(item) -> tuple[Keyword | None, str | None]:
    """Normalize a plan negative-keyword entry to a schema.Keyword.

    A bare string defaults to PHRASE match; a dict is {"text","matchType"} with
    matchType case-insensitive. Validation (length, allowed match type) is the
    same Keyword model /ads:create uses. Returns (Keyword, None) or (None, error)."""
    try:
        if isinstance(item, str):
            return Keyword(text=item), None
        if isinstance(item, dict):
            data = dict(item)
            mt = data.get("matchType")
            if isinstance(mt, str):
                data["matchType"] = mt.upper()
            return Keyword(**data), None
        return None, f"must be a string or object, got {type(item).__name__}"
    except ValidationError as ex:
        return None, ex.errors()[0]["msg"]


def _neg_key(text: str, match_type: str) -> tuple[str, str]:
    """Identity of a negative keyword for dedup: case-insensitive text + match type."""
    return (text.lower(), match_type)


def _new_negatives(group: dict, live_negatives: dict) -> list[Keyword]:
    """Coerced negatives in a plan group that are not already on the campaign and
    not repeated within the group. Dedup is case-insensitive on (text, matchType),
    so the batch handed to Google never contains duplicate criteria (which would
    fail the whole mutate). Invalid items are dropped here (already surfaced by
    _validate, which gates mutation)."""
    try:
        cid = int(group["campaignId"])
    except (KeyError, TypeError, ValueError):
        cid = None
    seen = set(live_negatives.get(cid, set()))  # start from what's already live
    out: list[Keyword] = []
    for item in group.get("add", []):
        kw, _ = _coerce_keyword(item)
        if kw is None:
            continue
        key = _neg_key(kw.text, kw.matchType)
        if key in seen:
            continue
        seen.add(key)
        out.append(kw)
    return out


def _as_int(value) -> int | None:
    """Best-effort numeric coercion for an id used as a live-state map key.
    Returns None for non-numeric (validation flags it separately)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _pos_key(text: str, match_type: str) -> tuple[str, str]:
    """Identity of a POSITIVE keyword for dedup/existence: case-insensitive text +
    match type. A keyword text can exist at multiple match types on one ad group, so
    the match type is part of the identity (this is what lets a 'change match type'
    op be a REMOVE(text,BROAD)+ADD(text,PHRASE) without the two colliding)."""
    return (text.lower(), match_type)


def _new_positive_keywords(group: dict, live_positive: dict) -> list[Keyword]:
    """Coerced ADD keywords in a `keywords` group that are not already on the ad group
    and not repeated within the group. Mirrors _new_negatives but is keyed per ad group
    and includes the match type, so re-running an already-applied plan adds nothing
    (FR-004) and creates no duplicate criteria. Invalid items are dropped here (already
    surfaced by _validate, which gates mutation)."""
    agid = _as_int(group.get("adGroupId"))
    seen = set(live_positive.get(agid, set()))  # start from what's already live
    out: list[Keyword] = []
    for item in group.get("add", []):
        kw, _ = _coerce_keyword(item)
        if kw is None:
            continue
        key = _pos_key(kw.text, kw.matchType)
        if key in seen:
            continue
        seen.add(key)
        out.append(kw)
    return out


def _campaign_status_plan(blocks: list, live_statuses: dict) -> tuple[list[dict], list[dict]]:
    """Split campaignStatus blocks into (changes, skips) against live state. A block
    whose target status already matches the campaign's live status is a skip (an
    idempotent no-op, never mutated); everything else is a change. Pure: live_statuses
    is {campaignId(int): statusName}. Each returned entry carries the original
    campaignId, the target status, and the campaign's current status (for reporting)."""
    changes: list[dict] = []
    skips: list[dict] = []
    for b in blocks:
        cid = _as_int(b.get("campaignId"))
        target = b.get("status")
        current = live_statuses.get(cid)
        entry = {"campaignId": b.get("campaignId"), "status": target, "current": current}
        (skips if current == target else changes).append(entry)
    return changes, skips


def _ad_group_status_plan(blocks: list, live_statuses: dict) -> tuple[list[dict], list[dict]]:
    """Split adGroupStatus blocks into (changes, skips) against live state. Mirrors
    _campaign_status_plan one level down: a block whose target status already matches
    the ad group's live status is a skip (idempotent no-op, never mutated); everything
    else is a change. Pure: live_statuses is {adGroupId(int): statusName}. Each returned
    entry carries the original adGroupId, the target status, and the ad group's current
    status (for reporting)."""
    changes: list[dict] = []
    skips: list[dict] = []
    for b in blocks:
        agid = _as_int(b.get("adGroupId"))
        target = b.get("status")
        current = live_statuses.get(agid)
        entry = {"adGroupId": b.get("adGroupId"), "status": target, "current": current}
        (skips if current == target else changes).append(entry)
    return changes, skips


def _validate(plan: dict, live_headlines: dict, budgets: dict,
              live_positive: dict | None = None) -> list[str]:
    e: list[str] = []
    for ng in plan.get("negatives", []):
        cid = ng.get("campaignId")
        if cid is None:
            e.append("negatives: entry missing campaignId")
        elif not str(cid).isdigit():
            e.append(f"negatives campaign {cid!r}: campaignId must be numeric")
        items = ng.get("add", [])
        if not items:
            e.append(f"negatives campaign {ng.get('campaignId')}: empty add list")
        for item in items:
            _, err = _coerce_keyword(item)
            if err:
                e.append(f"negatives campaign {ng.get('campaignId')}: {item!r}: {err}")
    for rw in plan.get("rewrites", []):
        hs, ds = rw.get("headlines", []), rw.get("descriptions", [])
        if len(hs) != H_TARGET: e.append(f"ad {rw['adId']}: {len(hs)} headlines (need {H_TARGET})")
        if len(ds) != D_TARGET: e.append(f"ad {rw['adId']}: {len(ds)} descriptions (need {D_TARGET})")
        if len(set(hs)) != len(hs): e.append(f"ad {rw['adId']}: duplicate headline")
        if len(set(ds)) != len(ds): e.append(f"ad {rw['adId']}: duplicate description")
        e += [f"ad {rw['adId']}: headline >{H_MAX} ({len(h)}) {h!r}" for h in hs if len(h) > H_MAX]
        e += [f"ad {rw['adId']}: description >{D_MAX} ({len(d)}) {d!r}" for d in ds if len(d) > D_MAX]
    for ap in plan.get("appendHeadlines", []):
        cur = live_headlines.get(ap["adId"], [])
        new = [h for h in ap["add"] if h not in cur]
        full = cur + new
        if len(full) != H_TARGET: e.append(f"ad {ap['adId']}: append -> {len(full)}H (need {H_TARGET}; have {len(cur)})")
        if len(set(full)) != len(full): e.append(f"ad {ap['adId']}: duplicate headline after append")
        e += [f"ad {ap['adId']}: headline >{H_MAX} ({len(h)}) {h!r}" for h in ap["add"] if len(h) > H_MAX]
    for sl in plan.get("sitelinks", []):
        for s in sl["add"]:
            if len(s["text"]) > SITELINK_TEXT_MAX: e.append(f"sitelink text >{SITELINK_TEXT_MAX}: {s['text']!r}")
            d1, d2 = s.get("description1"), s.get("description2")
            if bool(d1) != bool(d2): e.append(f"sitelink {s['text']!r}: descriptions must be both-or-neither")
            for d in (d1, d2):
                if d and len(d) > SITELINK_DESC_MAX: e.append(f"sitelink desc >{SITELINK_DESC_MAX}: {d!r}")
    for co in plan.get("callouts", []):
        for c in co["add"]:
            if len(c) > CALLOUT_MAX: e.append(f"callout >{CALLOUT_MAX} ({len(c)}): {c!r}")
    for b in plan.get("budgets", []):
        cid, target = b["campaignId"], b.get("dailyMicros")
        if not isinstance(target, int) or target <= 0:
            e.append(f"budget campaign {cid}: dailyMicros must be a positive int"); continue
        cur = budgets.get(cid, {}).get("amountMicros")
        if cur is None:
            e.append(f"budget campaign {cid}: no current budget found"); continue
        pct = min(b.get("maxRaisePct", MAX_RAISE_PCT_CAP), MAX_RAISE_PCT_CAP)  # cap can only be lowered
        cap = cur * (1 + pct / 100)
        if target > cap:
            e.append(f"budget campaign {cid}: ${target/1e6:.2f} exceeds guardrail "
                     f"(${cur/1e6:.2f} +{pct}% = ${cap/1e6:.2f})")
    live_pos = live_positive or {}
    for kb in plan.get("keywords", []):
        agid = kb.get("adGroupId")
        if agid is None:
            e.append("keywords: entry missing adGroupId")
        elif not str(agid).isdigit():
            e.append(f"keywords adGroup {agid!r}: adGroupId must be numeric")
        add, remove, pause = kb.get("add", []), kb.get("remove", []), kb.get("pause", [])
        if not (add or remove or pause):
            e.append(f"keywords adGroup {kb.get('adGroupId')}: empty operation lists (add/remove/pause)")
        for item in add:
            _, err = _coerce_keyword(item)
            if err:
                e.append(f"keywords adGroup {kb.get('adGroupId')}: add {item!r}: {err}")
        live_keys = live_pos.get(_as_int(agid), set())
        for label, items in (("remove", remove), ("pause", pause)):
            for item in items:
                kw, err = _coerce_keyword(item)
                if err:
                    e.append(f"keywords adGroup {kb.get('adGroupId')}: {label} {item!r}: {err}")
                    continue
                if _pos_key(kw.text, kw.matchType) not in live_keys:
                    e.append(f"keywords adGroup {kb.get('adGroupId')}: cannot {label} "
                             f"{kw.text}[{kw.matchType}] — not present on the ad group")
    for cs in plan.get("campaignStatus", []):
        if not isinstance(cs, dict):
            e.append(f"campaignStatus: entry must be an object, got {type(cs).__name__}")
            continue
        try:
            CampaignStatusChange(**cs)
        except ValidationError as ex:
            for err in ex.errors():
                loc = ".".join(str(p) for p in err.get("loc", ())) or "?"
                e.append(f"campaignStatus campaign {cs.get('campaignId')!r}: {loc}: {err['msg']}")
    for gs in plan.get("adGroupStatus", []):
        if not isinstance(gs, dict):
            e.append(f"adGroupStatus: entry must be an object, got {type(gs).__name__}")
            continue
        try:
            AdGroupStatusChange(**gs)
        except ValidationError as ex:
            for err in ex.errors():
                loc = ".".join(str(p) for p in err.get("loc", ())) or "?"
                e.append(f"adGroupStatus adGroup {gs.get('adGroupId')!r}: {loc}: {err['msg']}")
    return e
