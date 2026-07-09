"""Pure scoring/detection logic for the audit skill — no google-ads client, no stdout.

These functions take already-fetched data (dicts/lists/strings) and compute findings.
The IO shell (bin/audit.py) runs the GAQL queries, builds the rows, calls these, and
prints. Keeping them SDK-free makes them unit-testable without a live account.
"""
from __future__ import annotations

from ..lib.brand import DIFFERENTIATION_AXES, GENERIC_AI_PHRASES

MIN_HEADLINES = 15
MIN_DESCRIPTIONS = 4
MIN_SITELINKS = 6
MIN_CALLOUTS = 4
# headline shared across >= this many ad groups in one campaign = keyword-agnostic boilerplate
SHARED_HEADLINE_GROUPS = 3

TIER_NAMES = {"informational", "navigational", "commercial", "transactional"}

# Impression-share thresholds — WHY a campaign isn't winning more impressions (a separate
# axis from ad strength: an EXCELLENT ad can still hold tiny IS).
IS_OPPORTUNITY = 0.65   # below this, there is meaningful impression share to win back
LOST_HI = 0.10          # losing >10% IS to a cause => flag that cause


def _concept_words(ag_name: str, keywords: list[str]) -> list[str]:
    """Words a winning headline should contain. Prefer the ad group's actual keywords;
    fall back to the name only when it isn't a generic intent-tier label."""
    src = " ".join(keywords) if keywords else ("" if ag_name.lower() in TIER_NAMES else ag_name)
    return [w for w in src.lower().replace(",", " ").split() if len(w) > 2]


def _path_to_excellent(ag_name, keywords, hs, ds, dup_h, echo, banned_hit, pins, action_items, strength) -> list[str]:
    """Deterministic, ordered to-do list that closes the gap to EXCELLENT ad strength.
    Combines the four levers Google scores (quantity, uniqueness, keyword inclusion, no
    pinning) with Google's own literal action_items (the asynchronous verdict)."""
    headlines_under = len(hs) < MIN_HEADLINES
    descriptions_under = len(ds) < MIN_DESCRIPTIONS
    # keyword inclusion: theme words present in >=3 headlines
    kw_words = _concept_words(ag_name, keywords)
    hits = sum(1 for h in hs if any(w in h.lower() for w in kw_words)) if kw_words else 0
    keyword_gap = bool(kw_words) and hits < 3

    steps = [
        *([f"Add {MIN_HEADLINES - len(hs)} more headlines (have {len(hs)}, target {MIN_HEADLINES}) — "
          f"distinct angles: value, feature, social proof, offer, audience, objection."] if headlines_under else []),
        *([f"Add {MIN_DESCRIPTIONS - len(ds)} more descriptions (have {len(ds)}, target {MIN_DESCRIPTIONS}), "
          f"each a different angle ending in a CTA."] if descriptions_under else []),
        *([f"Replace duplicate headlines with new angles: {dup_h}."] if dup_h else []),
        *([f"Rewrite descriptions that just echo a headline: {echo}."] if echo else []),
        *([f"Put the ad group's keyword (\"{keywords[0] if keywords else ag_name}\") in >=3 headlines "
          f"(currently ~{hits}). Google explicitly rewards keyword inclusion."] if keyword_gap else []),
        *([f"Remove off-product / contaminated copy: {banned_hit}."] if banned_hit else []),
        *([f"Unpin all assets (pinning blocks combination testing): {pins}."] if pins else []),
    ]
    # what our own steps already cover, to skip echoing a Google hint on the same topic
    topics = {
        *(["headline"] if headlines_under or dup_h else []),
        *(["description"] if descriptions_under or echo else []),
        *(["keyword", "headline"] if keyword_gap else []),
    }
    google_hints = [f"Google says: {it}" for it in action_items if not any(t in it.lower() for t in topics)]
    fallback = (["Assets meet the quantitative bar; add more distinct headline angles and "
                "stronger keyword coverage to push the diversity score to EXCELLENT."]
                if not steps and not google_hints and strength != "EXCELLENT" else [])
    return steps + google_hints + fallback


def _differentiation_gaps(headlines: list[str], descriptions: list[str]) -> dict | None:
    """Per-ad 'me-too copy' finding (FR-014/FR-015). Flags an ad whose message reads as
    a generic AI-tool promise AND fails to cover all three differentiation axes
    (integration / consistency / outcome), reporting which axes are absent. An ad that
    already leads with integration + brand-voice + outcome is NOT flagged even if it
    mentions AI. Pure: judged against the immutable differentiation reference."""
    blob = " ".join(headlines + descriptions).lower()
    generic = any(phrase in blob for phrase in GENERIC_AI_PHRASES)
    missing = [axis.name for axis in DIFFERENTIATION_AXES
               if not any(trigger in blob for trigger in axis.triggers)]
    if not generic or not missing:
        return None
    return {
        "issue": "undifferentiated_copy",
        "missingAxes": missing,
        "fix": "/adkit update — sharpen copy toward: " + ", ".join(missing),
    }


def _require_digits(label: str, value: str | None) -> None:
    """Caller-facing CLI guard for GAQL id interpolation: ids must be bare digits,
    no injection. Absent (None) is allowed. Delegates the digits check to the
    central gaql_id validator, re-raising as a CLI-friendly SystemExit."""
    if value is None:
        return
    from ..gaql.escape import gaql_id

    try:
        gaql_id(value)
    except ValueError:
        raise SystemExit(f"error: --{label} must be digits only, got {value!r}")


def _cannibalization(serving: list[dict], kw_by_campaign: dict[int, dict[str, list[str]]]) -> list[dict]:
    """Flag pairs of the account's own ENABLED campaigns that share keywords — Google
    serves only the higher-Ad-Rank one per auction, starving the other (self-competition).
    Pure: takes the prefetched keyword map, issues no queries."""
    kw = {c["campaignId"]: {k.lower() for ks in kw_by_campaign.get(c["campaignId"], {}).values() for k in ks}
          for c in serving}
    impr = {c["campaignId"]: c["impressions"] for c in serving}
    name = {c["campaignId"]: c["campaignName"] for c in serving}
    ids = list(kw)
    candidates = ((a, b, kw[a] & kw[b]) for i, a in enumerate(ids) for b in ids[i + 1:])
    return [
        {"a": name[a], "b": name[b], "shared": sorted(shared),
         "starvedLikely": name[a] if impr[a] < impr[b] else name[b]}
        for a, b, shared in candidates
        if shared
    ]
