/**
 * The differentiation profile that powers the audit's "me-too copy" check.
 *
 * This is NOT a hardcoded, single-advertiser constant (the original Python baked in
 * one AI-writing product's competitors + axes, which does not generalise). Instead a
 * profile is DYNAMIC — authored per run from the campaign's own ad copy/keywords, the
 * landing page, and the source idea, exactly like the per-account `--banned` phrases
 * have no universal default. "What actually differentiates this product" is judgement,
 * so the model builds the profile from those three sources; the deterministic scorer
 * only PARSES and APPLIES it (parse, don't validate).
 *
 * A profile has three parts:
 *  - `genericPhrases` — lexemes that mark copy as an undifferentiated category promise
 *    (e.g. "ai chatbot" for an AI tool, "cheap flights" for travel).
 *  - `axes` — the dimensions a competitor can't easily replicate; each carries the
 *    lowercase `triggers` whose presence in the copy counts that axis as covered.
 *  - `competitors` — who the differentiation is judged relative to (informational; used
 *    when the model narrates the finding).
 */

import { z } from "zod";

/**
 * One axis a competitor can't easily replicate. `triggers` are the lowercase lexemes
 * whose presence in an ad's copy counts the axis as covered.
 */
export const DifferentiationAxisSchema = z
  .object({
    name: z.string().min(1),
    triggers: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type DifferentiationAxis = z.infer<typeof DifferentiationAxisSchema>;

/**
 * A complete differentiation profile for one campaign/product, derived from its
 * campaign, landing page, and idea. All parts default to empty — an empty profile
 * simply means the me-too check finds nothing (no generic phrases → never flagged).
 */
export const DifferentiationProfileSchema = z
  .object({
    competitors: z.array(z.string().min(1)).default([]),
    axes: z.array(DifferentiationAxisSchema).default([]),
    genericPhrases: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type DifferentiationProfile = z.infer<typeof DifferentiationProfileSchema>;

/** The neutral profile: no generic phrases and no axes, so nothing is ever flagged. */
export const EMPTY_PROFILE: DifferentiationProfile = { competitors: [], axes: [], genericPhrases: [] };

/**
 * Parse an untrusted profile (model-authored JSON) into a `DifferentiationProfile`,
 * throwing on malformed input. Downstream code receives the parsed type and never
 * re-checks it.
 */
export function parseDifferentiationProfile(data: unknown): DifferentiationProfile {
  return DifferentiationProfileSchema.parse(data);
}
