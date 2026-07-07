"""Verify env + credentials + customer access before any mutation.

Unlike the old MCP-era preflight, this script now does the actual API check itself
(list_accessible_customers) — no agent ping-pong required.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from ..cli.output import emit_json, error_envelope, ok
from ..lib.auth import credentials_path, load_client
from ..lib.schema import CUSTOMER_ID_PATTERN


def _fail(step: str, message: str) -> int:
    emit_json(error_envelope(message, step=step))
    return 1


def main() -> int:
    customer_id = os.environ.get("GOOGLE_ADS_CUSTOMER_ID", "").strip()
    if not customer_id or not CUSTOMER_ID_PATTERN.match(customer_id):
        return _fail(
            "env",
            "GOOGLE_ADS_CUSTOMER_ID must be set to a 10-digit Google Ads customer id (no dashes).",
        )

    cred_path = credentials_path()
    if not Path(cred_path).exists():
        return _fail(
            "credentials",
            f"Missing {cred_path}. Render it with: .claude/commands/ads/scripts/ads.sh render-yaml",
        )

    # Live API check: confirm the OAuth identity can see the target customer.
    try:
        client = load_client()
    except ImportError:
        return _fail(
            "deps",
            "google-ads package not installed. Run: uv sync --project .claude/commands/ads/scripts",
        )
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

    emit_json(
        ok(
            customerIdEnv=customer_id,
            credentialsYaml=cred_path,
            accessibleCustomerCount=len(accessible_ids),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
