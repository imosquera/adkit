"""Shared stdout/stderr helpers for the /ads:* bin entrypoints.

Every entrypoint speaks the same machine-readable contract to the markdown
skills: pretty-printed JSON on stdout, with a `{"ok": bool, ...}` envelope for
status payloads. Before this module that contract was re-implemented in four
places (`create._emit`, `preflight._emit`, and inline `print(json.dumps(...))`
in `audit`/`apply_fixes`), and the GoogleAdsException unwrap lived in three.
Keep the contract here so it stays consistent.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def emit_json(payload: Any) -> None:
    """Write a pretty-printed JSON payload to stdout — the channel the markdown
    skills parse. Human-readable narration belongs on stderr. `default=str`
    coerces stray non-JSON values (Path, HttpUrl, dataclass leftovers) rather
    than raising mid-emit."""
    sys.stdout.write(json.dumps(payload, indent=2, default=str) + "\n")


def ok(**fields: Any) -> dict:
    """Build a success envelope: {"ok": True, **fields}."""
    return {"ok": True, **fields}


def error_envelope(message: str, **fields: Any) -> dict:
    """Build a failure envelope: {"ok": False, "message": message, **fields}."""
    return {"ok": False, "message": message, **fields}


def sdk_error_message(exc: Exception) -> str:
    """Unwrap a GoogleAdsException into a concise '; '-joined message.

    GoogleAdsException carries the useful text under `.failure.errors[].message`;
    a bare `str(exc)` is a noisy multi-line repr. Fall back to `str(exc)` for any
    non-Google exception (credential load, network, etc.)."""
    failure = getattr(exc, "failure", None)
    errors = getattr(failure, "errors", None) or []
    msgs = "; ".join(e.message for e in errors)
    return msgs or str(exc)
