/**
 * The Meta **state** store: one `adbriefs/<slug>.meta-state.yaml` per Meta campaign,
 * recording the name ↔ live-id mapping the Meta intent brief (`<slug>.yaml`) omits.
 *
 * Unlike the Google path, this file is written after EVERY successful publish step
 * (plan D7, FR-011), so ids are nullable: a partially published campaign records the
 * objects that exist and leaves `null` where a re-run still has work to do. `update`
 * also rewrites it after every successful creative swap ({@link withSwappedCreatives}),
 * so the recorded `creativeId` always mirrors what is live.
 *
 * The suffix `.meta-state.yaml` deliberately does not end in `.state.yaml`, so the
 * Google `loadStateIndex` never picks Meta state up.
 *
 * Style: `metaStatePath`, `emptyMetaState`, `withSwappedCreatives`, `serializeMetaState`, `parseMetaState`, and
 * `slugFromMetaStateFile` are pure. `readMetaState`, `writeMetaState`, and
 * `loadMetaStateIndex` are the I/O edge. On-disk state is parsed once through
 * {@link MetaStateSchema}; callers receive a typed {@link MetaState}.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";

import { ADBRIEFS_DIR, AdbriefsError, BRIEF_YAML_STRINGIFY_OPTS, slugForCampaign } from "../adbriefs/store.js";
import { writeYamlAtomic } from "../lib/config.js";
import {
  err,
  ImageHashSchema,
  MetaAdAccountIdSchema,
  MetaAdIdSchema,
  MetaAdSetIdSchema,
  MetaCampaignIdSchema,
  MetaCreativeIdSchema,
  MetaVideoIdSchema,
  ok,
  type MetaAdAccountId,
  type MetaAdId,
  type MetaCreativeId,
  type Result,
} from "./ids.js";

/** Suffix of a Meta state file, e.g. `close-assistant.meta-state.yaml`. */
export const META_STATE_SUFFIX = ".meta-state.yaml";

/** Permissions for a state file: it holds ids, not secrets, and is meant to be committed. */
const STATE_FILE_MODE = 0o644;

const MediaStateSchema = z
  .object({
    sha256: z.string().min(1),
    imageHash: ImageHashSchema.optional(),
    videoId: MetaVideoIdSchema.optional(),
  })
  .strict();

const AdStateSchema = z
  .object({
    name: z.string().min(1),
    creativeId: MetaCreativeIdSchema.nullable(),
    adId: MetaAdIdSchema.nullable(),
  })
  .strict();

const AdSetStateSchema = z
  .object({
    name: z.string().min(1),
    adSetId: MetaAdSetIdSchema.nullable(),
    ads: z.array(AdStateSchema),
  })
  .strict();

/** The `<slug>.meta-state.yaml` payload. `media` is keyed by the brief's media path. */
export const MetaStateSchema = z
  .object({
    platform: z.literal("meta"),
    adAccountId: MetaAdAccountIdSchema,
    campaign: z
      .object({
        name: z.string().min(1),
        campaignId: MetaCampaignIdSchema.nullable(),
      })
      .strict(),
    media: z.record(z.string(), MediaStateSchema),
    adSets: z.array(AdSetStateSchema),
  })
  .strict();

export type MetaState = z.output<typeof MetaStateSchema>;
export type MetaMediaState = z.output<typeof MediaStateSchema>;
export type MetaAdSetState = z.output<typeof AdSetStateSchema>;
export type MetaAdState = z.output<typeof AdStateSchema>;

/** Pure: parse untrusted state data, collecting every zod issue into one message. */
export function parseMetaState(data: unknown): Result<MetaState> {
  const parsed = MetaStateSchema.safeParse(data);
  return parsed.success
    ? ok(parsed.data)
    : err(parsed.error.errors.map((e) => `  - ${e.path.map(String).join(".") || "(root)"}: ${e.message}`).join("\n"));
}

/** Pure: path to a campaign's Meta state file under `root`/`dir`/. */
export function metaStatePath(
  root: string,
  brief: { name: string; campaign: { name: string } },
  dir: string = ADBRIEFS_DIR,
): string {
  return join(root, dir, `${slugForCampaign(brief)}${META_STATE_SUFFIX}`);
}

/** The brief shape {@link emptyMetaState} reads: the object names, in publish order. */
export interface MetaStateSkeleton {
  campaign: { name: string };
  adSets: readonly { name: string; ads: readonly { name: string }[] }[];
}

/** Pure: a fresh state for `brief` — every name pre-populated, every id `null`, no media. */
export function emptyMetaState(brief: MetaStateSkeleton, adAccountId: MetaAdAccountId): MetaState {
  return {
    platform: "meta",
    adAccountId,
    campaign: { name: brief.campaign.name, campaignId: null },
    media: {},
    adSets: brief.adSets.map((adSet) => ({
      name: adSet.name,
      adSetId: null,
      ads: adSet.ads.map((ad) => ({ name: ad.name, creativeId: null, adId: null })),
    })),
  };
}

/** A successful creative swap: the ad now points at `creativeId`. */
export type MetaCreativeSwap = { readonly adId: MetaAdId; readonly creativeId: MetaCreativeId };

/**
 * Pure: `state` with the `creativeId` of every ad named by a swap (matched on `adId`)
 * replaced by the swap's new creative id. Ads no swap names are returned unchanged.
 */
export function withSwappedCreatives(state: MetaState, swaps: readonly MetaCreativeSwap[]): MetaState {
  const byAdId = new Map(swaps.map((s) => [s.adId, s.creativeId]));
  return {
    ...state,
    adSets: state.adSets.map((adSet) => ({
      ...adSet,
      ads: adSet.ads.map((ad) => {
        const creativeId = ad.adId === null ? undefined : byAdId.get(ad.adId);
        return creativeId === undefined ? ad : { ...ad, creativeId };
      }),
    })),
  };
}

/** Pure: serialize state with the same stable YAML options the briefs use. */
export function serializeMetaState(state: MetaState): string {
  return yamlStringify(state, BRIEF_YAML_STRINGIFY_OPTS);
}

/**
 * Read + parse a Meta state file. Returns `null` when the file does not exist; throws
 * {@link AdbriefsError} naming the file when it is unreadable YAML or fails the schema
 * (a corrupt state file must never be silently treated as "nothing published").
 */
export function readMetaState(path: string): MetaState | null {
  if (!existsSync(path)) {
    return null;
  }
  const data = parseYamlFile(path);
  const parsed = parseMetaState(data);
  if (parsed.kind === "err") {
    throw new AdbriefsError(`meta state at ${path} failed validation:\n${parsed.message}`);
  }
  return parsed.value;
}

/** Atomically persist `state` to `path` (temp file + rename), creating the directory. */
export function writeMetaState(path: string, state: MetaState): void {
  writeYamlAtomic(path, serializeMetaState(state), STATE_FILE_MODE);
}

/** Pure: the slug a Meta state filename encodes, or `null` for any other file. */
export function slugFromMetaStateFile(fileName: string): string | null {
  return fileName.endsWith(META_STATE_SUFFIX) ? fileName.slice(0, -META_STATE_SUFFIX.length) : null;
}

/** Where a live Meta id lives: the brief slug plus the names of the entities on its path. */
export interface MetaStateLocator {
  slug: string;
  campaignName: string;
  adSetName?: string;
  adName?: string;
}

/** Reverse index over every `adbriefs/*.meta-state.yaml`: live id → locator. */
export interface MetaStateIndex {
  byCampaignId: ReadonlyMap<string, MetaStateLocator>;
  byAdSetId: ReadonlyMap<string, MetaStateLocator>;
  byAdId: ReadonlyMap<string, MetaStateLocator>;
}

type IndexEntries = {
  campaigns: readonly (readonly [string, MetaStateLocator])[];
  adSets: readonly (readonly [string, MetaStateLocator])[];
  ads: readonly (readonly [string, MetaStateLocator])[];
};

/** Pure: the index entries one state contributes; null ids (unpublished objects) are skipped. */
export function metaStateIndexEntries(slug: string, state: MetaState): IndexEntries {
  const campaignName = state.campaign.name;
  const campaigns = state.campaign.campaignId === null ? [] : [[state.campaign.campaignId, { slug, campaignName }] as const];
  const adSets = state.adSets.flatMap((adSet) =>
    adSet.adSetId === null ? [] : [[adSet.adSetId, { slug, campaignName, adSetName: adSet.name }] as const],
  );
  const ads = state.adSets.flatMap((adSet) =>
    adSet.ads.flatMap((ad) =>
      ad.adId === null ? [] : [[ad.adId, { slug, campaignName, adSetName: adSet.name, adName: ad.name }] as const],
    ),
  );
  return { campaigns, adSets, ads };
}

/**
 * Read every Meta state file under `root`/`dir`/ and build the reverse id index. Empty
 * maps when the directory does not exist; a corrupt state file throws {@link AdbriefsError}.
 */
export function loadMetaStateIndex(root: string, dir: string = ADBRIEFS_DIR): MetaStateIndex {
  const base = join(root, dir);
  const entries = existsSync(base)
    ? readdirSync(base).flatMap((file) => {
        const slug = slugFromMetaStateFile(file);
        const state = slug === null ? null : readMetaState(join(base, file));
        return slug === null || state === null ? [] : [metaStateIndexEntries(slug, state)];
      })
    : [];
  return {
    byCampaignId: new Map(entries.flatMap((e) => e.campaigns)),
    byAdSetId: new Map(entries.flatMap((e) => e.adSets)),
    byAdId: new Map(entries.flatMap((e) => e.ads)),
  };
}

/** Read one file as YAML into `unknown`; throws {@link AdbriefsError} on a syntax error. */
function parseYamlFile(path: string): unknown {
  try {
    return yamlParse(readFileSync(path, "utf8"));
  } catch (exc) {
    const message = exc instanceof Error ? exc.message.split("\n")[0] : String(exc);
    throw new AdbriefsError(`meta state at ${path} is not valid YAML: ${message}`);
  }
}
