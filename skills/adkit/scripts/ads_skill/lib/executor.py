"""Historical import path for the google-ads-python executor.

The executor was split into the `ads_skill.ads` package (errors / entities /
publish); this module preserves `ads_skill.lib.executor` as the public import
surface so existing callers and tests keep working unchanged. Every name they
import is re-exported here — nothing else lives in this file.

All Google Ads SDK imports remain deferred inside the underlying functions, so
importing this module never requires google-ads to be installed.
"""

from __future__ import annotations

from ..ads.entities import (
    _ALL_DEVICES,
    _GEO_TARGETS,
    _SNIPPET_HEADERS,
    _apply_bid_strategy,
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
    _make_text_assets,
    _target_devices,
    _target_us_canada,
    set_ad_group_status,
    set_campaign_status,
    build_keyword_ops,
    build_negative_keyword_ops,
)
from ..ads.errors import (
    _format_google_ads_error,
    _gaql_string,
    _sdk_version,
    _StepError,
    _step,
)
from ..ads.publish import ExecAdGroup, ExecResults, RunOutcome, publish_v1

__all__ = [
    # public API
    "ExecAdGroup",
    "ExecResults",
    "RunOutcome",
    "publish_v1",
    "build_negative_keyword_ops",
    "build_keyword_ops",
    "set_campaign_status",
    "set_ad_group_status",
    # cross-cutting helpers (historical names)
    "_sdk_version",
    "_gaql_string",
    "_StepError",
    "_step",
    "_format_google_ads_error",
    # entity builders + lookup tables imported by executor_test.py and friends
    "_apply_bid_strategy",
    "_archive_campaigns_by_name",
    "_create_ad_group",
    "_create_callouts",
    "_create_campaign_budget",
    "_create_keywords",
    "_create_negative_keywords",
    "_create_price_asset",
    "_create_responsive_search_ad",
    "_create_search_campaign",
    "_create_sitelinks",
    "_create_structured_snippet",
    "_find_existing_ad_group",
    "_find_existing_campaign",
    "_make_text_assets",
    "_target_devices",
    "_target_us_canada",
    "_GEO_TARGETS",
    "_ALL_DEVICES",
    "_SNIPPET_HEADERS",
]
