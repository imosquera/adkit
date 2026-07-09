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
 * `(volume, competition, cpcRange)`.
 *
 * (Python `format_bullet_text`.)
 */
export function formatBulletText(c: Candidate): string {
  if (c.volume === null || c.volume === undefined || c.competition === null || c.competition === undefined) {
    return c.phrase;
  }
  const vol = formatVolume(c.volume);
  const cpc = formatCpcRange(c.lowMicros, c.highMicros);
  return `${c.phrase} (${vol}, ${c.competition}, ${cpc})`;
}
