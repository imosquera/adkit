/**
 * IO entry: `ads.sh keywords [--json] [--customer ID] [--manager ID]` — every
 * non-removed positive keyword with its match type, ad group, campaign and status.
 * Tab-separated table by default; a JSON array with `--json`.
 */

import { parseArgs } from "node:util";
import { enums } from "google-ads-api";
import type { MccCustomerId } from "../cli/args.js";
import { isMainModule } from "../cli/entry.js";
import { emitJson, errorEnvelope } from "../cli/output.js";
import { enumName } from "../ads/enums.js";
import type { AdsClient, GaqlRow } from "../lib/auth.js";
import { runQuery } from "./gaql.js";

export const KEYWORDS_QUERY =
  "SELECT campaign.name, campaign.status, ad_group.name, ad_group.status, " +
  "ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status " +
  "FROM ad_group_criterion " +
  "WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE " +
  "AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' " +
  "ORDER BY campaign.name, ad_group.name, ad_group_criterion.keyword.text";

export interface KeywordRow {
  campaign: string;
  adGroup: string;
  keyword: string;
  matchType: string | null;
  status: string | null;
  adGroupStatus: string | null;
  campaignStatus: string | null;
}

type Enum = string | number | null | undefined;
type Row = {
  campaign?: { name?: string; status?: Enum };
  ad_group?: { name?: string; status?: Enum };
  ad_group_criterion?: { status?: Enum; keyword?: { text?: string; match_type?: Enum } };
};

/** Flatten SDK rows, decoding the numeric enums the SDK returns. */
export function toKeywordRows(rows: GaqlRow[]): KeywordRow[] {
  return (rows as Row[]).map((r) => ({
    campaign: r.campaign?.name ?? "",
    adGroup: r.ad_group?.name ?? "",
    keyword: r.ad_group_criterion?.keyword?.text ?? "",
    matchType: enumName(enums.KeywordMatchType, r.ad_group_criterion?.keyword?.match_type),
    status: enumName(enums.AdGroupCriterionStatus, r.ad_group_criterion?.status),
    adGroupStatus: enumName(enums.AdGroupStatus, r.ad_group?.status),
    campaignStatus: enumName(enums.CampaignStatus, r.campaign?.status),
  }));
}

export async function main(argv: string[], clientFactory?: (login: MccCustomerId) => AdsClient): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean" }, customer: { type: "string" }, manager: { type: "string" } },
  });
  const rows = await runQuery(KEYWORDS_QUERY, values, clientFactory);
  if (rows === null) {
    return 1;
  }
  const keywords = toKeywordRows(rows);
  if (values.json) {
    emitJson(keywords);
    return 0;
  }
  const lines = [["campaign", "ad_group", "keyword", "match_type", "status"], ...keywords.map((k) => [k.campaign, k.adGroup, k.keyword, k.matchType ?? "", k.status ?? ""])];
  process.stdout.write(lines.map((l) => l.join("\t")).join("\n") + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((exc) => {
      emitJson(errorEnvelope(String((exc as { message?: unknown })?.message ?? exc)));
      process.exit(1);
    });
}
