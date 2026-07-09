"""Import-everything smoke test.

Catches a subpackage that exists on disk but was never committed (as lib/ was —
silently swallowed by a too-broad .gitignore `lib/` rule) or any other broken
import chain, so a consumer syncing this skill doesn't discover it via a
ModuleNotFoundError at runtime instead of here at test time.
"""
from __future__ import annotations

import importlib
import pkgutil

import ads_skill


def _module_names() -> list[str]:
    return [
        info.name
        for info in pkgutil.walk_packages(ads_skill.__path__, prefix="ads_skill.")
        if not info.name.rsplit(".", 1)[-1].endswith("_test")
    ]


def test_every_ads_skill_module_imports_cleanly() -> None:
    failures = {}
    for name in _module_names():
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 - report every failure, not just the first
            failures[name] = repr(exc)
    assert not failures, f"modules failed to import: {failures}"
