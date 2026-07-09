"""Shared credential resolution for /adkit * skill entrypoints.

Single source of truth for `credentials_path` and `customer_id_from_yaml`,
used by both executor.py and the bin/* entrypoints."""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_CREDENTIALS_PATH = Path.home() / ".config" / "google-ads" / "google-ads.yaml"

# Sentinel: distinguishes "preserve the yaml's login_customer_id header" (no arg)
# from "override it" (any explicit value, including None). None is a meaningful
# override — it clears the MCC header for directly-accessible accounts.
_KEEP_YAML_LOGIN = object()


def credentials_path() -> str:
    return os.environ.get("GOOGLE_ADS_CREDENTIALS") or str(DEFAULT_CREDENTIALS_PATH)


def load_client(login_customer_id=_KEEP_YAML_LOGIN):
    """Load a GoogleAdsClient — the single client constructor for every /adkit * entrypoint.

    login_customer_id semantics:
      - omitted  -> keep the yaml's login_customer_id header (the MCC). This is
                    what publish/report/keyword-ideas/preflight want.
      - None     -> clear the header for accounts you access DIRECTLY (the yaml's
                    manager header otherwise breaks with USER_PERMISSION_DENIED).
                    Most /adkit audit targets are directly accessible.
      - an MCC id -> reach a leaf account through that manager."""
    from google.ads.googleads.client import GoogleAdsClient
    client = GoogleAdsClient.load_from_storage(credentials_path())
    if login_customer_id is not _KEEP_YAML_LOGIN:
        client.login_customer_id = login_customer_id
    return client


def customer_id_from_yaml() -> str | None:
    import yaml
    try:
        data = yaml.safe_load(Path(credentials_path()).read_text()) or {}
        # ponytail: target_customer_id is the leaf operating account; login_customer_id is the MCC
        cid = data.get("target_customer_id") or data.get("login_customer_id")
        return str(cid) if cid else None
    except Exception:
        return None
