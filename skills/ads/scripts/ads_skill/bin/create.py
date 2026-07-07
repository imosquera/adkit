"""Scaffold brief from a processed idea → validate → publish to Google Ads.

Publishes are not persisted to disk: the live account + Google's change history
are the record (read live state with /ads:audit; revise live ads with
ads.sh apply-fixes). The scaffolded brief is a throwaway in the system temp dir.

Run: ads.sh create <idea-slug|brief-path.yaml> [--dry-run] [--top-n N]
"""

from __future__ import annotations

import dataclasses
import os
import re
import sys
import tempfile

import yaml
from pathlib import Path

from pydantic import ValidationError

from ..cli.args import resolve_customer
from ..cli.output import emit_json
from ..ideas.parse import (
    DEFAULT_TOP_N,
    MAX_KEYWORDS_PER_THEME,
    _extract_negatives,
    _read_theme_groups,
    _slug_from_processed_path,
)
from ..ideas.urls import unreachable_urls
from ..lib.executor import publish_v1
from ..lib.schema import Brief

REPO_ROOT = Path.cwd()
# Scaffolded briefs are throwaway (not committed). Stable temp path so re-running
# the same idea slug finds the brief you filled in on the first pass.
BRIEF_TMP_DIR = Path(tempfile.gettempdir()) / "ads-briefs"


# ---------- io helpers ----------


def _die(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"error: {msg}\n")
    raise SystemExit(code)


# ---------- brief discovery ----------


def _scaffold_brief_from_processed(md_path: Path, brief_path: Path, max_per_theme: int) -> None:
    if not md_path.exists():
        _die(f"no brief at {brief_path} and processed idea not found at {md_path}")
    md = md_path.read_text()
    slug = _slug_from_processed_path(str(md_path))
    name = slug if len(slug) <= 64 else re.sub(r"-+$", "", slug[:64])
    themes = _read_theme_groups(md, max_per_theme)
    negatives = _extract_negatives(md)
    if not themes:
        _die(
            f'{md_path} has no "## Go To Market > ### Keywords" section with tier '
            f"bullets. Run /ads:gtm {md_path} first."
        )
    ad_groups = [
        {
            "name": tier,  # STAG: ad group IS the intent theme
            "defaultBidMicros": 1_500_000,
            "responsiveSearchAd": {
                "headlines": [
                    {"text": f"TODO headline {i} (≤30 chars)"} for i in range(1, 16)
                ],
                "descriptions": [
                    {"text": f"TODO description {i} (≤90 chars, end with CTA)"} for i in range(1, 5)
                ],
                # Landing pages publish under /ideas/<published-slug> (clean URL, no .html).
                # The published slug is the timestamped name from `Idea HTML`, not this
                # processed-file slug — fill it in. The pre-publish URL check rejects a
                # leftover TODO because it 404s.
                "finalUrl": "https://www.example.com/ideas/TODO-published-slug",
                # Display-URL "pretty URL" paths (optional): the shown URL is the
                # finalUrl host + these two keyword-rich segments — e.g.
                # www.example.com/review-replies/free-trial — while the click still
                # lands on the long finalUrl. Each ≤15 chars, no spaces or "/",
                # always lower case (mixed case is coerced down at validation).
                # Fill with this theme's keyword, or DELETE both lines to omit.
                # A leftover TODO is rejected at validation.
                "path1": "todo-keyword",
                "path2": "todo-or-omit",
            },
            # All theme keywords as PHRASE — close-variant matching + AI Max cover
            # plurals/typos/synonyms, so the SKAG-era PHRASE+EXACT pair is redundant.
            "keywords": [{"text": kw, "matchType": "PHRASE"} for kw in kws],
        }
        for tier, kws in themes
    ]
    skeleton = {
        "name": name,
        "version": 1,
        "campaign": {
            "name": f"{name}-search",
            "budgetMicros": 25_000_000,  # $25.00/day
            "networkSettings": "search-partners-display",  # Google search + search partners (Display Network always off); "search-only" to restrict
            "bidStrategy": "maximize-clicks",  # cold-start warm-up; graduate to maximize-conversions in UI after ~15-30 conv/30d
            # "cpcBidCeilingMicros": 2_000_000,  # optional $2.00 max CPC cap for the maximize-clicks warm-up
            "aiMax": True,  # AI Max for Search on; set False for strict keyword matching
            # "devices": ["computer", "tablet", "tv"],  # omit = default (mobile -100%); list all to serve everywhere

            # Campaign-level negative keywords, auto-seeded from the processed
            # file's "#### Negative Keywords" section (empty if none). Shared
            # across every theme — block off-theme close-variant / AI Max traffic.
            "negativeKeywords": negatives,
            # Exactly 6 sitelinks (link_text ≤25 chars). finalUrl under /ideas/<slug> (clean URL).
            "sitelinks": [
                {"text": f"TODO sitelink {i} (≤25)", "finalUrl": "https://www.example.com/ideas/TODO-published-slug"}
                for i in range(1, 7)
            ],
            # At least 4 callouts (≤25 chars each), short benefit phrases shown
            # under the ad, e.g. "No new integrations" / "Live in 30 days".
            "callouts": [f"TODO callout {i} (≤25)" for i in range(1, 5)],
            "priceAsset": {
                "type": "SERVICES",
                "languageCode": "en",
                "currencyCode": "USD",
                "offerings": [
                    {"header": f"TODO price {i}", "description": "TODO benefit", "priceMicros": 1_000_000, "finalUrl": "https://www.example.com/ideas/TODO-published-slug"}
                    for i in range(1, 4)
                ],
            },
            "structuredSnippet": {
                "header": "SERVICE_CATALOG",
                "values": ["TODO service 1", "TODO service 2", "TODO service 3"],
            },
        },
        "adGroups": ad_groups,
    }
    brief_path.parent.mkdir(parents=True, exist_ok=True)
    brief_path.write_text(yaml.safe_dump(skeleton, sort_keys=False))
    themes_pretty = "\n  - ".join(f"{tier} ({len(kws)} kw)" for tier, kws in themes)
    sys.stderr.write(
        f"scaffolded {brief_path} from {md_path}\n"
        f"{len(themes)} STAG ad groups (one per intent theme):\n  - {themes_pretty}\n"
        f"{len(negatives)} campaign negative keywords seeded from the processed file\n"
        "6 sitelink + 4 callout + 3 price-offering + structured-snippet placeholders added (fill these in too)\n"
        "fill in headlines/descriptions/finalUrl per ad group, then re-run\n"
    )
    raise SystemExit(2)


def _resolve_brief_path(input_: str, top_n: int) -> Path:
    if input_.endswith((".yaml", ".yml")):
        return Path(input_)
    # Path-like (contains '/' or leading '.') → take as-is; bare basename → join under ideas/processed/.
    is_path_like = "/" in input_ or input_.startswith(".")
    if is_path_like:
        md_path = Path(input_)
    else:
        leaf = input_ if input_.endswith((".md", ".markdown")) else f"{input_}.md"
        md_path = REPO_ROOT / "ideas" / "processed" / leaf
    slug = _slug_from_processed_path(str(md_path))
    brief_path = BRIEF_TMP_DIR / f"{slug}.yaml"
    if brief_path.exists():
        return brief_path
    _scaffold_brief_from_processed(md_path, brief_path, top_n)
    raise RuntimeError("unreachable")  # pragma: no cover


# ---------- core orchestration ----------


def _read_brief(path: Path) -> Brief:
    if not path.exists():
        _die(f"brief not found: {path}")
    try:
        return Brief.model_validate(yaml.safe_load(path.read_text()))
    except ValidationError as exc:
        lines = [f"  - {'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()]
        _die("brief failed validation:\n" + "\n".join(lines))
        raise


def _assert_final_urls_reachable(brief: Brief) -> None:
    """Fail before any Google Ads mutation if a destination URL 404s (or is otherwise
    unreachable). Catches the classic /ideas/ prefix slip and leftover TODO slugs."""
    failures = unreachable_urls(brief)
    if failures:
        lines = [f"  - {url} → {reason}" for url, reason in failures]
        _die(
            "final URL check failed — these destinations don't resolve (fix the brief, "
            "or pass --skip-url-check to bypass):\n" + "\n".join(lines)
        )


def _customer_id_for(brief: Brief) -> str:
    chosen = resolve_customer(brief.customerId, os.environ.get("GOOGLE_ADS_CUSTOMER_ID"))
    if not chosen:
        _die("no customerId in brief, GOOGLE_ADS_CUSTOMER_ID env, or login_customer_id in google-ads.yaml")
    return chosen


def _parse_top_n(argv: list[str]) -> int:
    for i, a in enumerate(argv):
        if a == "--top-n" and i + 1 < len(argv):
            try:
                v = int(argv[i + 1])
            except ValueError:
                _die(f"--top-n: expected integer, got {argv[i + 1]!r}")
            if not 1 <= v <= MAX_KEYWORDS_PER_THEME:
                _die(f"--top-n: must be between 1 and {MAX_KEYWORDS_PER_THEME} (keywords per theme), got {v}")
            return v
    return DEFAULT_TOP_N


def main() -> int:
    positionals = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not positionals:
        _die("usage: ads.sh create <idea-slug|brief.yaml> [--dry-run] [--top-n N]")

    dry_run = "--dry-run" in sys.argv
    archive_existing = "--archive-existing" in sys.argv
    skip_url_check = "--skip-url-check" in sys.argv
    top_n = _parse_top_n(sys.argv[1:])

    brief_path = _resolve_brief_path(positionals[0], top_n)
    brief = _read_brief(brief_path)

    if not skip_url_check:
        _assert_final_urls_reachable(brief)

    customer_id = _customer_id_for(brief)
    ag_names = [ag.name for ag in brief.adGroups]

    if dry_run:
        emit_json(
            {
                "ok": True,
                "dryRun": True,
                "customerIdUsed": customer_id,
                "adGroupCount": len(brief.adGroups),
                "adGroups": ag_names,
                "sitelinkCount": len(brief.campaign.sitelinks),
                "calloutCount": len(brief.campaign.callouts),
                "willPublish": (
                    f"budget → campaign(PAUSED) → {len(brief.campaign.sitelinks)} sitelinks → "
                    f"{len(brief.campaign.callouts)} callouts → {len(ag_names)}x "
                    f"(ad-group → RSA(PAUSED) → keywords). Existing campaign of the same name is reused."
                ),
            }
        )
        return 0

    outcome = publish_v1(customer_id, brief, archive_existing=archive_existing)

    emit_json(
        {
            "ok": outcome.failure is None,
            "status": "success" if outcome.failure is None else "failed",
            "customerIdUsed": customer_id,
            "created": dataclasses.asdict(outcome.results),
            "failure": outcome.failure.model_dump() if outcome.failure else None,
            "note": "Campaign + RSAs created PAUSED. Not persisted locally — manage via the Ads UI / /ads:audit.",
        }
    )
    return 0 if outcome.failure is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
