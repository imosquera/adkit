"""Tests for shared customer-id resolution."""

import ads_skill.cli.args as args_mod
from ads_skill.cli.args import normalize_id, resolve_customer


def test_normalize_id_strips_dashes() -> None:
    assert normalize_id("891-192-5499") == "8911925499"
    assert normalize_id("8911925499") == "8911925499"


def test_normalize_id_passes_through_empty() -> None:
    assert normalize_id(None) is None
    assert normalize_id("") == ""


def test_resolve_customer_first_non_empty_wins() -> None:
    assert resolve_customer("111-111-1111", "2222222222") == "1111111111"
    assert resolve_customer(None, "", "333-333-3333") == "3333333333"


def test_resolve_customer_falls_back_to_yaml(monkeypatch) -> None:
    monkeypatch.setattr(args_mod, "customer_id_from_yaml", lambda: "444-444-4444")
    assert resolve_customer(None) == "4444444444"
    assert resolve_customer(None, None) == "4444444444"


def test_resolve_customer_skips_yaml_when_disabled(monkeypatch) -> None:
    monkeypatch.setattr(args_mod, "customer_id_from_yaml", lambda: "5555555555")
    assert resolve_customer(None, fallback_yaml=False) is None


def test_resolve_customer_none_when_nothing_resolves(monkeypatch) -> None:
    monkeypatch.setattr(args_mod, "customer_id_from_yaml", lambda: None)
    assert resolve_customer(None, "") is None
