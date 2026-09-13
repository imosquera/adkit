/**
 * Branded Meta (Graph API) identifiers and the shared `Result` type.
 *
 * Every id that could be confused with another gets its own zod `.brand()`, so an
 * ad set id cannot be passed where an ad id is expected. Brand casts happen only
 * here: downstream modules embed these schemas in their own zod objects (graph
 * responses, brief, state, plan) and receive the branded type as proof.
 */

import { z } from "zod";

/** Outcome of a parse at a trust boundary. */
export type Result<T> = { kind: "ok"; value: T } | { kind: "err"; message: string };

export const ok = <T>(value: T): Result<T> => ({ kind: "ok", value });
export const err = <T = never>(message: string): Result<T> => ({ kind: "err", message });

/** Graph ids arrive as digit strings; numbers are accepted and stringified. */
const rawId = z
  .union([z.string(), z.number().int().nonnegative().safe()])
  .transform((v) => String(v).trim());

/** Schema for a numeric Graph object id carrying the nominal brand `B`. */
export const metaIdSchema = <B extends string>() =>
  rawId.pipe(z.string().regex(/^\d+$/, "expected a numeric Meta id")).brand<B>();

export const MetaCampaignIdSchema = metaIdSchema<"MetaCampaignId">();
export const MetaAdSetIdSchema = metaIdSchema<"MetaAdSetId">();
export const MetaAdIdSchema = metaIdSchema<"MetaAdId">();
export const MetaCreativeIdSchema = metaIdSchema<"MetaCreativeId">();
export const MetaPageIdSchema = metaIdSchema<"MetaPageId">();
export const MetaPixelIdSchema = metaIdSchema<"MetaPixelId">();
export const MetaCustomAudienceIdSchema = metaIdSchema<"MetaCustomAudienceId">();
export const MetaVideoIdSchema = metaIdSchema<"MetaVideoId">();

/** Ad account id: accepts `123` or `act_123` (trimmed), outputs canonical `act_123`. */
export const MetaAdAccountIdSchema = rawId
  .pipe(z.string().regex(/^(act_)?\d+$/, "expected an ad account id like 123 or act_123"))
  .transform((v) => (v.startsWith("act_") ? v : `act_${v}`))
  .brand<"MetaAdAccountId">();

/** Image hash returned by `act_<id>/adimages`; opaque non-empty token. */
export const ImageHashSchema = z
  .string()
  .trim()
  .regex(/^\S+$/, "expected a non-empty image hash")
  .brand<"ImageHash">();

/** Graph API access token; opaque non-empty string without whitespace. */
export const MetaAccessTokenSchema = z
  .string()
  .trim()
  .regex(/^\S+$/, "expected a non-empty access token")
  .brand<"MetaAccessToken">();

export type MetaAdAccountId = z.output<typeof MetaAdAccountIdSchema>;
export type MetaCampaignId = z.output<typeof MetaCampaignIdSchema>;
export type MetaAdSetId = z.output<typeof MetaAdSetIdSchema>;
export type MetaAdId = z.output<typeof MetaAdIdSchema>;
export type MetaCreativeId = z.output<typeof MetaCreativeIdSchema>;
export type MetaPageId = z.output<typeof MetaPageIdSchema>;
export type MetaPixelId = z.output<typeof MetaPixelIdSchema>;
export type MetaCustomAudienceId = z.output<typeof MetaCustomAudienceIdSchema>;
export type MetaVideoId = z.output<typeof MetaVideoIdSchema>;
export type ImageHash = z.output<typeof ImageHashSchema>;
export type MetaAccessToken = z.output<typeof MetaAccessTokenSchema>;

/**
 * Parse an ad account id from any source (flag, env, config, brief, plan).
 * `source` names where the value came from so the error message is actionable.
 */
export const parseMetaAdAccountId = (raw: unknown, source: string): Result<MetaAdAccountId> => {
  const parsed = MetaAdAccountIdSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(
        `${source}: invalid Meta ad account id ${JSON.stringify(raw) ?? String(raw)} ` +
          "(expected digits, optionally prefixed with act_, e.g. act_1234567890)",
      );
};
