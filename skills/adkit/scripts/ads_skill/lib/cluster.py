"""Pure, data-driven keyword-cluster analysis shared by the report and audit
skills. Given already-fetched performance rows (no SDK, no IO), it answers three
questions for a campaign:

  - keywords_to_promote: which search terms earned their keep and should become
    their own keywords (the data-driven replacement for a hand-authored cluster);
  - negatives_to_add: which search terms spent money without converting and
    should become campaign negatives;
  - cluster_split_recommendation: whether a campaign mixes a cheap-broad and an
    expensive-intent keyword group (the reputation-split pattern) such that one
    shared budget/bid lets the cheap terms starve the expensive ones.

Every function is referentially transparent: same rows in → same proposal out,
no clock, no mutation of the inputs. The IO shells (bin/report.py, bin/audit.py)
fetch the rows and render the results.
"""

from __future__ import annotations

from typing import Any, Iterable, TypedDict


class Proposal(TypedDict):
    text: str
    matchType: str
    clicks: int
    conversions: float
    cost: float


def _norm(text: str) -> str:
    """Case/space-fold a term so duplicates across ad groups collapse to one."""
    return " ".join(text.lower().split())


def _aggregate(search_terms: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Sum metrics for each distinct search term across all ad groups it appears in.
    Keyed by the normalized term; carries the first-seen original-case text."""
    agg: dict[str, dict[str, Any]] = {}
    for row in search_terms:
        raw = str(row.get("search_term", "")).strip()
        key = _norm(raw)
        if not key:
            continue
        a = agg.setdefault(
            key,
            {"text": raw, "clicks": 0, "conversions": 0.0, "cost": 0.0, "impressions": 0},
        )
        a["clicks"] += int(row.get("clicks", 0) or 0)
        a["conversions"] += float(row.get("conversions", 0) or 0.0)
        a["cost"] += float(row.get("cost", 0) or 0.0)
        a["impressions"] += int(row.get("impressions", 0) or 0)
    return agg


def keywords_to_promote(
    search_terms: Iterable[dict[str, Any]],
    existing_keywords: Iterable[dict[str, Any]] = (),
    *,
    min_clicks: int = 3,
    min_conversions: float = 1.0,
    limit: int = 25,
) -> list[Proposal]:
    """Search terms worth adding as their own PHRASE keywords: they drew real
    engagement (>= min_clicks) or converted (>= min_conversions) and are not
    already keywords. Sorted strongest-first (conversions, then clicks, then cost)."""
    existing = {_norm(str(k.get("text", ""))) for k in existing_keywords}
    kept = [
        a
        for key, a in _aggregate(search_terms).items()
        if key not in existing and (a["clicks"] >= min_clicks or a["conversions"] >= min_conversions)
    ]
    kept.sort(key=lambda a: (a["conversions"], a["clicks"], a["cost"]), reverse=True)
    return [
        {
            "text": a["text"],
            "matchType": "PHRASE",
            "clicks": a["clicks"],
            "conversions": round(a["conversions"], 2),
            "cost": round(a["cost"], 2),
        }
        for a in kept[:limit]
    ]


class Negative(TypedDict):
    text: str
    clicks: int
    cost: float
    impressions: int


def negatives_to_add(
    search_terms: Iterable[dict[str, Any]],
    *,
    min_cost: float = 1.0,
    limit: int = 25,
) -> list[Negative]:
    """Search terms that cost money but never converted — wasted spend, and so
    candidates for campaign negatives. Aggregated across ad groups, sorted by
    wasted cost descending."""
    kept = [
        a
        for a in _aggregate(search_terms).values()
        if a["conversions"] == 0 and a["cost"] >= min_cost
    ]
    kept.sort(key=lambda a: (a["cost"], a["impressions"]), reverse=True)
    return [
        {
            "text": a["text"],
            "clicks": a["clicks"],
            "cost": round(a["cost"], 2),
            "impressions": a["impressions"],
        }
        for a in kept[:limit]
    ]


class SplitRecommendation(TypedDict):
    maxCpc: float
    minCpc: float
    ratio: float
    expensive: list[str]
    cheap: list[str]
    reason: str


def cluster_split_recommendation(
    keywords: Iterable[dict[str, Any]],
    *,
    cpc_ratio: float = 3.0,
    min_keywords: int = 4,
) -> SplitRecommendation | None:
    """Detect a campaign that mixes a cheap-broad and an expensive-intent keyword
    group: when the priciest keyword's avg CPC is >= cpc_ratio x the cheapest, one
    shared budget/bid lets the cheap terms win every auction and starve the
    expensive ones — recommend splitting the expensive group into its own campaign.

    Returns None when there aren't enough priced keywords or the spread is tight.
    Pure: reads `text` + `avg_cpc` from each keyword row, mutates nothing.
    """
    priced = [
        {"text": str(k.get("text", "")).strip(), "cpc": float(k.get("avg_cpc", 0) or 0.0)}
        for k in keywords
        if float(k.get("avg_cpc", 0) or 0.0) > 0
    ]
    if len(priced) < min_keywords:
        return None
    cpcs = sorted(k["cpc"] for k in priced)
    lo, hi = cpcs[0], cpcs[-1]
    if lo <= 0 or hi < cpc_ratio * lo:
        return None
    # Split at the midpoint CPC: the dear half is the split candidate.
    midpoint = (lo + hi) / 2
    expensive = sorted({k["text"] for k in priced if k["cpc"] >= midpoint})
    cheap = sorted({k["text"] for k in priced if k["cpc"] < midpoint})
    return {
        "maxCpc": round(hi, 2),
        "minCpc": round(lo, 2),
        "ratio": round(hi / lo, 1),
        "expensive": expensive,
        "cheap": cheap,
        "reason": (
            f"Top keyword CPC (${hi:.2f}) is {hi / lo:.1f}x the cheapest (${lo:.2f}); "
            "split the expensive group into its own campaign with its own budget and "
            "bids so the cheap terms stop starving it."
        ),
    }
