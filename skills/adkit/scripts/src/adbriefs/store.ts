/**
 * The `adbriefs/` store: one YAML brief per campaign, the local source of truth.
 *
 * `/adkit create` persists a campaign's filled brief here before publishing, and
 * `/adkit update` stages its changes here before mutating live ads — so every live
 * change can be diffed against the on-disk brief first (see reference/conventions.md).
 *
 * Style: `slugForCampaign`, `briefPathForCampaign`, and `serializeBrief` are pure
 * (same input → same output, no fs). Only `loadBriefIfExists` and `writeBrief` touch
 * the filesystem — the I/O edge. The store's directory arrives as a trailing
 * parameter rather than being read from config in here, so the path builders stay
 * pure; the command edge resolves it once via `resolveBriefsDir` and threads it. The on-disk YAML is parsed once through the shared
 * `parseAnyBrief` (zod) boundary; callers receive a typed {@link AnyBrief}.
 *
 * The store is platform-neutral: every function is generic over {@link StorableBrief}
 * (the only shape the slug and collision logic read), and the reading functions take
 * an optional trailing `parse` so another platform's brief (e.g. Meta) is parsed by its
 * own boundary. Omitting `parse` keeps the Google behaviour (`parseAnyBrief`) exactly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify, YAMLParseError, type ToStringOptions } from "yaml";
import { z } from "zod";

import { DEFAULT_BRIEFS_DIR } from "../lib/config.js";
import { parseAnyBrief, type AnyBrief } from "../lib/schema.js";

/**
 * Default directory (relative to the repo root) holding one `<slug>.yaml` per
 * campaign. Re-exported from `lib/config.ts` so this module keeps naming the
 * concept it owns, while the default itself lives beside the `briefs_dir` setting
 * that overrides it.
 */
export const ADBRIEFS_DIR = DEFAULT_BRIEFS_DIR;

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
 * The minimal shape the store needs from a brief: a `name` (the slug fallback) and a
 * `campaign.name` (the slug source and collision identity). Every platform's parsed
 * brief satisfies it.
 */
export type StorableBrief = { name: string; campaign: { name: string } };

/** Parse boundary for an on-disk brief: returns the typed brief or throws (zod or otherwise). */
export type BriefParser<B extends StorableBrief> = (data: unknown) => B;

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
export function slugForCampaign<B extends StorableBrief>(brief: B): string {
  const slug = brief.campaign.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A campaign name is a non-empty string (schema `min(1)`), but it could be all
  // punctuation; fall back to the brief name (kebab-case by schema) so the slug is
  // never empty.
  return slug.length > 0 ? slug : brief.name;
}

/** Pure: absolute-or-relative path to a campaign's brief file under `root`/`dir`/. */
export function briefPathForCampaign<B extends StorableBrief>(root: string, brief: B, dir: string = ADBRIEFS_DIR): string {
  return join(root, dir, `${slugForCampaign(brief)}.yaml`);
}

/**
 * Pure: serialize a brief to stable, deterministic YAML. Double-quotes every string
 * (so a value containing a colon-space survives a later hand-edit) and disables line
 * folding, mirroring the scaffold writer — two equal briefs serialize byte-identically,
 * which is what makes {@link diffBriefs} clean.
 */
export function serializeBrief<B extends StorableBrief>(brief: B): string {
  return yamlStringify(brief, BRIEF_YAML_STRINGIFY_OPTS);
}

/**
 * Read + parse the brief at `path` through `parse`. Throws {@link AdbriefsError} on
 * invalid YAML or a schema violation (surfaced by the caller).
 */
function readBriefFile<B extends StorableBrief>(path: string, parse: BriefParser<B>): B {
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
    return parse(data);
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
 * Without `parse` the file is read as a Google {@link AnyBrief}; pass a platform's
 * parser to read that platform's brief instead.
 */
export function loadBriefIfExists<B extends StorableBrief>(
  root: string,
  brief: B,
  dir: string | undefined,
  parse: BriefParser<B>,
): B | null;
export function loadBriefIfExists(root: string, brief: AnyBrief, dir?: string): AnyBrief | null;
export function loadBriefIfExists(
  root: string,
  brief: StorableBrief,
  dir: string = ADBRIEFS_DIR,
  parse: BriefParser<StorableBrief> = parseAnyBrief,
): StorableBrief | null {
  const path = briefPathForCampaign(root, brief, dir);
  return existsSync(path) ? readBriefFile(path, parse) : null;
}

/**
 * If `brief`'s slug path is already occupied by a **different** campaign's brief,
 * throw {@link AdbriefsError} naming the collision; otherwise no-op. Shared by the
 * `create` command (so a dry-run surfaces the collision the review is supposed to
 * catch, not just the real publish) and {@link writeBrief} (defense in depth) — a
 * slug collision must never silently clobber another campaign's source of truth (FR-008).
 * `parse` reads the occupant as for {@link loadBriefIfExists}.
 */
export function assertNoForeignBrief<B extends StorableBrief>(
  root: string,
  brief: B,
  dir: string | undefined,
  parse: BriefParser<B>,
): void;
export function assertNoForeignBrief(root: string, brief: AnyBrief, dir?: string): void;
export function assertNoForeignBrief(
  root: string,
  brief: StorableBrief,
  dir: string = ADBRIEFS_DIR,
  parse: BriefParser<StorableBrief> = parseAnyBrief,
): void {
  const path = briefPathForCampaign(root, brief, dir);
  if (!existsSync(path)) {
    return;
  }
  const existing = readBriefFile(path, parse);
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
 * brief at the same slug (FR-008). Returns the path written. `parse` reads any existing
 * occupant for that collision check, as for {@link loadBriefIfExists}.
 */
export function writeBrief<B extends StorableBrief>(root: string, brief: B, dir: string | undefined, parse: BriefParser<B>): string;
export function writeBrief(root: string, brief: AnyBrief, dir?: string): string;
export function writeBrief(
  root: string,
  brief: StorableBrief,
  dir: string = ADBRIEFS_DIR,
  parse: BriefParser<StorableBrief> = parseAnyBrief,
): string {
  assertNoForeignBrief(root, brief, dir, parse);
  const path = briefPathForCampaign(root, brief, dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeBrief(brief));
  return path;
}
