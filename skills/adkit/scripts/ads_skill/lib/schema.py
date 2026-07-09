"""Brief schema + executor Failure types. Pydantic v2; single source of truth.

Publishes are not persisted to disk — the live Google Ads account and Google's
change history are the record of what exists (see /adkit audit to read live state)."""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

AD_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
CUSTOMER_ID_PATTERN = re.compile(r"^[0-9]{10}$")
MAX_AD_GROUPS = 20


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# Pinning is disabled: it collapses Google's combinatorial asset testing and is
# the #1 silent ad-strength killer. `pin` stays in the schema (so historical
# records still load) but is locked to "NONE" — any attempt to pin is rejected.
class Headline(_Strict):
    text: Annotated[str, Field(min_length=1, max_length=30)]
    pin: Literal["NONE"] = "NONE"


class Description(_Strict):
    text: Annotated[str, Field(min_length=1, max_length=90)]
    pin: Literal["NONE"] = "NONE"


class Keyword(_Strict):
    text: Annotated[str, Field(min_length=1, max_length=80)]
    matchType: Literal["EXACT", "PHRASE", "BROAD"] = "PHRASE"


BidStrategy = Literal[
    "manual-cpc",
    "maximize-clicks",
    "maximize-conversions",
    "maximize-conversion-value",
    "target-cpa",
    "target-roas",
]


class Sitelink(_Strict):
    """Campaign-level sitelink asset. description1/description2 are both-or-neither
    per Google Ads (a sitelink with one description line is rejected)."""

    text: Annotated[str, Field(min_length=1, max_length=25)]
    finalUrl: HttpUrl
    description1: Annotated[str, Field(min_length=1, max_length=35)] | None = None
    description2: Annotated[str, Field(min_length=1, max_length=35)] | None = None

    @field_validator("finalUrl")
    @classmethod
    def _https_only(cls, v: HttpUrl) -> HttpUrl:
        if v.scheme != "https":
            raise ValueError("finalUrl must use https://")
        return v

    @model_validator(mode="after")
    def _descriptions_both_or_neither(self) -> "Sitelink":
        if (self.description1 is None) != (self.description2 is None):
            raise ValueError("sitelink needs both description1 and description2, or neither")
        return self


class PriceOffering(_Strict):
    header: Annotated[str, Field(min_length=1, max_length=25)]
    description: Annotated[str, Field(min_length=1, max_length=25)]
    priceMicros: Annotated[int, Field(gt=0)]
    finalUrl: HttpUrl

    @field_validator("finalUrl")
    @classmethod
    def _https_only(cls, v: HttpUrl) -> HttpUrl:
        if v.scheme != "https":
            raise ValueError("finalUrl must use https://")
        return v


class PriceAsset(_Strict):
    type: Literal["BRANDS", "EVENTS", "LOCATION", "NEIGHBORHOODS", "PRODUCT_CATEGORIES", "PRODUCT_TIERS", "SERVICE_CATEGORIES", "SERVICE_TIERS", "SERVICES"] = "SERVICES"
    languageCode: Annotated[str, Field(pattern=r"^[a-z]{2}$")] = "en"
    currencyCode: Annotated[str, Field(pattern=r"^[A-Z]{3}$")] = "USD"
    offerings: Annotated[list[PriceOffering], Field(min_length=3, max_length=8)]


class StructuredSnippetAsset(_Strict):
    header: Literal["AMENITIES", "BRANDS", "COURSES", "DEGREES", "DESTINATIONS", "FEATURED_HOTELS", "INSURANCE_COVERAGE", "MODELS", "NEIGHBORHOODS", "SERVICE_CATALOG", "SHOWS", "STYLES", "TYPES"] = "SERVICE_CATALOG"
    values: Annotated[list[Annotated[str, Field(min_length=1, max_length=25)]], Field(min_length=3, max_length=10)]

    @field_validator("values")
    @classmethod
    def _values_are_unique(cls, v: list[str]) -> list[str]:
        if len({value.casefold() for value in v}) != len(v):
            raise ValueError("structured snippet values must be unique")
        return v


class Campaign(_Strict):
    name: Annotated[str, Field(min_length=1)]
    budgetMicros: Annotated[int, Field(gt=0)]
    # "search-partners-display" serves on Google search + search partner sites.
    # (Despite the name, the Display Network is always disabled — see executor.py.)
    # "search-only" restricts to Google search results only.
    # Legacy briefs without the field default to the expanded networks.
    networkSettings: Literal["search-only", "search-partners-display"] = "search-partners-display"
    # New campaigns launch on Maximize Clicks ("maximize-clicks") to escape the
    # Smart-Bidding cold start: a brand-new campaign on maximize-conversions with
    # no conversion history bids weakly and can starve to ~0 impressions. Maximize
    # Clicks buys traffic to seed conversion data; switch to maximize-conversions
    # (in the UI) after ~15-30 conversions in 30 days. Set bidStrategy explicitly
    # to launch straight on Smart Bidding when conversion volume is assured.
    bidStrategy: BidStrategy = "maximize-clicks"
    # Optional max CPC ceiling (micros) for maximize-clicks — caps what the warm-up
    # pays per click so it can't overpay for junk. Ignored by other strategies.
    cpcBidCeilingMicros: Annotated[int, Field(gt=0)] | None = None
    # AI Max for Search: broad-match expansion + Google-AI asset/landing-page
    # matching. On by default (Google's recommended posture); set false to keep
    # the campaign strictly keyword-matched. Legacy briefs without the field
    # inherit the default-on.
    aiMax: bool = True
    # Device targeting. None (field omitted) => default brief: mobile excluded
    # at -100% (computer/tablet/tv serve). A subset keeps those devices and
    # excludes the rest via a -100% bid modifier; list every device to serve
    # everywhere. Legacy briefs without the field => mobile excluded.
    devices: list[Literal["computer", "mobile", "tablet", "tv"]] | None = None
    # Campaign-level negative keywords — shared across all ad groups. Critical
    # for STAGs + AI Max: they block close-variant / broad-match expansion onto
    # off-theme queries (the `#### Dropped (off-topic)` terms from ads:gtm).
    negativeKeywords: list[Keyword] = Field(default_factory=list)
    targetCpaMicros: Annotated[int, Field(gt=0)] | None = None
    targetRoas: Annotated[float, Field(gt=0)] | None = None
    # Every campaign requires six sitelinks for complete Search ad coverage.
    sitelinks: Annotated[list[Sitelink], Field(max_length=6)] = Field(default_factory=list)
    # Callout assets (campaign-level): short phrases shown under the ad, e.g.
    # "No new integrations". At least 4, or none (legacy briefs predate the
    # field). Scaffolds emit 4. Each ≤25 chars per Google Ads.
    callouts: Annotated[list[Annotated[str, Field(min_length=1, max_length=25)]], Field(max_length=20)] = Field(default_factory=list)
    # One optional campaign-level PriceAsset with 3–8 price offerings.
    priceAsset: PriceAsset | None = None
    # One optional campaign-level StructuredSnippetAsset for category/value context.
    structuredSnippet: StructuredSnippetAsset | None = None

    @field_validator("sitelinks")
    @classmethod
    def _sitelink_count(cls, v: list[Sitelink]) -> list[Sitelink]:
        if v and len(v) != 6:
            raise ValueError("provide exactly 6 sitelinks")
        return v

    @field_validator("callouts")
    @classmethod
    def _callout_count(cls, v: list[str]) -> list[str]:
        if v and len(v) < 4:
            raise ValueError("provide at least 4 callouts (max 20), or none")
        return v

    @field_validator("devices")
    @classmethod
    def _devices_nonempty_unique(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        if not v:
            raise ValueError("devices: omit the field for all-device targeting; an empty list would exclude every device")
        if len(set(v)) != len(v):
            raise ValueError("devices: no duplicates")
        return v

    @model_validator(mode="after")
    def _bid_strategy_consistency(self) -> "Campaign":
        s = self.bidStrategy
        if self.targetCpaMicros is not None and s != "target-cpa":
            raise ValueError(f"targetCpaMicros only valid when bidStrategy='target-cpa' (got {s!r})")
        if self.targetRoas is not None and s != "target-roas":
            raise ValueError(f"targetRoas only valid when bidStrategy='target-roas' (got {s!r})")
        if s == "target-cpa" and self.targetCpaMicros is None:
            raise ValueError("bidStrategy='target-cpa' requires targetCpaMicros")
        if s == "target-roas" and self.targetRoas is None:
            raise ValueError("bidStrategy='target-roas' requires targetRoas")
        if self.cpcBidCeilingMicros is not None and s != "maximize-clicks":
            raise ValueError(f"cpcBidCeilingMicros only valid when bidStrategy='maximize-clicks' (got {s!r})")
        return self


class ResponsiveSearchAd(_Strict):
    # Full RSA asset sets are mandatory: Google can only optimize combinations
    # when all available headline and description slots are populated.
    headlines: Annotated[list[Headline], Field(min_length=15, max_length=15)]
    descriptions: Annotated[list[Description], Field(min_length=4, max_length=4)]
    finalUrl: HttpUrl
    # Display-URL "pretty URL" paths. Google derives the shown domain from the
    # finalUrl host and appends these two keyword-rich segments — e.g.
    # finalUrl https://www.example.com/ideas/tonewell-...?utm=... + path1
    # "review-replies" path2 "free-trial" displays as
    # www.example.com/review-replies/free-trial while the click still lands on
    # the long finalUrl. Each ≤15 chars, no spaces or "/"; path2 requires path1.
    # Always lower-cased (coerced in the validator below).
    path1: Annotated[str, Field(max_length=15)] | None = None
    path2: Annotated[str, Field(max_length=15)] | None = None

    @model_validator(mode="after")
    def _assets_are_unique(self) -> "ResponsiveSearchAd":
        headline_text = [headline.text.casefold() for headline in self.headlines]
        description_text = [description.text.casefold() for description in self.descriptions]
        if len(set(headline_text)) != len(headline_text):
            raise ValueError("RSA headlines must be unique")
        if len(set(description_text)) != len(description_text):
            raise ValueError("RSA descriptions must be unique")
        return self

    @field_validator("path1", "path2")
    @classmethod
    def _lowercase_display_path(cls, v: str | None) -> str | None:
        # Display paths read best lowercase; coerce to a deterministic,
        # case-insensitive value regardless of how the model wrote it. Runs
        # during construction (the model is frozen, so we can't mutate later).
        return v.lower() if v is not None else v

    @model_validator(mode="after")
    def _display_paths_valid(self) -> "ResponsiveSearchAd":
        for name, value in (("path1", self.path1), ("path2", self.path2)):
            if value is None:
                continue
            if value.strip() == "":
                raise ValueError(f"{name} must be non-empty when provided (omit it instead)")
            if any(ch.isspace() for ch in value) or "/" in value:
                raise ValueError(f"{name} may not contain spaces or '/' (got {value!r})")
            if "todo" in value.casefold():
                raise ValueError(f"{name} still holds a scaffold placeholder ({value!r}); fill it or omit it")
        if self.path2 is not None and self.path1 is None:
            raise ValueError("path2 requires path1 (Google fills the display path in order)")
        return self

    @field_validator("finalUrl")
    @classmethod
    def _https_only(cls, v: HttpUrl) -> HttpUrl:
        if v.scheme != "https":
            raise ValueError("finalUrl must use https://")
        return v


class AdGroup(_Strict):
    name: Annotated[str, Field(min_length=1)]
    # max $15.00 CPC — guards against a fat-fingered micros value draining budget.
    defaultBidMicros: Annotated[int, Field(gt=0, le=15_000_000)]
    responsiveSearchAd: ResponsiveSearchAd
    keywords: Annotated[list[Keyword], Field(min_length=1, max_length=20)]


class Brief(_Strict):
    name: str
    version: Annotated[int, Field(ge=1)]
    customerId: str | None = None
    campaign: Campaign
    adGroups: Annotated[list[AdGroup], Field(min_length=1, max_length=MAX_AD_GROUPS)]

    @field_validator("name")
    @classmethod
    def _name_kebab(cls, v: str) -> str:
        if not AD_NAME_PATTERN.match(v):
            raise ValueError("must be kebab-case, 2–64 chars, starting with a letter")
        return v

    @field_validator("customerId")
    @classmethod
    def _customer_id_shape(cls, v: str | None) -> str | None:
        if v is not None and not CUSTOMER_ID_PATTERN.match(v):
            raise ValueError("must be 10 digits")
        return v

    @field_validator("adGroups")
    @classmethod
    def _ad_group_names_unique(cls, v: list[AdGroup]) -> list[AdGroup]:
        names = [ag.name for ag in v]
        if len(set(names)) != len(names):
            raise ValueError("adGroups[].name must be unique within a brief")
        return v


# ---- fixes-plan models (apply path; see bin/apply_fixes.py) ----
# The rest of a fixes plan is validated functionally in fixes/plan.py (it returns a
# list of human-readable error strings), but the campaign on/off block gets a strict
# model so the digits-only campaignId and the ENABLED/PAUSED enum are enforced once,
# here, alongside the other schema invariants.
class CampaignStatusChange(_Strict):
    """One campaign serving-status flip in a fixes plan. PAUSE is always safe; ENABLE
    starts live spend and is surfaced loudly by the apply path (never silent)."""

    # Plan JSON may carry the id as an int; coerce_numbers_to_str lets the digits-only
    # str pattern validate it (and downstream f-strings get a clean value).
    model_config = ConfigDict(coerce_numbers_to_str=True)

    campaignId: Annotated[str, Field(pattern=r"^[0-9]+$")]
    status: Literal["ENABLED", "PAUSED"]


class AdGroupStatusChange(_Strict):
    """One ad-group serving-status flip in a fixes plan. PAUSE is always safe (it stops
    that ad group's keywords from serving); ENABLE resumes live spend on them and is
    surfaced loudly by the apply path (never silent). Mirrors CampaignStatusChange one
    level down — pause a whole dead-weight ad group without touching its keywords."""

    # Plan JSON may carry the id as an int; coerce_numbers_to_str lets the digits-only
    # str pattern validate it (and downstream f-strings get a clean value).
    model_config = ConfigDict(coerce_numbers_to_str=True)

    adGroupId: Annotated[str, Field(pattern=r"^[0-9]+$")]
    status: Literal["ENABLED", "PAUSED"]


FailureStep = Literal[
    "validate-brief",
    "preflight",
    "archive-existing-campaign",
    "find-existing-campaign",
    "find-existing-ad-group",
    "create-campaign-budget",
    "create-search-campaign",
    "target-location",
    "target-devices",
    "create-negative-keywords",
    "create-sitelinks",
    "create-callouts",
    "create-price-asset",
    "create-structured-snippet",
    "create-ad-group",
    "create-responsive-search-ad",
    "create-keywords",
]


class Failure(_Strict):
    step: FailureStep
    message: str
    adGroupName: str | None = None
    raw: object | None = None
