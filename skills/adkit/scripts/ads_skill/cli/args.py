"""Shared customer-id resolution for the /adkit * entrypoints.

Before this, the brief->flag->env->yaml precedence and the dash-stripping
(891-192-5499 -> 8911925499) were re-implemented in create/audit/keyword_ideas/
report, each slightly differently (only report stripped dashes). Resolve it once
here so every entrypoint agrees. Each caller keeps its own "nothing resolved"
error UX, so this returns None rather than raising.
"""

from __future__ import annotations

from ..lib.auth import customer_id_from_yaml


def normalize_id(value: str | None) -> str | None:
    """Strip the human-readable dashes from a customer/manager id.
    891-192-5499 -> 8911925499. None/empty passes through unchanged."""
    return value.replace("-", "") if value else value


def resolve_customer(*candidates: str | None, fallback_yaml: bool = True) -> str | None:
    """First non-empty candidate (brief field, --flag, env), dash-stripped;
    else the yaml's target/login id when fallback_yaml. None if nothing resolves.

    Digit validation is intentionally left to the caller (via gaql.escape.gaql_id
    or the audit CLI validator) so each entrypoint controls its own error path."""
    for candidate in candidates:
        if candidate:
            return normalize_id(str(candidate))
    if fallback_yaml:
        return normalize_id(customer_id_from_yaml())
    return None
