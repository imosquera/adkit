from __future__ import annotations

from ads_skill.ideas.urls import final_urls, unreachable_urls, url_unreachable_reason
from ads_skill.lib.schema import Brief


def _brief_for_urls(rsa_url: str, sitelink_url: str) -> Brief:
    return Brief.model_validate({
        "name": "url-test",
        "version": 1,
        "campaign": {
            "name": "url-test-search",
            "budgetMicros": 10_000_000,
            "networkSettings": "search-only",
            "sitelinks": [
                {"text": f"L{i}", "finalUrl": sitelink_url} for i in range(6)
            ],
        },
        "adGroups": [{
            "name": "Ag",
            "defaultBidMicros": 1_500_000,
            "responsiveSearchAd": {
                "headlines": [{"text": f"H{i}"} for i in range(15)],
                "descriptions": [{"text": f"D{i}"} for i in range(4)],
                "finalUrl": rsa_url,
            },
            "keywords": [{"text": "kw", "matchType": "PHRASE"}],
        }],
    })


def test_final_urls_dedupes_rsa_and_sitelinks() -> None:
    same = "https://www.vonteva.com/ideas/foo"
    assert final_urls(_brief_for_urls(same, same)) == [same]


def test_final_urls_keeps_distinct() -> None:
    rsa = "https://www.vonteva.com/ideas/foo"
    sl = "https://www.vonteva.com/ideas/bar"
    assert set(final_urls(_brief_for_urls(rsa, sl))) == {rsa, sl}


def test_final_urls_orders_rsa_before_sitelinks() -> None:
    rsa = "https://www.vonteva.com/ideas/foo"
    sl = "https://www.vonteva.com/ideas/bar"
    # RSA finalUrl comes first, then the sitelink URL — order-preserving dedupe.
    assert final_urls(_brief_for_urls(rsa, sl)) == [rsa, sl]


def test_unreachable_urls_reports_each_failure(monkeypatch) -> None:
    rsa = "https://www.vonteva.com/ideas/foo"
    sl = "https://www.vonteva.com/ideas/bar"
    # Probe is stubbed — no network. Every URL "fails" so we exercise the
    # collect → probe → (url, reason) composition without touching the wire.
    monkeypatch.setattr(
        "ads_skill.ideas.urls.url_unreachable_reason",
        lambda url: "HTTP 404",
    )
    assert unreachable_urls(_brief_for_urls(rsa, sl)) == [
        (rsa, "HTTP 404"),
        (sl, "HTTP 404"),
    ]


def test_unreachable_urls_empty_when_all_reachable(monkeypatch) -> None:
    rsa = "https://www.vonteva.com/ideas/foo"
    sl = "https://www.vonteva.com/ideas/bar"
    monkeypatch.setattr(
        "ads_skill.ideas.urls.url_unreachable_reason",
        lambda url: None,
    )
    assert unreachable_urls(_brief_for_urls(rsa, sl)) == []


def test_url_unreachable_reason_returns_exception_name(monkeypatch) -> None:
    # No network: force urlopen to raise so we exercise the catch-all branch
    # that returns the exception class name (DNS/timeout/TLS family).
    def _boom(*args, **kwargs):
        raise OSError("nope")

    monkeypatch.setattr("ads_skill.ideas.urls.urllib.request.urlopen", _boom)
    assert url_unreachable_reason("https://example.invalid/x") == "OSError"
