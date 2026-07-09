"""Pure helper: format a Candidate into the decorated bullet text.

The slash command's LLM copies `bullet_text` VERBATIM into the markdown file.
This module is the ONLY producer of the decoration string (spec FR-017)."""

from __future__ import annotations

from .merge import Candidate
from .metrics import format_cpc_range, format_volume


def format_bullet_text(c: Candidate) -> str:
    if c.volume is None or c.competition is None:
        return c.phrase
    vol = format_volume(c.volume)
    cpc = format_cpc_range(c.low_micros, c.high_micros)
    return f"{c.phrase} ({vol}, {c.competition}, {cpc})"
