"""Verify env + credentials + customer access before any mutation.

Unlike the old MCP-era preflight, this script now does the actual API check itself
(list_accessible_customers) — no agent ping-pong required.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

_CREDS_PATH = Path.home() / ".config" / "google-ads" / "google-ads.yaml"
_CUSTOMER_RE = re.compile(r"^\d{10}$")


def _ok(**kwargs) -> None:
    print(json.dumps({"ok": True, **kwargs}))


def _fail(step: str, message: str) -> int:
    print(json.dumps({"ok": False, "error": {"step": step, "message": message}}))
    return 1


def main() -> int:
    # --- simple checks (no package imports required) ---
    customer_id = os.environ.get("GOOGLE_ADS_CUSTOMER_ID", "").strip()
    if not customer_id or not _CUSTOMER_RE.match(customer_id):
        return _fail(
            "env",
            "GOOGLE_ADS_CUSTOMER_ID must be set to a 10-digit Google Ads customer id (no dashes).",
        )

    cred_path = Path(os.environ.get("GOOGLE_ADS_CREDENTIALS", str(_CREDS_PATH)))
    if not cred_path.exists():
        return _fail(
            "credentials",
            f"Missing {cred_path}. Render it with: ads.sh render-yaml",
        )

    # --- live API check (requires package) ---
    try:
        from ..lib.auth import load_client  # noqa: PLC0415
    except ImportError:
        return _fail(
            "deps",
            "ads_skill package not importable. Run: uv sync inside the scripts/ directory.",
        )

    try:
        client = load_client()
    except Exception as exc:  # noqa: BLE001
        return _fail("auth", f"failed to load credentials from {cred_path}: {exc}")

    try:
        cust_svc = client.get_service("CustomerService")
        accessible = cust_svc.list_accessible_customers()
        accessible_ids = [
            re.sub(r"^customers/", "", rn) for rn in accessible.resource_names
        ]
    except Exception as exc:  # noqa: BLE001
        return _fail("auth", f"failed to call list_accessible_customers: {exc}")

    if customer_id not in accessible_ids:
        return _fail(
            "access",
            f"customer {customer_id} is not in the accessible list ({len(accessible_ids)} accounts visible). "
            "Confirm the login_customer_id in google-ads.yaml is the MCC that manages this customer.",
        )

    _ok(
        customerIdEnv=customer_id,
        credentialsYaml=str(cred_path),
        accessibleCustomerCount=len(accessible_ids),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
