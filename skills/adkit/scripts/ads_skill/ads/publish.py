"""The one public publish path: `publish_v1` (budget + campaign + N ad groups,
each with RSA + keywords; reuses an existing campaign of the same name). It
catches SDK errors at step granularity (via `_step`) and returns a RunOutcome
recording partial successes and the failing step. Revisions to live ads go
through ads.sh apply-fixes, not here.

Entity construction lives in entities.py; the step-error machinery in errors.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .entities import (
    _archive_campaigns_by_name,
    _create_ad_group,
    _create_callouts,
    _create_campaign_budget,
    _create_keywords,
    _create_negative_keywords,
    _create_price_asset,
    _create_responsive_search_ad,
    _create_search_campaign,
    _create_sitelinks,
    _create_structured_snippet,
    _find_existing_ad_group,
    _find_existing_campaign,
    _target_devices,
    _target_us_canada,
)
from .errors import _StepError, _sdk_version, _step
from ..lib.auth import load_client
from ..lib.schema import Brief, Failure


@dataclass
class ExecAdGroup:
    name: str
    adGroupId: str | None = None
    responsiveSearchAdId: str | None = None
    keywordResourceNames: tuple[str, ...] = ()


@dataclass
class ExecResults:
    """What publish_v1 created — returned to the caller for a run summary.
    Not persisted; the live account + Google change history are the record."""
    budgetId: str | None = None
    campaignId: str | None = None
    sitelinkResourceNames: tuple[str, ...] = ()
    calloutResourceNames: tuple[str, ...] = ()
    priceAssetResourceNames: tuple[str, ...] = ()
    structuredSnippetResourceNames: tuple[str, ...] = ()
    adGroups: list[ExecAdGroup] = field(default_factory=list)


@dataclass
class RunOutcome:
    results: ExecResults
    failure: Failure | None = None
    executor_version: str = "unknown"


# ---------- Public API ----------


def publish_v1(customer_id: str, brief: Brief, archive_existing: bool = False) -> RunOutcome:
    sdk_version = _sdk_version()
    results = ExecResults(adGroups=[ExecAdGroup(name=ag.name) for ag in brief.adGroups])
    try:
        client = load_client()
        if archive_existing:
            _step(
                "archive-existing-campaign",
                lambda: _archive_campaigns_by_name(client, customer_id, brief.campaign.name),
            )
        existing_campaign = None if archive_existing else _step(
            "find-existing-campaign",
            lambda: _find_existing_campaign(client, customer_id, brief),
        )
        if existing_campaign:
            results.campaignId, results.budgetId = existing_campaign
        else:
            results.budgetId = _step(
                "create-campaign-budget",
                lambda: _create_campaign_budget(client, customer_id, brief),
            )
            results.campaignId = _step(
                "create-search-campaign",
                lambda: _create_search_campaign(client, customer_id, brief, results.budgetId),
            )
            _step(
                "target-location",
                lambda: _target_us_canada(client, customer_id, results.campaignId),
            )
            _step(
                "target-devices",
                lambda: _target_devices(client, customer_id, results.campaignId, brief.campaign.devices),
            )
            _step(
                "create-negative-keywords",
                lambda: _create_negative_keywords(
                    client,
                    customer_id,
                    results.campaignId,
                    brief.campaign.negativeKeywords,
                ),
            )
            results.sitelinkResourceNames = tuple(
                _step(
                    "create-sitelinks",
                    lambda: _create_sitelinks(client, customer_id, brief, results.campaignId),
                )
            )
            results.calloutResourceNames = tuple(
                _step(
                    "create-callouts",
                    lambda: _create_callouts(client, customer_id, brief, results.campaignId),
                )
            )
            results.priceAssetResourceNames = tuple(
                _step(
                    "create-price-asset",
                    lambda: _create_price_asset(client, customer_id, brief, results.campaignId),
                )
            )
            results.structuredSnippetResourceNames = tuple(
                _step(
                    "create-structured-snippet",
                    lambda: _create_structured_snippet(client, customer_id, brief, results.campaignId),
                )
            )
        for idx, brief_ag in enumerate(brief.adGroups):
            slot = results.adGroups[idx]
            existing_ad_group = _step(
                "find-existing-ad-group",
                lambda b=brief_ag: _find_existing_ad_group(client, customer_id, b, results.campaignId),
                ad_group_name=brief_ag.name,
            )
            if existing_ad_group:
                slot.adGroupId = existing_ad_group
                should_create_keywords = False
            else:
                slot.adGroupId = _step(
                    "create-ad-group",
                    lambda b=brief_ag: _create_ad_group(client, customer_id, b, results.campaignId),
                    ad_group_name=brief_ag.name,
                )
                should_create_keywords = True
            slot.responsiveSearchAdId = _step(
                "create-responsive-search-ad",
                lambda b=brief_ag, rn=slot.adGroupId: _create_responsive_search_ad(
                    client, customer_id, b, rn
                ),
                ad_group_name=brief_ag.name,
            )
            if should_create_keywords:
                slot.keywordResourceNames = tuple(
                    _step(
                        "create-keywords",
                        lambda b=brief_ag, rn=slot.adGroupId: _create_keywords(
                            client, customer_id, b, rn
                        ),
                        ad_group_name=brief_ag.name,
                    )
                )
    except _StepError as exc:
        return RunOutcome(
            results,
            Failure(step=exc.step, message=exc.message, raw=exc.raw, adGroupName=exc.ad_group_name),
            sdk_version,
        )
    return RunOutcome(results, None, sdk_version)
