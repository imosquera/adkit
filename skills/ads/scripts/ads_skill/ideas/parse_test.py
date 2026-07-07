from __future__ import annotations

from ads_skill.ideas.parse import _extract_negatives, _read_theme_groups


def test_read_theme_groups_one_ad_group_per_tier_in_order() -> None:
    md = """
## Go To Market

### Keywords

#### Informational

- what is a widget

#### Commercial

- buy widgets online
- compare widget prices

#### Transactional

- widget checkout
"""
    themes = _read_theme_groups(md, 20)
    assert themes == [
        ("Informational", ["what is a widget"]),
        ("Commercial", ["buy widgets online", "compare widget prices"]),
        ("Transactional", ["widget checkout"]),
    ]


def test_read_theme_groups_strips_offer_suffix_and_markdown() -> None:
    md = """
## Go To Market

### Keywords

#### Commercial

- hire widget agency — offer: 15-minute walkthrough
- *widget pricing* now
"""
    assert _read_theme_groups(md, 20) == [
        ("Commercial", ["hire widget agency", "widget pricing now"]),
    ]


def test_read_theme_groups_reads_tiers_verbatim() -> None:
    # The reader makes NO grouping decision — it trusts ads:gtm to put each
    # keyword in exactly one tier and reads each tier's bullets as authored.
    md = """
## Go To Market

### Keywords

#### Commercial

- widget pricing
- compare widgets

#### Transactional

- buy widgets
"""
    assert _read_theme_groups(md, 20) == [
        ("Commercial", ["widget pricing", "compare widgets"]),
        ("Transactional", ["buy widgets"]),
    ]


def test_read_theme_groups_caps_keywords_per_theme() -> None:
    md = """
## Go To Market

### Keywords

#### Commercial

- one
- two
- three
- four
"""
    assert _read_theme_groups(md, 2) == [("Commercial", ["one", "two"])]


def test_read_theme_groups_empty_when_no_gtm_section() -> None:
    assert _read_theme_groups("## Something Else\n\n- foo\n", 20) == []


def test_extract_negatives_parses_section_strips_reason() -> None:
    md = """
## Go To Market

### Keywords

#### Commercial

- buy widgets

#### Negative Keywords

- jobs — reason: job seekers
- *free* download
- near me
"""
    assert _extract_negatives(md) == [
        {"text": "jobs", "matchType": "PHRASE"},
        {"text": "free download", "matchType": "PHRASE"},
        {"text": "near me", "matchType": "PHRASE"},
    ]


def test_extract_negatives_empty_when_absent() -> None:
    md = "## Go To Market\n\n### Keywords\n\n#### Commercial\n\n- buy widgets\n"
    assert _extract_negatives(md) == []
