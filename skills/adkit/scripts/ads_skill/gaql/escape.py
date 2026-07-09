"""GAQL literal escaping + id validation — the single home for the two ways an
untrusted value can reach a Google Ads Query string.

`gaql_string` escapes a value destined for a single-quoted string literal
(campaign/ad-group names, geo names). `gaql_id` guards a value interpolated raw
(unquoted) into a query — campaign/customer ids — by requiring bare digits, so
nothing can break out of the numeric context. Callers that interpolate ids
directly MUST route them through `gaql_id` (or the audit-facing `_require_digits`,
which delegates here).
"""

from __future__ import annotations


def gaql_string(value: str) -> str:
    """Escape a value for a single-quoted GAQL string literal: backslash first
    (so the quote-escape's backslash isn't doubled), then the single quote."""
    return value.replace("\\", "\\\\").replace("'", "\\'")


def gaql_id(value: str) -> str:
    """Validate that an id interpolated raw (unquoted) into GAQL is digits-only,
    returning it unchanged. Raises ValueError otherwise — the numeric-context
    analogue of gaql_string, consolidating the scattered isdigit() guards."""
    if not str(value).isdigit():
        raise ValueError(f"GAQL id must be digits only, got {value!r}")
    return str(value)
