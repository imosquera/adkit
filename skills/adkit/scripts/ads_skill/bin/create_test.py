from __future__ import annotations

import pytest

from ads_skill.bin.create import _parse_top_n
from ads_skill.ideas.parse import DEFAULT_TOP_N, MAX_KEYWORDS_PER_THEME


def test_parse_top_n_defaults_when_flag_absent() -> None:
    assert _parse_top_n(["some-idea", "--dry-run"]) == DEFAULT_TOP_N


def test_parse_top_n_reads_flag_value() -> None:
    assert _parse_top_n(["some-idea", "--top-n", "5"]) == 5


def test_parse_top_n_rejects_non_integer() -> None:
    with pytest.raises(SystemExit):
        _parse_top_n(["--top-n", "abc"])


def test_parse_top_n_rejects_out_of_range() -> None:
    with pytest.raises(SystemExit):
        _parse_top_n(["--top-n", str(MAX_KEYWORDS_PER_THEME + 1)])
    with pytest.raises(SystemExit):
        _parse_top_n(["--top-n", "0"])
