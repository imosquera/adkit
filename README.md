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
| `/adkit update` | Publishing | Apply headline/description rewrites and sitelink changes to live ads |
| `/adkit audit` | Analysis | Audit live ad strength and surface actionable fixes (read-only) |
| `/adkit report` | Analysis | Pull performance metrics and generate a markdown + Chart.js dashboard |
| `/adkit research` | Analysis | Research competitors + keywords: seed from competitors/campaign, expand to adjacent keywords/competitors, rank the landscape by theme (volume, cost, competitiveness) |
| `/adkit gtm` | Planning | Generate keyword tiers and RSA ad copy for a processed idea |

## Setup

Secrets are stored in GCP Secret Manager and rendered locally on demand — nothing is committed to the repo.

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
