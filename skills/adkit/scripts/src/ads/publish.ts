/**
 * The one public publish path: {@link publishV1} (budget + campaign + N ad groups,
 * each with RSA + keywords; reuses an existing campaign of the same name). It
 * catches SDK errors at step granularity (via {@link step}) and returns a
 * {@link RunOutcome} recording partial successes and the failing step. Revisions to
 * live ads go through ads.sh apply-fixes, not here.
 *
 * Entity construction lives in entities.ts; the step-error machinery in errors.ts.
 *
 * Style note: everything in the ads layer is pure/functional, but {@link publishV1}
 * is the single deliberate exception — sequencing plus a mutable {@link ExecResults}
 * accumulator that records partial success is acceptable here (and only here),
 * because the port must, like the Python original, stop mid-sequence on the first
 * failing step while keeping whatever already succeeded. That can't be expressed as
 * a pure comprehension, so the mutation is isolated to this one orchestration edge.
 */

import {
  archiveCampaignsByName,
  createAdGroup,
  createCallouts,
  createCampaignBudget,
  createDisplayAdGroup,
  createDisplayCampaign,
  createImageAssets,
  createMissingAudiences,
  createResponsiveDisplayAd,
  createKeywords,
  createNegativeKeywords,
  createPriceAsset,
  createResponsiveSearchAd,
  createSearchCampaign,
  createSitelinks,
  createStructuredSnippet,
  findExistingAdGroup,
  findExistingCampaign,
  findMissingResponsiveDisplayAds,
  findMissingKeywords,
  findMissingResponsiveSearchAds,
  targetDevices,
  targetUsCanada,
  ALL_DEVICES,
} from "./entities.js";
import type { ImageLibrary } from "./images.js";
import { StepError, sdkVersion, step } from "./errors.js";
import type { AdsClient } from "../lib/auth.js";
import type { Brief, DisplayBrief, Failure } from "../lib/schema.js";

/** Per-ad-group record of what {@link publishV1} created (or reused). */
export interface ExecAdGroup {
  name: string;
  adGroupId: string | null;
  // One id per RSA created THIS run — RSAS_PER_AD_GROUP on a freshly-created ad
  // group; on a reused ad group, only the ones it was still missing (possibly
  // none, if every brief RSA was already live — see findMissingResponsiveSearchAds).
  responsiveSearchAdIds: readonly string[];
  keywordResourceNames: readonly string[];
}

/**
 * What {@link publishV1} created — returned to the caller for a run summary. Not
 * persisted; the live account + Google change history are the record.
 */
export interface ExecResults {
  budgetId: string | null;
  campaignId: string | null;
  sitelinkResourceNames: readonly string[];
  calloutResourceNames: readonly string[];
  priceAssetResourceNames: readonly string[];
  structuredSnippetResourceNames: readonly string[];
  adGroups: ExecAdGroup[];
}

/** The full outcome of a publish run: what was created, plus the failure if any. */
export interface RunOutcome<R = ExecResults> {
  results: R;
  failure: Failure | null;
  executorVersion: string;
}

/** Build a fresh {@link ExecAdGroup} slot for `name`, nothing created yet. */
export function makeExecAdGroup(name: string): ExecAdGroup {
  return { name, adGroupId: null, responsiveSearchAdIds: [], keywordResourceNames: [] };
}

/** Build an empty {@link ExecResults}, one slot per ad group in `brief`. */
export function makeExecResults(brief: Brief): ExecResults {
  return {
    budgetId: null,
    campaignId: null,
    sitelinkResourceNames: [],
    calloutResourceNames: [],
    priceAssetResourceNames: [],
    structuredSnippetResourceNames: [],
    adGroups: brief.adGroups.map((ag) => makeExecAdGroup(ag.name)),
  };
}

/** Assemble a {@link RunOutcome} from its parts. */
export function makeRunOutcome<R>(results: R, failure: Failure | null, executorVersion: string): RunOutcome<R> {
  return { results, failure, executorVersion };
}

// ---------- Public API ----------

/**
 * Publish `brief` to `customerId` through `client`: create the campaign budget,
 * search campaign, its targeting + campaign-level assets, then each ad group with
 * its RSA and keywords. An existing campaign of the same name is reused (unless
 * `archiveExisting`, which archives same-named campaigns first and always creates
 * fresh). RSA and keyword creation are both idempotent by content (see
 * {@link findMissingResponsiveSearchAds} / {@link findMissingKeywords}): a reused
 * ad group only gets the RSAs/keywords it doesn't already have live, so a rerun
 * after a partial failure (mid-brief or mid-ad-group) fills the gap instead of
 * duplicating what already landed or skipping what never got created.
 *
 * The `client` is injected (the Python `publish_v1` called `load_client()`
 * internally) so this is unit-testable with a fake `AdsClient`; the bin/create
 * entrypoint calls {@link loadClient} and passes the result in.
 *
 * Never throws for an SDK/step failure: a {@link StepError} is caught and folded
 * into the returned {@link RunOutcome}'s `failure`, with `results` reflecting every
 * step that succeeded before it.
 */
export async function publishV1(
  client: AdsClient,
  customerId: string,
  brief: Brief,
  archiveExisting = false,
): Promise<RunOutcome> {
  const executorVersion = sdkVersion();
  const results = makeExecResults(brief);
  try {
    if (archiveExisting) {
      await step("archive-existing-campaign", () =>
        archiveCampaignsByName(client, customerId, brief.campaign.name),
      );
    }
    const existingCampaign = archiveExisting
      ? null
      : await step("find-existing-campaign", () => findExistingCampaign(client, customerId, brief));
    if (existingCampaign) {
      results.campaignId = existingCampaign[0];
      results.budgetId = existingCampaign[1];
    } else {
      results.budgetId = await step("create-campaign-budget", () =>
        createCampaignBudget(client, customerId, brief),
      );
      results.campaignId = await step("create-search-campaign", () =>
        createSearchCampaign(client, customerId, brief, results.budgetId!),
      );
      await step("target-location", () => targetUsCanada(client, customerId, results.campaignId!));
      await step("target-devices", () =>
        targetDevices(client, customerId, results.campaignId!, brief.campaign.devices),
      );
      await step("create-negative-keywords", () =>
        createNegativeKeywords(client, customerId, results.campaignId!, brief.campaign.negativeKeywords),
      );
      results.sitelinkResourceNames = await step("create-sitelinks", () =>
        createSitelinks(client, customerId, brief, results.campaignId!),
      );
      results.calloutResourceNames = await step("create-callouts", () =>
        createCallouts(client, customerId, brief, results.campaignId!),
      );
      results.priceAssetResourceNames = await step("create-price-asset", () =>
        createPriceAsset(client, customerId, brief, results.campaignId!),
      );
      results.structuredSnippetResourceNames = await step("create-structured-snippet", () =>
        createStructuredSnippet(client, customerId, brief, results.campaignId!),
      );
    }
    for (const [idx, briefAg] of brief.adGroups.entries()) {
      const slot = results.adGroups[idx]!;
      const existingAdGroup = await step(
        "find-existing-ad-group",
        () => findExistingAdGroup(client, customerId, briefAg, results.campaignId!),
        briefAg.name,
      );
      if (existingAdGroup) {
        slot.adGroupId = existingAdGroup;
      } else {
        slot.adGroupId = await step(
          "create-ad-group",
          () => createAdGroup(client, customerId, briefAg, results.campaignId!),
          briefAg.name,
        );
      }
      // Sequential, not concurrent: two mutateResources calls creating RSAs on the
      // same brand-new ad group at once get rejected by the API with
      // CONCURRENT_MODIFICATION ("Multiple requests were attempting to modify the
      // same resource at once"). `ids` is assigned into `slot` up front and pushed
      // into in place, so a failure partway through still leaves every id that DID
      // land recorded — findMissingResponsiveSearchAds finds those same RSAs again
      // on a rerun (by content) instead of creating a duplicate on top of them.
      slot.responsiveSearchAdIds = await step(
        "create-responsive-search-ad",
        async () => {
          const missing = await findMissingResponsiveSearchAds(
            client,
            customerId,
            slot.adGroupId!,
            briefAg.responsiveSearchAds,
          );
          const ids: string[] = [];
          slot.responsiveSearchAdIds = ids;
          for (const rsa of missing) {
            ids.push(await createResponsiveSearchAd(client, customerId, rsa, slot.adGroupId!));
          }
          return ids;
        },
        briefAg.name,
      );
      // Idempotent by content (findMissingKeywords), and run for every ad group —
      // new or reused — not just newly-created ones: an ad group that survived an
      // earlier run which died before reaching this step (e.g. the RSA step above,
      // which runs first) would otherwise be permanently skipped on every retry.
      slot.keywordResourceNames = await step(
        "create-keywords",
        async () => {
          const missing = await findMissingKeywords(client, customerId, slot.adGroupId!, briefAg.keywords);
          return createKeywords(client, customerId, missing, slot.adGroupId!);
        },
        briefAg.name,
      );
    }
  } catch (exc) {
    if (exc instanceof StepError) {
      const failure: Failure = {
        step: exc.step,
        message: exc.message,
        raw: exc.raw,
        adGroupName: exc.adGroupName,
      };
      return makeRunOutcome(results, failure, executorVersion);
    }
    throw exc;
  }
  return makeRunOutcome(results, null, executorVersion);
}

// ---------- Display ----------

/** Per-ad-group record of what {@link publishDisplay} created (or reused). */
export interface DisplayExecAdGroup {
  name: string;
  adGroupId: string | null;
  audienceResourceNames: readonly string[];
  responsiveDisplayAdIds: readonly string[];
}

/** What {@link publishDisplay} created. */
export interface DisplayExecResults {
  budgetId: string | null;
  campaignId: string | null;
  imageAssetResourceNames: readonly string[];
  adGroups: DisplayExecAdGroup[];
}

/**
 * Publish a display brief: budget → Display campaign (PAUSED) → US/CA + devices →
 * image assets → per ad group (ad group → audiences → responsive display ads, PAUSED).
 * `images` must hold every image the brief references, already checked against the
 * slot specs (see images.ts). Same reuse/idempotency contract and the same deliberate
 * mutable-accumulator exception as {@link publishV1}.
 */
export async function publishDisplay(
  client: AdsClient,
  customerId: string,
  brief: DisplayBrief,
  images: ImageLibrary,
  archiveExisting = false,
): Promise<RunOutcome<DisplayExecResults>> {
  const executorVersion = sdkVersion();
  const results: DisplayExecResults = {
    budgetId: null,
    campaignId: null,
    imageAssetResourceNames: [],
    adGroups: brief.adGroups.map((ag) => ({
      name: ag.name,
      adGroupId: null,
      audienceResourceNames: [],
      responsiveDisplayAdIds: [],
    })),
  };
  try {
    if (archiveExisting) {
      await step("archive-existing-campaign", () =>
        archiveCampaignsByName(client, customerId, brief.campaign.name),
      );
    }
    const existingCampaign = archiveExisting
      ? null
      : await step("find-existing-campaign", () => findExistingCampaign(client, customerId, brief));
    if (existingCampaign) {
      results.campaignId = existingCampaign[0];
      results.budgetId = existingCampaign[1];
    } else {
      results.budgetId = await step("create-campaign-budget", () => createCampaignBudget(client, customerId, brief));
      results.campaignId = await step("create-display-campaign", () =>
        createDisplayCampaign(client, customerId, brief, results.budgetId!),
      );
      await step("target-location", () => targetUsCanada(client, customerId, results.campaignId!));
      // Display defaults to every device (unlike search's mobile exclusion) — most display inventory is mobile.
      await step("target-devices", () =>
        targetDevices(client, customerId, results.campaignId!, brief.campaign.devices ?? [...ALL_DEVICES]),
      );
    }
    const assets = await step("create-image-assets", () => createImageAssets(client, customerId, images));
    results.imageAssetResourceNames = [...assets.values()];
    for (const [idx, briefAg] of brief.adGroups.entries()) {
      const slot = results.adGroups[idx]!;
      slot.adGroupId =
        (await step(
          "find-existing-ad-group",
          () => findExistingAdGroup(client, customerId, briefAg, results.campaignId!),
          briefAg.name,
        )) ??
        (await step(
          "create-ad-group",
          () => createDisplayAdGroup(client, customerId, briefAg, results.campaignId!),
          briefAg.name,
        ));
      slot.audienceResourceNames = await step(
        "create-audiences",
        () => createMissingAudiences(client, customerId, briefAg, slot.adGroupId!),
        briefAg.name,
      );
      // Sequential for the same CONCURRENT_MODIFICATION reason as publishV1's RSAs.
      slot.responsiveDisplayAdIds = await step(
        "create-responsive-display-ad",
        async () => {
          const missing = await findMissingResponsiveDisplayAds(
            client,
            customerId,
            slot.adGroupId!,
            briefAg.responsiveDisplayAds,
          );
          const ids: string[] = [];
          slot.responsiveDisplayAdIds = ids;
          for (const ad of missing) {
            ids.push(await createResponsiveDisplayAd(client, customerId, ad, slot.adGroupId!, assets));
          }
          return ids;
        },
        briefAg.name,
      );
    }
  } catch (exc) {
    if (exc instanceof StepError) {
      const failure: Failure = { step: exc.step, message: exc.message, raw: exc.raw, adGroupName: exc.adGroupName };
      return makeRunOutcome(results, failure, executorVersion);
    }
    throw exc;
  }
  return makeRunOutcome(results, null, executorVersion);
}
