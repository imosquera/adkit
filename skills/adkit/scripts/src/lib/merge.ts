/**
 * Pure helpers: candidate union/dedup, tier sort+cap.
 *
 * No SDK imports. Inputs may be SDK rows mapped to ApiIdea; outputs are frozen Candidates.
 */

export const MAX_KEYWORD_CHARS = 80;

/** A Keyword Planner idea row. (Python `@dataclass(frozen=True)` ApiIdea.) */
export interface ApiIdea {
  readonly phrase: string;
  readonly volume: number;
  readonly competition: string;
  readonly lowMicros: number | null;
  readonly highMicros: number | null;
  /** Google's semantic concept group for this idea; null when unannotated. */
  readonly conceptGroup: string | null;
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
  /** Google's semantic concept group; absent for bare LLM seeds. */
  readonly conceptGroup?: string | null;
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
    conceptGroup: idea.conceptGroup,
  };
}

/**
 * Union LLM seed phrases with Keyword Planner ideas into deduped Candidates.
 *
 * LLM seeds survive only when the Keyword Planner backs them with data; bare
 * (undecorated) seeds are dropped. API-only ideas with no measured volume, or over
 * MAX_KEYWORD_CHARS, are filtered out first. There is no volume floor beyond zero:
 * a 1000/mo floor silently emptied every sub-national geo (a whole county's worth
 * of real keywords read as "no demand"), which is a false negative, not a filter.
 *
 * (Python `union_candidates`.)
 */
export function unionCandidates(llm: Iterable<string>, api: Iterable<ApiIdea>): readonly Candidate[] {
  const apiKept = [...api].filter((i) => i.volume > 0 && i.phrase.length <= MAX_KEYWORD_CHARS);
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
