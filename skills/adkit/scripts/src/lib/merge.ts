/**
 * Pure helpers: candidate union/dedup, tier sort+cap.
 *
 * No SDK imports. Inputs may be SDK rows mapped to ApiIdea; outputs are frozen Candidates.
 */

export const MAX_KEYWORD_CHARS = 80;
/** Keyword Planner avg monthly searches floor for inclusion. */
export const MIN_VOLUME = 1_000;

/** A Keyword Planner idea row. (Python `@dataclass(frozen=True)` ApiIdea.) */
export interface ApiIdea {
  readonly phrase: string;
  readonly volume: number;
  readonly competition: string;
  readonly lowMicros: number | null;
  readonly highMicros: number | null;
}

/**
 * A merged keyword candidate. (Python `@dataclass(frozen=True)` Candidate.)
 *
 * `source` mirrors Python's `Literal["llm", "api", "both"]`.
 */
export interface Candidate {
  readonly phrase: string;
  readonly source: "llm" | "api" | "both";
  readonly volume?: number | null;
  readonly competition?: string | null;
  readonly lowMicros?: number | null;
  readonly highMicros?: number | null;
}

/** Normalize a phrase for comparison: case-fold and collapse whitespace. */
export function comparisonKey(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** Build a Candidate from an ApiIdea, tagging it with the given source. */
function fromIdea(phrase: string, idea: ApiIdea, source: "api" | "both"): Candidate {
  return {
    phrase,
    source,
    volume: idea.volume,
    competition: idea.competition,
    lowMicros: idea.lowMicros,
    highMicros: idea.highMicros,
  };
}

/**
 * Union LLM seed phrases with Keyword Planner ideas into deduped Candidates.
 *
 * LLM seeds survive only when the Keyword Planner backs them with data; bare
 * (undecorated) seeds are dropped. API-only ideas below MIN_VOLUME or over
 * MAX_KEYWORD_CHARS are filtered out first.
 *
 * (Python `union_candidates`.)
 */
export function unionCandidates(llm: Iterable<string>, api: Iterable<ApiIdea>): readonly Candidate[] {
  const apiKept = [...api].filter((i) => i.volume >= MIN_VOLUME && i.phrase.length <= MAX_KEYWORD_CHARS);
  const apiByKey = new Map(apiKept.map((i) => [comparisonKey(i.phrase), i]));
  const llmClean = [...llm].filter((p) => p.trim() !== "" && p.length <= MAX_KEYWORD_CHARS);
  const llmKeys = new Set(llmClean.map((p) => comparisonKey(p)));
  const matched = llmClean
    .filter((p) => apiByKey.has(comparisonKey(p)))
    .map((p) => fromIdea(p, apiByKey.get(comparisonKey(p)) as ApiIdea, "both"));
  const apiOnly = apiKept
    .filter((i) => !llmKeys.has(comparisonKey(i.phrase)))
    .map((i) => fromIdea(i.phrase, i, "api"));
  return [...matched, ...apiOnly];
}
