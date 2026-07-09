from __future__ import annotations

from ads_skill.lib.metrics import competition_label, format_cpc_range, format_volume


def test_format_volume_under_thousand() -> None:
    assert format_volume(0) == "0"
    assert format_volume(24) == "24"
    assert format_volume(999) == "999"


def test_format_volume_thousands_round_half_up_and_drop_trailing_zero() -> None:
    assert format_volume(1_000) == "1k"
    assert format_volume(1_499) == "1.5k"
    assert format_volume(3_000) == "3k"
    assert format_volume(3_650) == "3.7k"  # 3.65 → 3.7 (half up)


def test_format_volume_millions() -> None:
    assert format_volume(1_000_000) == "1M"
    assert format_volume(1_500_000) == "1.5M"


def test_format_cpc_range_both_present() -> None:
    assert format_cpc_range(8_200_000, 14_000_000) == "$8.20–$14.00"


def test_format_cpc_range_low_missing() -> None:
    assert format_cpc_range(None, 14_000_000) == "$–$14.00"
    assert format_cpc_range(0, 14_000_000) == "$–$14.00"


def test_format_cpc_range_high_missing() -> None:
    assert format_cpc_range(8_200_000, None) == "$8.20–$–"
    assert format_cpc_range(8_200_000, 0) == "$8.20–$–"


def test_format_cpc_range_both_missing() -> None:
    assert format_cpc_range(None, None) == "$–"
    assert format_cpc_range(0, 0) == "$–"


class _Enum:
    def __init__(self, name: str) -> None:
        self.name = name


def test_competition_label_known() -> None:
    assert competition_label(_Enum("LOW")) == "LOW"
    assert competition_label(_Enum("MEDIUM")) == "MEDIUM"
    assert competition_label(_Enum("HIGH")) == "HIGH"


def test_competition_label_unknown_collapses_to_unspecified() -> None:
    assert competition_label(_Enum("UNKNOWN")) == "UNSPECIFIED"
    assert competition_label(_Enum("UNSPECIFIED")) == "UNSPECIFIED"
    assert competition_label("garbage") == "UNSPECIFIED"
