"""Shell-level tests for audit.py — the IO entry point.

The pure scoring/detection logic now lives in ads_skill.audit.scoring and is
exercised by scoring_test.py. These tests cover the shell: that it re-exports
the pure helpers it depends on, and that arg validation runs before any SDK call.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from ads_skill.bin import audit


def test_shell_reexports_pure_helpers_from_scoring() -> None:
    # bin/audit.py imports these from ads_skill.audit.scoring; they must resolve.
    from ads_skill.audit import scoring

    assert audit._require_digits is scoring._require_digits
    assert audit._cannibalization is scoring._cannibalization
    assert audit._path_to_excellent is scoring._path_to_excellent
    assert audit.MIN_HEADLINES == scoring.MIN_HEADLINES


def test_require_digits_guard_runs_in_shell() -> None:
    # injection guard is wired through the shell (no SDK needed to reach it).
    with pytest.raises(SystemExit):
        audit._require_digits("campaign", "1; DROP TABLE")


def test_shell_reexports_differentiation_helper() -> None:
    # US5 finding: bin/audit.py wires this pure helper from audit.scoring.
    from ads_skill.audit import scoring

    assert audit._differentiation_gaps is scoring._differentiation_gaps


class _FakeCampaign:
    def __init__(self) -> None:
        self.campaign = SimpleNamespace(id=1, name="x", status=SimpleNamespace(name="ENABLED"))


def test_audit_campaign_is_read_only_and_flags_me_too_copy() -> None:
    """audit_campaign issues only `search` calls (no mutate_*) and flags a per-ad
    undifferentiated me-too copy finding (FR-014/FR-015)."""
    from types import SimpleNamespace as NS

    # one ad group, one ad whose copy is a generic AI promise; no extensions.
    ad_row = NS(
        ad_group=NS(name="Commercial"),
        ad_group_ad=NS(
            ad=NS(id=10, final_urls=["https://x"],
                  responsive_search_ad=NS(
                      headlines=[NS(text="AI Writer", pinned_field=NS(name="UNSPECIFIED"))] ,
                      descriptions=[NS(text="Best AI chatbot", pinned_field=NS(name="UNSPECIFIED"))])),
            ad_strength=NS(name="GOOD"), status=NS(name="ENABLED"), action_items=[]),
    )

    class _ReadOnlyClient:
        def __init__(self) -> None:
            self.searches = 0

        def get_service(self, _name: str):
            client = self

            class _Svc:
                def search(self, *, customer_id: str, query: str):
                    client.searches += 1
                    # ad-group-ad query returns our single ad; ext-count queries return nothing
                    return [ad_row] if "FROM ad_group_ad" in query else []

                def __getattr__(self, name: str):
                    if name.startswith("mutate"):
                        raise AssertionError("audit must be read-only — no mutate calls")
                    raise AttributeError(name)

            return _Svc()

    client = _ReadOnlyClient()
    camp = _FakeCampaign()
    result = audit.audit_campaign(client, "123", camp, banned=[],
                                  ag_keywords={"Commercial": ["ai chatbot"]})
    # the ad itself is flagged as undifferentiated me-too copy
    assert any(i["issue"] == "undifferentiated_copy" for a in result["ads"] for i in a["issues"])
    # full asset TEXT is surfaced (not just counts) so /ads:update can preserve good copy
    ad = result["ads"][0]
    assert ad["headlines"] == ["AI Writer"]
    assert ad["descriptions"] == ["Best AI chatbot"]


def _client_with_campaigns(rows: list) -> object:
    class _C:
        def get_service(self, _n: str):
            class _Svc:
                def search(self, *, customer_id: str, query: str):
                    return rows
            return _Svc()
    return _C()


def test_resolve_campaign_matches_name_substring_to_id() -> None:
    """--campaign given as a name substring resolves to the single matching id,
    case-insensitively, with the needle never touching GAQL."""
    from types import SimpleNamespace as NS

    rows = [
        NS(campaign=NS(id=10, name="tonewell-social-proof-20260624-abee-search")),
        NS(campaign=NS(id=20, name="pitchvoice-social-proof-20260625-7a21-search")),
    ]
    cid, err = audit._resolve_campaign(_client_with_campaigns(rows), "123", "ABEE", only_enabled=True)
    assert (cid, err) == ("10", None)


def test_resolve_campaign_reports_no_match_and_ambiguous() -> None:
    from types import SimpleNamespace as NS

    rows = [
        NS(campaign=NS(id=10, name="tonewell-abee-search")),
        NS(campaign=NS(id=20, name="pitchvoice-7a21-search")),
    ]
    client = _client_with_campaigns(rows)

    cid, err = audit._resolve_campaign(client, "123", "nomatch", only_enabled=True)
    assert cid is None and "no campaign name matches" in err

    cid, err = audit._resolve_campaign(client, "123", "search", only_enabled=True)
    assert cid is None and "ambiguous" in err
