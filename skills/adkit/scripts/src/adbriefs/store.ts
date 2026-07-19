/**
 * The `adbriefs/` store: one YAML brief per campaign, the local source of truth.
 *
 * `/adkit create` persists a campaign's filled brief here before publishing, and
 * `/adkit update` stages its changes here before mutating live ads — so every live
 * change can be diffed against the on-disk brief first (see reference/conventions.md).
 *
 * Style: `slugForCampaign`, `briefPathForCampaign`, and `serializeBrief` are pure
 * (same input → same output, no fs). Only `loadBriefIfExists` and `writeBrief` touch
 * the filesystem — the I/O edge. The on-disk YAML is parsed once through the shared
 * `parseBrief` (zod) boundary; callers receive a typed {@link Brief}.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify, YAMLParseError, type ToStringOptions } from "yaml";
import { z } from "zod";

import { parseBrief, type Brief } from "../lib/schema.js";

/** Directory (relative to the repo root) holding one `<slug>.yaml` per campaign. */
export const ADBRIEFS_DIR = "adbriefs";

/**
 * YAML stringify options shared by {@link serializeBrief} and the `create` scaffold
 * writer. Double-quoting every string keeps a colon-space value from breaking a later
 * hand-edit; `lineWidth: 0` disables folding. Load-bearing: `diffBriefs` relies on two
 * equal briefs serializing byte-identically, so both writers MUST use these options.
 */
export const BRIEF_YAML_STRINGIFY_OPTS: ToStringOptions = {
  defaultStringType: "QUOTE_DOUBLE",
  defaultKeyType: "PLAIN",
  lineWidth: 0,
};

/**
 * A brief-store operation that cannot proceed — a filename collision with a
 * *different* campaign, or an unparseable on-disk brief. Carried as a typed error
 * so the command edge can surface `error: <message>` and exit non-zero.
 */
export class AdbriefsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbriefsError";
  }
}

/**
 * Pure: derive the deterministic filename slug for a campaign from its name. The
 * same campaign always maps to the same slug (FR-008) — lower-cased, every run of
 * non-alphanumerics collapsed to a single `-`, and leading/trailing `-` trimmed.
 */
export function slugForCampaign(brief: Brief): string {
  const slug = brief.campaign.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A campaign name is a non-empty string (schema `min(1)`), but it could be all
  // punctuation; fall back to the brief name (kebab-case by schema) so the slug is
  // never empty.
  return slug.length > 0 ? slug : brief.name;
}

/** Pure: absolute-or-relative path to a campaign's brief file under `root`/adbriefs/. */
export function briefPathForCampaign(root: string, brief: Brief): string {
  return join(root, ADBRIEFS_DIR, `${slugForCampaign(brief)}.yaml`);
}

/**
 * Pure: serialize a brief to stable, deterministic YAML. Double-quotes every string
 * (so a value containing a colon-space survives a later hand-edit) and disables line
 * folding, mirroring the scaffold writer — two equal briefs serialize byte-identically,
 * which is what makes {@link diffBriefs} clean.
 */
export function serializeBrief(brief: Brief): string {
  return yamlStringify(brief, BRIEF_YAML_STRINGIFY_OPTS);
}

/**
 * Read + parse the brief at `path` into a typed {@link Brief}. Throws
 * {@link AdbriefsError} on invalid YAML or a schema violation (surfaced by the caller).
 */
function readBriefFile(path: string): Brief {
  let data: unknown;
  try {
    data = yamlParse(readFileSync(path, "utf8"));
  } catch (exc) {
    if (exc instanceof YAMLParseError) {
      const where = exc.linePos?.[0] ? ` (line ${exc.linePos[0].line})` : "";
      throw new AdbriefsError(`adbriefs brief is not valid YAML${where}: ${exc.message.split("\n")[0]}`);
    }
    throw exc;
  }
  try {
    return parseBrief(data);
  } catch (exc) {
    if (exc instanceof z.ZodError) {
      const lines = exc.errors.map((e) => `  - ${e.path.map((p) => String(p)).join(".")}: ${e.message}`);
      throw new AdbriefsError(`adbriefs brief at ${path} failed validation:\n${lines.join("\n")}`);
    }
    throw exc;
  }
}

/**
 * Load the persisted brief for `brief`'s campaign, or `null` if none exists yet.
 * The returned value is the *current* on-disk state to diff a proposed change against.
 */
export function loadBriefIfExists(root: string, brief: Brief): Brief | null {
  const path = briefPathForCampaign(root, brief);
  return existsSync(path) ? readBriefFile(path) : null;
}

/**
 * If `brief`'s slug path is already occupied by a **different** campaign's brief,
 * throw {@link AdbriefsError} naming the collision; otherwise no-op. Shared by the
 * `create` command (so a dry-run surfaces the collision the review is supposed to
 * catch, not just the real publish) and {@link writeBrief} (defense in depth) — a
 * slug collision must never silently clobber another campaign's source of truth (FR-008).
 */
export function assertNoForeignBrief(root: string, brief: Brief): void {
  const path = briefPathForCampaign(root, brief);
  if (!existsSync(path)) {
    return;
  }
  const existing = readBriefFile(path);
  if (existing.campaign.name !== brief.campaign.name) {
    throw new AdbriefsError(
      `adbriefs collision: ${path} already describes campaign "${existing.campaign.name}", ` +
        `refusing to overwrite it with "${brief.campaign.name}". Rename one campaign or move the brief.`,
    );
  }
}

/**
 * Persist `brief` to its `adbriefs/<slug>.yaml`, creating the directory as needed.
 * Refuses (via {@link assertNoForeignBrief}) to overwrite a *different* campaign's
 * brief at the same slug (FR-008). Returns the path written.
 */
export function writeBrief(root: string, brief: Brief): string {
  assertNoForeignBrief(root, brief);
  const path = briefPathForCampaign(root, brief);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeBrief(brief));
  return path;
}
