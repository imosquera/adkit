"""Pure markdown-extraction helpers for the /ads:create scaffold: read the
tier-grouped keywords and negative keywords that /ads:gtm authored under
"## Go To Market > ### Keywords". No SDK, no urllib, no stdout, no sys.exit —
every function is referentially transparent and covered by parse_test.py.

The IO shell (bin/create.py) reads the markdown off disk and feeds the text
into these functions; nothing here touches the filesystem or the network."""

from __future__ import annotations

import re

# STAG = Single Theme Ad Group. The scaffold makes one ad group per intent tier
# (Informational/Navigational/Commercial/Transactional) and packs up to this many
# keywords into each. 20 is Google's recommended STAG ceiling. `--top-n` overrides.
DEFAULT_TOP_N = 20
MAX_KEYWORDS_PER_THEME = 20

# STAG themes ARE the intent tiers. The model does the grouping in ads:gtm
# (each keyword is classified into exactly one tier — that classification IS the
# theme assignment). This skill only READS those pre-grouped themes; it makes no
# grouping decision of its own.
_TIER_THEMES = ("Informational", "Navigational", "Commercial", "Transactional")


def _slug_from_processed_path(md_path: str) -> str:
    leaf = md_path.rsplit("/", 1)[-1]
    return re.sub(r"\.(md|markdown)$", "", leaf, flags=re.IGNORECASE)


def _slice_until_next(text: str, pattern: str) -> str:
    m = re.search(pattern, text, flags=re.MULTILINE)
    return text[: m.start()] if m else text


def _strip_offer_suffix(bullet: str) -> str:
    """Drop the ' — offer: ...' / ' -- offer: ...' annotation appended by /ads:gtm
    to multi-intent bullets, leaving just the keyword phrase."""
    return re.sub(r"\s+[—–-]{1,2}\s*offer:.*$", "", bullet, flags=re.IGNORECASE).strip()


def _clean_keyword(raw: str) -> str:
    # Strip /ads:gtm decoration `(volume, competition, $L–$H)` at end.
    stripped = re.sub(r"\s*\([^)]*\)\s*$", "", _strip_offer_suffix(raw))
    return re.sub(r"[*_`]", "", stripped.lower()).strip()


def _extract_keywords(md: str, tiers: tuple[str, ...]) -> list[str]:
    """Pull bullets under the given tier headings (in order), deduped, lowercased,
    offer-suffix stripped. Order: tier order, then bullet order within each tier."""
    gtm = re.search(r"^##\s+Go\s+To\s+Market\b.*$", md, flags=re.IGNORECASE | re.MULTILINE)
    if not gtm:
        return []
    block = _slice_until_next(md[gtm.end():], r"^##\s+")
    kw = re.search(r"^###\s+Keywords\b.*$", block, flags=re.IGNORECASE | re.MULTILINE)
    if not kw:
        return []
    section = block[kw.end():]
    out: list[str] = []
    seen: set[str] = set()
    for heading in tiers:
        m = re.search(rf"^####\s+{re.escape(heading)}\b.*$", section, flags=re.IGNORECASE | re.MULTILINE)
        if not m:
            continue
        sub = _slice_until_next(section[m.end():], r"^####\s+")
        for bullet in re.findall(r"^\s*[-*]\s+(.+?)\s*$", sub, flags=re.MULTILINE):
            cleaned = _clean_keyword(bullet)
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                out.append(cleaned)
    return out


def _read_theme_groups(md: str, max_per_theme: int) -> list[tuple[str, list[str]]]:
    """Read the Single Theme Ad Groups defined upstream by ads:gtm — one per
    non-empty intent tier, in tier order, keywords in authored order. Truncates a
    theme to `max_per_theme` (Google's per-ad-group ceiling). No grouping logic:
    ads:gtm guarantees each keyword lives in exactly one tier."""
    themes: list[tuple[str, list[str]]] = []
    for tier in _TIER_THEMES:
        kws = _extract_keywords(md, (tier,))[:max_per_theme]
        if kws:
            themes.append((tier, kws))
    return themes


def _extract_negatives(md: str) -> list[dict]:
    """Pull bullets under '#### Negative Keywords' (within ### Keywords) into
    campaign negative-keyword dicts. Phrase only (reason suffix stripped); PHRASE
    match by default. Empty when the section is absent."""
    gtm = re.search(r"^##\s+Go\s+To\s+Market\b.*$", md, flags=re.IGNORECASE | re.MULTILINE)
    if not gtm:
        return []
    block = _slice_until_next(md[gtm.end():], r"^##\s+")
    kw = re.search(r"^###\s+Keywords\b.*$", block, flags=re.IGNORECASE | re.MULTILINE)
    if not kw:
        return []
    section = block[kw.end():]
    m = re.search(r"^####\s+Negative\s+Keywords\b.*$", section, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return []
    sub = _slice_until_next(section[m.end():], r"^####\s+")
    out: list[dict] = []
    seen: set[str] = set()
    for bullet in re.findall(r"^\s*[-*]\s+(.+?)\s*$", sub, flags=re.MULTILINE):
        phrase = _clean_keyword(re.split(r"\s+—\s+", bullet)[0])
        if phrase and phrase not in seen:
            seen.add(phrase)
            out.append({"text": phrase, "matchType": "PHRASE"})
    return out
