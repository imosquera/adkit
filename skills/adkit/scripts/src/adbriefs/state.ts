/**
 * The `adbriefs/` **state** store: one `<slug>.state.yaml` per campaign recording the
 * name ↔ live-id mapping that the intent brief (`<slug>.yaml`) deliberately omits.
 *
 * The split mirrors Terraform's `.tf` (authored intent) vs `.tfstate` (live ids):
 *   - `<slug>.yaml`        — the intent brief: names + copy only, portable, replayable.
 *   - `<slug>.state.yaml`  — the live ids Google assigned at publish time.
 *
 * `/adkit create` writes the state file after a successful publish (it already gets
 * every `resource_name` back from the executor). `/adkit update` reads it to resolve a
 * plan's live ids (`adId`/`adGroupId`/`campaignId`) back to the brief entity they name —
 * so it can stage a plan into the intent brief and show a brief diff, with zero extra
 * Google Ads queries. Keeping the ids OUT of the intent brief is what keeps the brief a
 * clean, account-independent source of truth.
 *
 * Style: `buildState`, `slugFromStateFile`, and `serializeState` are pure (no fs). Only
 * `writeState` and `loadStateIndex` touch the filesystem — the I/O edge. On-disk state is
 * parsed once through the zod `CampaignStateSchema` boundary; callers receive a typed value.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify, YAMLParseError } from "yaml";
import { z } from "zod";

import type { ExecResults } from "../ads/publish.js";
import { CUSTOMER_ID_PATTERN } from "../lib/schema.js";
import { ADBRIEFS_DIR, AdbriefsError, BRIEF_YAML_STRINGIFY_OPTS, slugForCampaign } from "./store.js";
import type { Brief } from "../lib/schema.js";

/** Suffix of a state file, e.g. `close-assistant.state.yaml`. */
const STATE_SUFFIX = ".state.yaml";

const idString = z.string().regex(/^[0-9]+$/, { message: "must be a numeric id" });

/** One ad group's live ids: its `adGroupId` and the id of the RSA (`adId`, null if none). */
export const AdGroupStateSchema = z
  .object({
    name: z.string().min(1),
    adGroupId: idString,
    // Reused ad groups carry no freshly-created RSA, so the ad id can be absent.
    adId: idString.nullable(),
  })
  .strict();
export type AdGroupState = z.infer<typeof AdGroupStateSchema>;

/** The live-id state for one published campaign — the `<slug>.state.yaml` payload. */
export const CampaignStateSchema = z
  .object({
    customerId: z.string().regex(CUSTOMER_ID_PATTERN, { message: "must be 10 digits" }).optional(),
    campaign: z
      .object({
        name: z.string().min(1),
        campaignId: idString,
        budgetId: idString.nullable(),
      })
      .strict(),
    adGroups: z.array(AdGroupStateSchema),
  })
  .strict();
export type CampaignState = z.infer<typeof CampaignStateSchema>;

/** Parse + validate on-disk state, throwing a `ZodError` on failure. */
export function parseState(data: unknown): CampaignState {
  return CampaignStateSchema.parse(data);
}

/** Pure: absolute-or-relative path to a campaign's state file under `root`/adbriefs/. */
export function statePathForCampaign(root: string, brief: Brief): string {
  return join(root, ADBRIEFS_DIR, `${slugForCampaign(brief)}${STATE_SUFFIX}`);
}

/**
 * Pure: assemble the state payload from a published brief + the executor's
 * {@link ExecResults}. `campaignId` is non-null on a successful publish (the caller
 * only writes state on success); the field is typed permissively here and rejected by
 * {@link parseState} if a caller ever hands over an incomplete result.
 */
export function buildState(brief: Brief, results: ExecResults): CampaignState {
  return {
    ...(brief.customerId !== undefined ? { customerId: brief.customerId } : {}),
    campaign: {
      name: brief.campaign.name,
      campaignId: String(results.campaignId),
      budgetId: results.budgetId === null ? null : String(results.budgetId),
    },
    adGroups: results.adGroups.map((ag) => ({
      name: ag.name,
      adGroupId: String(ag.adGroupId),
      adId: ag.responsiveSearchAdId === null ? null : String(ag.responsiveSearchAdId),
    })),
  };
}

/** Pure: serialize state to the same stable YAML the briefs use (double-quoted, no folding). */
export function serializeState(state: CampaignState): string {
  return yamlStringify(state, BRIEF_YAML_STRINGIFY_OPTS);
}

/**
 * Persist `state` to `brief`'s `adbriefs/<slug>.state.yaml`, creating the directory as
 * needed. Returns the path written. Paired with {@link writeBrief} — the intent brief and
 * its state file share a slug.
 */
export function writeState(root: string, brief: Brief, state: CampaignState): string {
  const path = statePathForCampaign(root, brief);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeState(state));
  return path;
}

/** Pure: the slug a state filename encodes (`close-assistant.state.yaml` → `close-assistant`). */
export function slugFromStateFile(fileName: string): string | null {
  return fileName.endsWith(STATE_SUFFIX) ? fileName.slice(0, -STATE_SUFFIX.length) : null;
}

/** Where a state entry lives + the entity it names — the value type of the id index. */
export interface StateLocator {
  slug: string;
  campaignName: string;
}

/** An ad-group-level locator also carries the ad group's brief name. */
export interface AdGroupLocator extends StateLocator {
  adGroupName: string;
}

/**
 * The reverse index over every `adbriefs/*.state.yaml`: live id → the brief slug (and
 * entity name) it belongs to. This is how `update` turns an id-keyed plan into an
 * intent-brief edit without a single live query.
 */
export interface StateIndex {
  byCampaignId: Map<string, StateLocator>;
  byAdGroupId: Map<string, AdGroupLocator>;
  byAdId: Map<string, AdGroupLocator>;
}

/**
 * Read every `adbriefs/*.state.yaml` under `root` and build the reverse id index. A
 * state file that is unparseable or fails schema validation raises {@link AdbriefsError}
 * naming it (a corrupt state file must not silently drop a campaign from the index).
 * Returns empty maps when the `adbriefs/` directory does not exist yet.
 */
export function loadStateIndex(root: string): StateIndex {
  const dir = join(root, ADBRIEFS_DIR);
  const index: StateIndex = { byCampaignId: new Map(), byAdGroupId: new Map(), byAdId: new Map() };
  if (!existsSync(dir)) {
    return index;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(STATE_SUFFIX));
  return files.reduce((acc, file) => {
    const slug = slugFromStateFile(file)!;
    const path = join(dir, file);
    const state = readStateFile(path);
    acc.byCampaignId.set(state.campaign.campaignId, { slug, campaignName: state.campaign.name });
    for (const ag of state.adGroups) {
      const loc: AdGroupLocator = { slug, campaignName: state.campaign.name, adGroupName: ag.name };
      acc.byAdGroupId.set(ag.adGroupId, loc);
      if (ag.adId !== null) {
        acc.byAdId.set(ag.adId, loc);
      }
    }
    return acc;
  }, index);
}

/** Read + parse one state file into a typed {@link CampaignState}; throws {@link AdbriefsError}. */
function readStateFile(path: string): CampaignState {
  let data: unknown;
  try {
    data = yamlParse(readFileSync(path, "utf8"));
  } catch (exc) {
    if (exc instanceof YAMLParseError) {
      const where = exc.linePos?.[0] ? ` (line ${exc.linePos[0].line})` : "";
      throw new AdbriefsError(`adbriefs state is not valid YAML${where}: ${exc.message.split("\n")[0]}`);
    }
    throw exc;
  }
  try {
    return parseState(data);
  } catch (exc) {
    if (exc instanceof z.ZodError) {
      const lines = exc.errors.map((e) => `  - ${e.path.map((p) => String(p)).join(".")}: ${e.message}`);
      throw new AdbriefsError(`adbriefs state at ${path} failed validation:\n${lines.join("\n")}`);
    }
    throw exc;
  }
}
