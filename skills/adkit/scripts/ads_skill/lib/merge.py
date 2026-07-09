"""Pure helpers: candidate union/dedup, tier sort+cap.

No SDK imports. Inputs may be SDK rows mapped to ApiIdea; outputs are frozen Candidates."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal

MAX_KEYWORD_CHARS = 80
MIN_VOLUME = 1_000  # Keyword Planner avg monthly searches floor for inclusion


@dataclass(frozen=True)
class ApiIdea:
    phrase: str
    volume: int
    competition: str
    low_micros: int | None
    high_micros: int | None


@dataclass(frozen=True)
class Candidate:
    phrase: str
    source: Literal["llm", "api", "both"]
    volume: int | None = None
    competition: str | None = None
    low_micros: int | None = None
    high_micros: int | None = None


def comparison_key(s: str) -> str:
    return " ".join(s.casefold().split())


def _from_idea(phrase: str, idea: ApiIdea, source: Literal["api", "both"]) -> Candidate:
    return Candidate(phrase=phrase, source=source, volume=idea.volume,
                     competition=idea.competition, low_micros=idea.low_micros,
                     high_micros=idea.high_micros)


def union_candidates(llm: Iterable[str], api: Iterable[ApiIdea]) -> tuple[Candidate, ...]:
    api_kept = [i for i in api if i.volume >= MIN_VOLUME and len(i.phrase) <= MAX_KEYWORD_CHARS]
    api_by_key = {comparison_key(i.phrase): i for i in api_kept}
    llm_clean = [p for p in llm if p.strip() and len(p) <= MAX_KEYWORD_CHARS]
    llm_keys = {comparison_key(p) for p in llm_clean}
    # LLM seeds survive only when the Keyword Planner backs them with data;
    # bare (undecorated) seeds are dropped.
    matched = [_from_idea(p, api_by_key[k], "both") for p in llm_clean
               if (k := comparison_key(p)) in api_by_key]
    api_only = [_from_idea(i.phrase, i, "api") for i in api_kept if comparison_key(i.phrase) not in llm_keys]
    return tuple(matched + api_only)
