"""Pure validation/coercion for an /adkit audit fixes plan — no SDK, no stdout.

These functions take plain dicts/lists (the parsed plan plus live state already
fetched by the I/O shell) and return results: coerced keywords, dedup identities,
or a list of human-readable validation error strings. The shell in
``bin/apply_fixes.py`` runs the GAQL queries and mutations and prints; this module
holds the rules /adkit create also enforces, so they can be unit-tested without a
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
    same Keyword model /adkit create uses. Returns (Keyword, None) or (None, error)."""
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


def _status_plan(blocks: list, live_statuses: dict, id_key: str) -> tuple[list[dict], list[dict]]:
    """Split status-change blocks into (changes, skips) against live state. A block
    whose target status already matches the live status is a skip (an idempotent
    no-op, never mutated); everything else is a change. Pure: live_statuses is
    {id(int): statusName}. Each returned entry carries the original id, the target
    status, and the current status (for reporting). Shared by campaignStatus and
    adGroupStatus, which differ only in which id field they carry."""
    entries = [
        {id_key: b.get(id_key), "status": b.get("status"),
         "current": live_statuses.get(_as_int(b.get(id_key)))}
        for b in blocks
    ]
    changes = [e for e in entries if e["current"] != e["status"]]
    skips = [e for e in entries if e["current"] == e["status"]]
    return changes, skips


def _campaign_status_plan(blocks: list, live_statuses: dict) -> tuple[list[dict], list[dict]]:
    return _status_plan(blocks, live_statuses, "campaignId")


def _ad_group_status_plan(blocks: list, live_statuses: dict) -> tuple[list[dict], list[dict]]:
    return _status_plan(blocks, live_statuses, "adGroupId")


def _negatives_errors(negatives: list) -> list[str]:
    def _one(ng: dict) -> list[str]:
        cid = ng.get("campaignId")
        items = ng.get("add", [])
        return [
            *(["negatives: entry missing campaignId"] if cid is None else []),
            *([f"negatives campaign {cid!r}: campaignId must be numeric"]
              if cid is not None and not str(cid).isdigit() else []),
            *([f"negatives campaign {ng.get('campaignId')}: empty add list"] if not items else []),
            *[f"negatives campaign {ng.get('campaignId')}: {item!r}: {err}"
              for item in items for err in [_coerce_keyword(item)[1]] if err],
        ]

    return [err for ng in negatives for err in _one(ng)]


def _rewrites_errors(rewrites: list) -> list[str]:
    def _one(rw: dict) -> list[str]:
        hs, ds = rw.get("headlines", []), rw.get("descriptions", [])
        return [
            *([f"ad {rw['adId']}: {len(hs)} headlines (need {H_TARGET})"] if len(hs) != H_TARGET else []),
            *([f"ad {rw['adId']}: {len(ds)} descriptions (need {D_TARGET})"] if len(ds) != D_TARGET else []),
            *([f"ad {rw['adId']}: duplicate headline"] if len(set(hs)) != len(hs) else []),
            *([f"ad {rw['adId']}: duplicate description"] if len(set(ds)) != len(ds) else []),
            *[f"ad {rw['adId']}: headline >{H_MAX} ({len(h)}) {h!r}" for h in hs if len(h) > H_MAX],
            *[f"ad {rw['adId']}: description >{D_MAX} ({len(d)}) {d!r}" for d in ds if len(d) > D_MAX],
        ]

    return [err for rw in rewrites for err in _one(rw)]


def _append_headlines_errors(appends: list, live_headlines: dict) -> list[str]:
    def _one(ap: dict) -> list[str]:
        cur = live_headlines.get(ap["adId"], [])
        full = cur + [h for h in ap["add"] if h not in cur]
        return [
            *([f"ad {ap['adId']}: append -> {len(full)}H (need {H_TARGET}; have {len(cur)})"]
              if len(full) != H_TARGET else []),
            *([f"ad {ap['adId']}: duplicate headline after append"] if len(set(full)) != len(full) else []),
            *[f"ad {ap['adId']}: headline >{H_MAX} ({len(h)}) {h!r}" for h in ap["add"] if len(h) > H_MAX],
        ]

    return [err for ap in appends for err in _one(ap)]


def _sitelinks_errors(sitelink_blocks: list) -> list[str]:
    def _one(s: dict) -> list[str]:
        d1, d2 = s.get("description1"), s.get("description2")
        return [
            *([f"sitelink text >{SITELINK_TEXT_MAX}: {s['text']!r}"] if len(s["text"]) > SITELINK_TEXT_MAX else []),
            *([f"sitelink {s['text']!r}: descriptions must be both-or-neither"] if bool(d1) != bool(d2) else []),
            *[f"sitelink desc >{SITELINK_DESC_MAX}: {d!r}" for d in (d1, d2) if d and len(d) > SITELINK_DESC_MAX],
        ]

    return [err for sl in sitelink_blocks for s in sl["add"] for err in _one(s)]


def _callouts_errors(callout_blocks: list) -> list[str]:
    return [f"callout >{CALLOUT_MAX} ({len(c)}): {c!r}"
            for co in callout_blocks for c in co["add"] if len(c) > CALLOUT_MAX]


def _budgets_errors(budget_blocks: list, budgets: dict) -> list[str]:
    def _one(b: dict) -> list[str]:
        cid, target = b["campaignId"], b.get("dailyMicros")
        if not isinstance(target, int) or target <= 0:
            return [f"budget campaign {cid}: dailyMicros must be a positive int"]
        cur = budgets.get(cid, {}).get("amountMicros")
        if cur is None:
            return [f"budget campaign {cid}: no current budget found"]
        pct = min(b.get("maxRaisePct", MAX_RAISE_PCT_CAP), MAX_RAISE_PCT_CAP)  # cap can only be lowered
        cap = cur * (1 + pct / 100)
        return ([f"budget campaign {cid}: ${target/1e6:.2f} exceeds guardrail "
                f"(${cur/1e6:.2f} +{pct}% = ${cap/1e6:.2f})"] if target > cap else [])

    return [err for b in budget_blocks for err in _one(b)]


def _keywords_errors(keyword_blocks: list, live_positive: dict | None) -> list[str]:
    live_pos = live_positive or {}

    def _one(kb: dict) -> list[str]:
        agid = kb.get("adGroupId")
        add, remove, pause = kb.get("add", []), kb.get("remove", []), kb.get("pause", [])
        live_keys = live_pos.get(_as_int(agid), set())

        def _rp_errors(label: str, items: list) -> list[str]:
            def _item_errors(item) -> list[str]:
                kw, err = _coerce_keyword(item)
                if err:
                    return [f"keywords adGroup {kb.get('adGroupId')}: {label} {item!r}: {err}"]
                if _pos_key(kw.text, kw.matchType) not in live_keys:
                    return [f"keywords adGroup {kb.get('adGroupId')}: cannot {label} "
                           f"{kw.text}[{kw.matchType}] — not present on the ad group"]
                return []

            return [err for item in items for err in _item_errors(item)]

        return [
            *(["keywords: entry missing adGroupId"] if agid is None else []),
            *([f"keywords adGroup {agid!r}: adGroupId must be numeric"]
              if agid is not None and not str(agid).isdigit() else []),
            *([f"keywords adGroup {kb.get('adGroupId')}: empty operation lists (add/remove/pause)"]
              if not (add or remove or pause) else []),
            *[f"keywords adGroup {kb.get('adGroupId')}: add {item!r}: {err}"
              for item in add for err in [_coerce_keyword(item)[1]] if err],
            *_rp_errors("remove", remove),
            *_rp_errors("pause", pause),
        ]

    return [err for kb in keyword_blocks for err in _one(kb)]


def _status_change_errors(blocks: list, model, label: str, noun: str, id_field: str) -> list[str]:
    """Shared shape for campaignStatus/adGroupStatus: each block must parse as
    `model(**block)`; every pydantic error surfaces prefixed with `label`/`noun`
    and the block's id."""
    def _one(item) -> list[str]:
        if not isinstance(item, dict):
            return [f"{label}: entry must be an object, got {type(item).__name__}"]
        try:
            model(**item)
            return []
        except ValidationError as ex:
            return [
                f"{label} {noun} {item.get(id_field)!r}: "
                f"{'.'.join(str(p) for p in err.get('loc', ())) or '?'}: {err['msg']}"
                for err in ex.errors()
            ]

    return [err for item in blocks for err in _one(item)]


def _validate(plan: dict, live_headlines: dict, budgets: dict,
              live_positive: dict | None = None) -> list[str]:
    return [
        *_negatives_errors(plan.get("negatives", [])),
        *_rewrites_errors(plan.get("rewrites", [])),
        *_append_headlines_errors(plan.get("appendHeadlines", []), live_headlines),
        *_sitelinks_errors(plan.get("sitelinks", [])),
        *_callouts_errors(plan.get("callouts", [])),
        *_budgets_errors(plan.get("budgets", []), budgets),
        *_keywords_errors(plan.get("keywords", []), live_positive),
        *_status_change_errors(plan.get("campaignStatus", []), CampaignStatusChange,
                              "campaignStatus", "campaign", "campaignId"),
        *_status_change_errors(plan.get("adGroupStatus", []), AdGroupStatusChange,
                              "adGroupStatus", "adGroup", "adGroupId"),
    ]
