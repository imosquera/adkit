"""Pure helpers: volume short-form, CPC range, competition label.

No SDK imports. All functions are referentially transparent."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal


def format_volume(n: int) -> str:
    if n < 1_000:
        return str(n)
    unit, div = ("M", 1_000_000) if n >= 1_000_000 else ("k", 1_000)
    # ponytail: Decimal needed for ROUND_HALF_UP (3.65 → 3.7, not banker's 3.6)
    rounded = (Decimal(n) / div).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP).normalize()
    return f"{rounded}{unit}"


def _format_micros(micros: int | None) -> str:
    return f"${micros / 1_000_000:.2f}" if micros else "$–"


def format_cpc_range(low_micros: int | None, high_micros: int | None) -> str:
    low_missing = not low_micros
    high_missing = not high_micros
    if low_missing and high_missing:
        return "$–"
    if low_missing:
        # ponytail: asymmetric per spec — low-missing drops the range separator
        return f"$–{_format_micros(high_micros)}"
    return f"{_format_micros(low_micros)}–{_format_micros(high_micros)}"


def competition_label(value: object) -> str:
    name = getattr(value, "name", str(value)).upper()
    return name if name in {"LOW", "MEDIUM", "HIGH"} else "UNSPECIFIED"
