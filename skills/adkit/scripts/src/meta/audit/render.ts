/**
 * stderr rendering for the Meta audit (plan D6): a pure `data → string[]` transform
 * over a `MetaScore` (see `scoring.ts`). Account-wide findings come first, then one
 * block per campaign in input order, findings high → low severity, each in the shared
 * `  ! issue: detail` line format with its entity, fix and playbook link beneath.
 * The IO shell (`meta/bin/audit.ts`) prints the lines with `emitLines`.
 *
 * Pure: no I/O, inputs are never mutated.
 */

import { ljust, rjust } from "../../audit/render.js";
import { bySeverity, type MetaFinding, type MetaScore, type MetaSeverity } from "./scoring.js";

export type RenderMetaAuditInput = {
  campaigns: readonly { id: string; name: string; status: string }[];
  score: MetaScore;
  windowDays: number;
};

const SEVERITIES: readonly MetaSeverity[] = ["high", "medium", "low"];

/** `high=1 medium=0 low=2`, counts right-justified so campaign headers line up. */
export const severityCounts = (findings: readonly MetaFinding[]): string =>
  SEVERITIES.map((s) => `${s}=${rjust(String(findings.filter((f) => f.severity === s).length), 2)}`).join(" ");

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The issue line plus its indented entity, fix and playbook lines. */
export const findingLines = (f: MetaFinding): string[] => [
  `  ! ${f.issue}: ${f.detail}`,
  `      ${ljust(`[${f.severity}]`, 8)} ${f.level} ${f.entityName} (${f.entityId})`,
  `      fix: ${f.fix}`,
  `      see: ${f.playbook}`,
];

/** A header with counts and the findings, or a single `— no issues` line when clean. */
const sectionLines = (header: string, findings: readonly MetaFinding[]): string[] =>
  findings.length === 0
    ? [`\n${header} — no issues`]
    : [
        `\n${header} — ${plural(findings.length, "finding")}: ${severityCounts(findings)}`,
        ...bySeverity(findings).flatMap(findingLines),
      ];

export const renderMetaAudit = (input: RenderMetaAuditInput): string[] => {
  const { campaigns, score, windowDays } = input;
  const perCampaign = campaigns.map((c) => score.campaigns[c.id] ?? []);
  const campaignTotal = perCampaign.reduce((sum, fs) => sum + fs.length, 0);
  const total = campaignTotal + score.account.length;
  const flagged = perCampaign.filter((fs) => fs.length > 0).length;
  return [
    `META AUDIT — last ${plural(windowDays, "day")}`,
    ...(score.account.length > 0 ? sectionLines("ACCOUNT", score.account) : []),
    ...campaigns.flatMap((c, i) => sectionLines(`${c.name} (${c.id}) [${c.status}]`, perCampaign[i] ?? [])),
    `\n${plural(total, "finding")} (${score.account.length} account-wide) · ${flagged}/${campaigns.length} campaigns flagged`,
  ];
};
