"""Shell-level tests for apply_fixes.main — arg parsing + pre-mutation guards.

The pure validation/coercion rules live in ads_skill.fixes.plan and are tested in
ads_skill/fixes/plan_test.py. These cover the I/O shell's early exits, which return
before any google-ads client is constructed (so no SDK is needed)."""
from __future__ import annotations

import json
from pathlib import Path

from ads_skill.bin.apply_fixes import main


def test_main_no_path_arg_returns_2() -> None:
    assert main([]) == 2


def test_main_only_flag_no_path_returns_2() -> None:
    assert main(["--apply"]) == 2


def test_main_missing_file_returns_2(tmp_path: Path) -> None:
    assert main([str(tmp_path / "nope.json")]) == 2


def test_main_plan_missing_customer_id_returns_2(tmp_path: Path) -> None:
    p = tmp_path / "plan.json"
    p.write_text(json.dumps({"rewrites": []}))
    assert main([str(p)]) == 2


# ---------- campaignStatus apply path (campaign on/off, CHANGE 1) ----------

from types import SimpleNamespace as _NS

import ads_skill.bin.apply_fixes as af


def _status_client(live: dict):
    """Fake client whose GoogleAdsService.search returns the given live campaign
    statuses (the only read these campaignStatus-only plans trigger). mutate_campaigns
    records its calls so an --apply run can be asserted."""
    rows = [_NS(campaign=_NS(id=cid, status=_NS(name=name))) for cid, name in live.items()]
    mutations: list = []

    class _Svc:
        def search(self, *, customer_id, query):
            return rows

        def mutate_campaigns(self, *, customer_id, operations):
            mutations.append((customer_id, operations))
            return _NS(results=[_NS(resource_name="customers/1/campaigns/x") for _ in operations])

    class _Client:
        enums = _NS(CampaignStatusEnum={"ENABLED": "E", "PAUSED": "P"})

        def get_service(self, _n):
            return _Svc()

        def get_type(self, _n):
            return _NS(update=_NS(resource_name=None, status=None), update_mask=_NS(paths=[]))

    return _Client(), mutations


def _write_plan(tmp_path: Path, blocks: list) -> str:
    p = tmp_path / "plan.json"
    p.write_text(json.dumps({"customerId": "8911925499", "campaignStatus": blocks}))
    return str(p)


def test_campaign_status_dry_run_lists_changes_and_warns_on_enable(tmp_path, monkeypatch, capsys) -> None:
    client, mutations = _status_client({100: "PAUSED"})
    monkeypatch.setattr(af, "load_client", lambda _login: client)
    plan = _write_plan(tmp_path, [{"campaignId": "100", "status": "ENABLED"}])

    assert af.main([plan]) == 0  # dry-run (no --apply)
    out = capsys.readouterr().out
    assert "status PAUSED -> ENABLED" in out
    assert "WARNING: ENABLE starts live spend" in out
    assert mutations == []  # dry-run never mutates
    # JSON envelope carries the change + the loud live-spend key.
    payload = json.loads(out[out.index("{"):])
    assert payload["applied"] is False
    assert payload["enableStartsLiveSpend"] == ["100"]
    assert payload["campaignStatusChanges"][0]["campaignId"] == "100"


def test_campaign_status_idempotent_skip(tmp_path, monkeypatch, capsys) -> None:
    client, mutations = _status_client({100: "ENABLED"})
    monkeypatch.setattr(af, "load_client", lambda _login: client)
    plan = _write_plan(tmp_path, [{"campaignId": "100", "status": "ENABLED"}])

    assert af.main([plan, "--apply"]) == 0
    out = capsys.readouterr().out
    assert "already ENABLED, skipped" in out
    assert mutations == []  # no-op flip is never mutated
    payload = json.loads(out[out.index("{"):])
    assert payload["applied"] is True
    assert payload["campaignStatusChanges"] == []
    assert payload["campaignStatusSkipped"][0]["campaignId"] == "100"


def test_campaign_status_apply_pause_mutates(tmp_path, monkeypatch, capsys) -> None:
    client, mutations = _status_client({100: "ENABLED"})
    monkeypatch.setattr(af, "load_client", lambda _login: client)
    plan = _write_plan(tmp_path, [{"campaignId": "100", "status": "PAUSED"}])

    assert af.main([plan, "--apply"]) == 0
    out = capsys.readouterr().out
    assert len(mutations) == 1  # PAUSE flip executed
    assert "WARNING: ENABLE starts live spend" not in out  # PAUSE is not a live-spend warning
    payload = json.loads(out[out.index("{"):])
    assert payload["enableStartsLiveSpend"] == []
