"""Interactively seed Google Ads secrets into Secret Manager (project your-project-prod)."""

from __future__ import annotations

import getpass
import os
import subprocess
import sys

PROJECT = os.environ.get("GOOGLE_ADS_SECRETS_PROJECT", "your-project-prod")
SECRETS = [
    "google-ads-developer-token",
    "google-ads-client-id",
    "google-ads-client-secret",
    "google-ads-refresh-token",
    "google-ads-login-customer-id",
    "google-ads-target-customer-id",
]


def _secret_exists(name: str) -> bool:
    return (
        subprocess.run(
            ["gcloud", "secrets", "describe", name, "--project", PROJECT],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    )


def _create_secret(name: str) -> None:
    subprocess.run(
        ["gcloud", "secrets", "create", name, "--project", PROJECT, "--replication-policy=automatic"],
        check=True,
    )


def _add_version(name: str, value: str) -> None:
    subprocess.run(
        ["gcloud", "secrets", "versions", "add", name, "--project", PROJECT, "--data-file=-"],
        input=value,
        text=True,
        check=True,
    )


def main() -> int:
    for name in SECRETS:
        prompt = f"Enter value for {name}: "
        # client_id and login_customer_id are not actually sensitive; rest are.
        value = (
            input(prompt) if name in ("google-ads-client-id", "google-ads-login-customer-id", "google-ads-target-customer-id")
            else getpass.getpass(prompt)
        )
        if not _secret_exists(name):
            _create_secret(name)
        _add_version(name, value)
        sys.stdout.write(f"  ✓ {name} updated\n")
    sys.stdout.write("Done. Render with: .claude/commands/ads/scripts/ads.sh render-yaml\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
