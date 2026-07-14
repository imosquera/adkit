/**
 * Pure helper: format a Candidate into the decorated bullet text.
 *
 * The slash command's LLM copies `bulletText` VERBATIM into the markdown file.
 * This module is the ONLY producer of the decoration string (spec FR-017).
 */

import type { Candidate } from "./merge.js";
import { formatCpcRange, formatVolume } from "./metrics.js";

/**
 * Format a Candidate into its bullet text. Candidates lacking volume or
 * competition render as the bare phrase; otherwise the phrase is decorated with
 * `(volume, competition[, cpcRange])`. When Keyword Planner returns no CPC at all
 * (both bounds null/0), the cost segment is dropped entirely — `(6.6k, LOW)` —
 * rather than emitting a meaningless `$–`.
 *
 * (Python `format_bullet_text`.)
 */
export function formatBulletText(c: Candidate): string {
  if (c.volume === null || c.volume === undefined || c.competition === null || c.competition === undefined) {
    return c.phrase;
  }
  const vol = formatVolume(c.volume);
  const segments = [vol, c.competition];
  // Only include CPC when at least one bound is present; both-absent would render
  // the placeholder `$–`, which is noise.
  if (c.lowMicros || c.highMicros) {
    segments.push(formatCpcRange(c.lowMicros, c.highMicros));
  }
  return `${c.phrase} (${segments.join(", ")})`;
}
