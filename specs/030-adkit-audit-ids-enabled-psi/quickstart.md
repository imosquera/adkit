# Quickstart / Validation: `/adkit audit` keyword IDs + PSI diagnosis

Runnable checks that prove the feature works. Implementation detail lives in
`plan.md` and `tasks.md`; this is a validation guide.

## Prerequisites

- `cd skills/adkit/scripts && npm install` (first run only).
- For the PSI slice: an operator-supplied PageSpeed Insights API key exported as
  `PAGESPEED_API_KEY` (or passed via `--psi-key`). Absent this, the PSI slice
  degrades gracefully and the rest of the audit is unaffected.

## US1 — keyword `adGroupId` + `matchType` on every keyword row

1. Unit level:
   ```bash
   cd skills/adkit/scripts && npx vitest run
   ```
   Expected: `gaql/builders.test.ts` asserts `auditKeywordMetricsQuery` selects
   `ad_group.id` and `ad_group_criterion.keyword.match_type` (and still contains
   `ad_group_criterion.status = 'ENABLED'`); `audit/rows.test.ts` asserts
   `normalizeKeywordMetricsRow` carries `adGroupId` (number) and `matchType`
   (string or null when absent).
2. Live (optional, needs Google Ads creds):
   ```bash
   ads.sh audit --customer <CUSTOMER_ID> --days 30 | jq '.keywordCpc'
   ```
   Expected: every keyword row carries a numeric `adGroupId` and a `matchType`,
   so a keyword pause plan is authorable with **no** `report` round-trip.

## US2 — ENABLED filter regression-guard (confirmation)

```bash
cd skills/adkit/scripts && npx vitest run gaql/builders.test.ts
```
Expected: the existing guard test ("counts only ENABLED keywords…") passes and
`auditKeywordMetricsQuery(30, ["12345"]).conditions` contains
`ad_group_criterion.status = 'ENABLED'`.

## US3 — PageSpeed Insights on below-average landing pages

1. No key present → graceful skip:
   ```bash
   unset PAGESPEED_API_KEY
   ads.sh audit --customer <CUSTOMER_ID> --days 30 | jq '.psi'
   ```
   Expected: audit exits successfully; the report notes PSI was skipped for lack
   of a credential; no external PSI call is made.
2. Key present + a below-average landing page:
   ```bash
   export PAGESPEED_API_KEY=<key>
   ads.sh audit --customer <CUSTOMER_ID> --days 30 | jq '.psi'
   ```
   Expected: for each distinct final URL scoring `landing_page_experience ≤ 2`,
   a `psi` entry with `lcpMs`, `renderBlocking[]`, and `unusedJs[]`; a failed
   URL appears as `{ url, error }` and does not abort the run; a URL is hit at
   most once even if shared across ad groups.
3. Unit level:
   ```bash
   cd skills/adkit/scripts && npx vitest run lib/psi.test.ts
   ```
   Expected: a captured PSI JSON fixture parses to `PsiResult`; threshold and
   dedup logic verified without any network call.

## Operator runbook — temporary PSI key (out of scope for the audit, documented here)

The issue's temp-key lifecycle is an **operator** action, not audit behavior:

```bash
# create → use → delete an unrestricted key for a one-off PSI batch
KEY=$(gcloud services api-keys create --display-name adkit-psi-tmp --format='value(keyString)')
PAGESPEED_API_KEY="$KEY" ads.sh audit --customer <CUSTOMER_ID> --days 30
gcloud services api-keys delete <KEY_ID>   # clean up when done
```

Prefer a long-lived restricted key scoped to the PageSpeed Insights API in a
credentials store over creating/deleting keys per run.

## Gate summary

- `npx vitest run` green (new + existing tests).
- `tsc --noEmit` / lint clean.
- `constitution_audit.py validate plan.md` exits zero (no-op; no principles).
- Parse-boundary scanner (if run by `/speckit-implement`) finds a real
  `parsePsiResponse` boundary in `lib/psi.ts`.
