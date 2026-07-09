"""Final-URL collection + reachability for the /adkit create scaffold.

`final_urls(brief)` is pure (no network) — it just enumerates the brief's
destination URLs, so it is unit-testable without touching the wire. The actual
HEAD/GET probe lives in `url_unreachable_reason` (its natural home), and
`unreachable_urls` composes the two: collect, probe each, return failures.

No stdout, no sys.exit — bin/create.py formats and dies on the failure list."""

from __future__ import annotations

import urllib.error
import urllib.request

from ..lib.schema import Brief


def final_urls(brief: Brief) -> list[str]:
    """Every destination URL the brief publishes: one per RSA + one per sitelink.
    Deduped, order-preserving."""
    urls = [str(ag.responsiveSearchAd.finalUrl) for ag in brief.adGroups]
    urls += [str(sl.finalUrl) for sl in brief.campaign.sitelinks]
    return list(dict.fromkeys(urls))


def url_unreachable_reason(url: str) -> str | None:
    """None if the URL resolves (status < 400, redirects followed); else a short reason.
    HEAD first, fall back to GET when the host rejects HEAD."""
    for method in ("HEAD", "GET"):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": "ads-skill-urlcheck"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return None if resp.status < 400 else f"HTTP {resp.status}"
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 405) and method == "HEAD":
                continue  # some servers reject HEAD — retry with GET
            return f"HTTP {exc.code}"
        except Exception as exc:  # noqa: BLE001 — DNS, timeout, TLS, etc.
            return type(exc).__name__
    return None


def unreachable_urls(brief: Brief) -> list[tuple[str, str]]:
    """The brief's destination URLs that don't resolve, as (url, reason) pairs.
    Empty when every URL is reachable. Catches the classic /ideas/ prefix slip
    and leftover TODO slugs before any Google Ads mutation runs."""
    return [
        (url, reason)
        for url in final_urls(brief)
        if (reason := url_unreachable_reason(url)) is not None
    ]
