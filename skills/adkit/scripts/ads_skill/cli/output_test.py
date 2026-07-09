"""Tests for the shared CLI output helpers."""

import json

from ads_skill.cli.output import emit_json, error_envelope, ok, sdk_error_message


def test_ok_envelope() -> None:
    assert ok() == {"ok": True}
    assert ok(customer="123", count=2) == {"ok": True, "customer": "123", "count": 2}


def test_error_envelope() -> None:
    assert error_envelope("boom") == {"ok": False, "message": "boom"}
    assert error_envelope("boom", step="auth") == {"ok": False, "message": "boom", "step": "auth"}


def test_emit_json_pretty_to_stdout(capsys) -> None:
    emit_json(ok(a=1))
    out = capsys.readouterr().out
    assert json.loads(out) == {"ok": True, "a": 1}
    assert out.endswith("\n")
    assert "\n  " in out  # indent=2 pretty-printing


def test_emit_json_coerces_non_json_with_default_str(capsys) -> None:
    from pathlib import Path

    emit_json({"p": Path("/tmp/x")})
    assert json.loads(capsys.readouterr().out) == {"p": "/tmp/x"}


def test_sdk_error_message_falls_back_to_str() -> None:
    assert sdk_error_message(ValueError("plain")) == "plain"


def test_sdk_error_message_unwraps_google_ads_failure() -> None:
    class _Err:
        def __init__(self, message: str) -> None:
            self.message = message

    class _Failure:
        errors = [_Err("first bad thing"), _Err("second bad thing")]

    class _GoogleAdsException(Exception):
        failure = _Failure()

    assert sdk_error_message(_GoogleAdsException()) == "first bad thing; second bad thing"
