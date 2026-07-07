"""Render ~/.config/google-ads/google-ads.yaml from Secret Manager (project your-project-prod)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT = os.environ.get("GOOGLE_ADS_SECRETS_PROJECT", "your-project-prod")
DEFAULT_TARGET = Path.home() / ".config" / "google-ads" / "google-ads.yaml"

# (field, secret_name, required). target_customer_id is skill-local, not a real
# google-ads client field; skip it if the secret is absent rather than failing.
SECRETS: list[tuple[str, str, bool]] = [
    ("developer_token", "google-ads-developer-token", True),
    ("client_id", "google-ads-client-id", True),
    ("client_secret", "google-ads-client-secret", True),
    ("refresh_token", "google-ads-refresh-token", True),
    ("login_customer_id", "google-ads-login-customer-id", True),
    ("target_customer_id", "google-ads-target-customer-id", False),
]


def _read_secret(name: str, required: bool) -> str | None:
    try:
        out = subprocess.check_output(
            [
                "gcloud",
                "secrets",
                "versions",
                "access",
                "latest",
                "--project",
                PROJECT,
                "--secret",
                name,
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        if required:
            raise
        return None
    return out.strip()


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TARGET
    target.parent.mkdir(parents=True, exist_ok=True)

    lines = [
        f"# Rendered by ads_skill.bin.render_yaml from Secret Manager project {PROJECT}.",
        "# Do not commit. Regenerate whenever secrets rotate.",
    ]
    for field, secret, required in SECRETS:
        value = _read_secret(secret, required)
        if value is None:
            continue
        value = value.replace('"', '\\"')
        lines.append(f'{field}: "{value}"')
    lines.append("use_proto_plus: true")

    with tempfile.NamedTemporaryFile(
        "w", delete=False, dir=str(target.parent), prefix="google-ads-", suffix=".yaml"
    ) as tmp:
        tmp.write("\n".join(lines) + "\n")
        tmp_path = Path(tmp.name)
    tmp_path.chmod(0o600)
    shutil.move(str(tmp_path), str(target))
    sys.stdout.write(f"wrote {target}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
