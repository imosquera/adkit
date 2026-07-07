"""IO entry: GenerateKeywordIdeas → decorated JSON candidates on stdout.

Only module in this skill that imports google-ads SDK. Lazy import keeps pure
lib tests SDK-free, matching executor.py."""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from typing import Any

from ads_skill.cli.args import resolve_customer
from ads_skill.cli.output import sdk_error_message
from ads_skill.lib.auth import load_client
from ads_skill.lib.markdown import format_bullet_text
from ads_skill.lib.merge import ApiIdea, Candidate, union_candidates
from ads_skill.lib.metrics import competition_label

DEFAULT_GEO = "geoTargetConstants/2840"      # United States
DEFAULT_LANGUAGE = "languageConstants/1000"  # English
MAX_SEEDS = 20  # ponytail: Google Ads API hard limit on keyword_seed.keywords


def _build_request(client: Any, *, customer_id: str, seeds: tuple[str, ...],
                   page_url: str | None, geo: str, language: str) -> Any:
    req = client.get_type("GenerateKeywordIdeasRequest")
    req.customer_id = customer_id
    req.language = language
    req.geo_target_constants.append(geo)
    req.include_adult_keywords = False
    if page_url and seeds:
        req.keyword_and_url_seed.url = page_url
        req.keyword_and_url_seed.keywords.extend(seeds)
    elif page_url:
        req.url_seed.url = page_url
    else:
        req.keyword_seed.keywords.extend(seeds)
    return req


def _row_to_api_idea(row: Any) -> ApiIdea:
    metrics = row.keyword_idea_metrics
    return ApiIdea(
        phrase=row.text,
        volume=int(metrics.avg_monthly_searches or 0),
        competition=competition_label(metrics.competition),
        low_micros=int(metrics.low_top_of_page_bid_micros) or None,
        high_micros=int(metrics.high_top_of_page_bid_micros) or None,
    )


def _candidate_to_dict(c: Candidate) -> dict[str, Any]:
    return {**dataclasses.asdict(c), "bullet_text": format_bullet_text(c)}


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="keyword-ideas")
    p.add_argument("--customer-id", default=os.environ.get("GOOGLE_ADS_CUSTOMER_ID"))
    p.add_argument("--geo", default=DEFAULT_GEO)
    p.add_argument("--language", default=DEFAULT_LANGUAGE)
    p.add_argument("--seed", action="append", default=[])
    p.add_argument("--page-url", default=None)
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(sys.argv[1:] if argv is None else argv))
    customer_id = resolve_customer(args.customer_id)
    if not customer_id:
        print("error: --customer-id, GOOGLE_ADS_CUSTOMER_ID, or login_customer_id in google-ads.yaml required", file=sys.stderr)
        return 2
    seeds = tuple(s for s in args.seed if s.strip())
    if not seeds and not args.page_url:
        print("error: at least one --seed or --page-url required", file=sys.stderr)
        return 2
    if len(seeds) > MAX_SEEDS:
        print(f"warning: {len(seeds)} seeds provided; truncating to first {MAX_SEEDS} (Google Ads API limit)", file=sys.stderr)
        seeds = seeds[:MAX_SEEDS]

    try:
        client = load_client()
        service = client.get_service("KeywordPlanIdeaService")
        request = _build_request(
            client,
            customer_id=customer_id,
            seeds=seeds,
            page_url=args.page_url,
            geo=args.geo,
            language=args.language,
        )
        response = service.generate_keyword_ideas(request=request)
        api_ideas = tuple(_row_to_api_idea(row) for row in response)
    except Exception as exc:  # noqa: BLE001
        print(f"google-ads error: {sdk_error_message(exc)}", file=sys.stderr)
        return 1

    if not args.page_url:
        print("no URL found in idea; using keyword seed only", file=sys.stderr)

    candidates = union_candidates(llm=seeds, api=api_ideas)
    print(json.dumps([_candidate_to_dict(c) for c in candidates], indent=2))
    if not api_ideas:
        print("API returned zero ideas; using LLM seeds only", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
