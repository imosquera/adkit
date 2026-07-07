# adkit

A collection of Claude Code skills for managing Google Ads campaigns.

## Install

```bash
npx skills add git@github.com:imosquera/adkit.git
```

## Skills

| Skill | Description |
|---|---|
| `/ads create` | Publish a new search campaign from a processed idea markdown file |
| `/ads audit` | Audit live ad strength and surface actionable fixes |
| `/ads update` | Apply headline/description rewrites and sitelink changes to live ads |
| `/ads report` | Pull performance metrics for a campaign |
| `/ads gtm` | Generate keyword tiers and RSA ad copy for a processed idea |

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
