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
  createKeywords,
  createNegativeKeywords,
  createPriceAsset,
  createResponsiveSearchAd,
  createSearchCampaign,
  createSitelinks,
  createStructuredSnippet,
  findExistingAdGroup,
  findExistingCampaign,
  targetDevices,
  targetUsCanada,
} from "./entities.js";
import { StepError, sdkVersion, step } from "./errors.js";
import type { AdsClient } from "../lib/auth.js";
import type { Brief, Failure } from "../lib/schema.js";

/** Per-ad-group record of what {@link publishV1} created (or reused). */
export interface ExecAdGroup {
  name: string;
  adGroupId: string | null;
  responsiveSearchAdId: string | null;
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
export interface RunOutcome {
  results: ExecResults;
  failure: Failure | null;
  executorVersion: string;
}

/** Build a fresh {@link ExecAdGroup} slot for `name`, nothing created yet. */
export function makeExecAdGroup(name: string): ExecAdGroup {
  return { name, adGroupId: null, responsiveSearchAdId: null, keywordResourceNames: [] };
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
export function makeRunOutcome(
  results: ExecResults,
  failure: Failure | null,
  executorVersion: string,
): RunOutcome {
  return { results, failure, executorVersion };
}

// ---------- Public API ----------

/**
 * Publish `brief` to `customerId` through `client`: create the campaign budget,
 * search campaign, its targeting + campaign-level assets, then each ad group with
 * its RSA and keywords. An existing campaign of the same name is reused (unless
 * `archiveExisting`, which archives same-named campaigns first and always creates
 * fresh). Newly-created ad groups get keywords; reused ones do not.
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
      let shouldCreateKeywords: boolean;
      if (existingAdGroup) {
        slot.adGroupId = existingAdGroup;
        shouldCreateKeywords = false;
      } else {
        slot.adGroupId = await step(
          "create-ad-group",
          () => createAdGroup(client, customerId, briefAg, results.campaignId!),
          briefAg.name,
        );
        shouldCreateKeywords = true;
      }
      slot.responsiveSearchAdId = await step(
        "create-responsive-search-ad",
        () => createResponsiveSearchAd(client, customerId, briefAg, slot.adGroupId!),
        briefAg.name,
      );
      if (shouldCreateKeywords) {
        slot.keywordResourceNames = await step(
          "create-keywords",
          () => createKeywords(client, customerId, briefAg, slot.adGroupId!),
          briefAg.name,
        );
      }
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
