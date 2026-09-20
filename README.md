# adkit

A collection of Claude Code skills for managing Google Ads campaigns.

## Install

```bash
npx skills add git@github.com:imosquera/adkit.git
```

## Skills

`adkit` is a single skill that routes to six subcommands. Invoke with `/adkit <command>` (e.g. `/adkit audit`); run bare `/adkit` to be prompted for one.

| Command | Category | Description |
|---|---|---|
| `/adkit create` | Publishing | Publish a new search campaign from a processed idea markdown file |
| `/adkit update` | Publishing | Apply a plan to live campaigns: ad copy, extensions, keywords, budget, bidding, geo targeting, on/off |
| `/adkit audit` | Analysis | Audit live ad strength and surface actionable fixes (read-only) |
| `/adkit report` | Analysis | Pull performance metrics and generate a markdown + Chart.js dashboard |
| `/adkit research` | Analysis | Research competitors + keywords: seed from competitors/campaign, expand to adjacent keywords/competitors, rank the landscape by theme (volume, cost, competitiveness) |
| `/adkit gtm` | Planning | Generate keyword tiers and RSA ad copy for a processed idea |

## Setup

Four credentials — developer token, OAuth client id, client secret, refresh token (plus an
optional PageSpeed key) — are stored in GCP Secret Manager and rendered locally on demand;
nothing is committed to the repo.

The two customer ids are **not** credentials. `target_customer_id` (the account you operate
on) and `mcc_customer_id` (the manager you reach it through, if any) are 10-digit Google Ads
account numbers printed in the Ads UI, so they live in the **committed** `adkit.yaml` as
ordinary preferences set by `ads.sh init`, alongside the output directories and the read
backend. The credentials go in a separate, git-ignored `.adkit.secrets.yaml` (or, better,
somewhere outside the repo entirely via `ADKIT_CONFIG`). `render-yaml` never fetches or overwrites them. Omit `mcc_customer_id`
for an account you reach directly, without a manager — absent is the correct setting there,
and nothing will ever prompt you for it. If `target_customer_id` is missing when a command
needs it, you are asked once on a terminal and the answer is saved; in CI the command exits
non-zero naming the field instead of guessing.

**Scaffold the local config (once per project):**
```bash
ads.sh init
```

**One-time secret seed:**
```bash
ads.sh bootstrap-secrets
```

**Render credentials (once per machine):**
```bash
ads.sh render-yaml
```

**Preflight check (once per session):**
```bash
ads.sh preflight
```

Set `GOOGLE_ADS_SECRETS_PROJECT` to override the default GCP project.
