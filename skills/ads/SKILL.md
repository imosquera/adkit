---
name: ads
description: "Manage Google Ads search campaigns — create, audit, update, report, and GTM keyword/ad-copy generation. Usage: /ads:create | /ads:audit | /ads:update | /ads:report | /ads:gtm"
argument-hint: "create | audit | update | report | gtm"
user-invocable: true
---

# Ads Skill Router

Read the [shared conventions](reference/conventions.md) once before any subcommand — it covers credentials, customer-id resolution, and the JSON envelope contract.

**Resolved subcommand:** read its reference file immediately and follow its instructions. The reference file defines the full workflow — do not proceed without it.

---

## Execution Model

**Use subagents aggressively.** Every phase that can run independently must be fanned out to a subagent. Do not run phases sequentially when they can run in parallel.

---

## Commands

| Command | Category | Description | Reference |
| --- | --- | --- | --- |
| `create` | Publishing | Publish a new search campaign from a processed idea markdown file | [reference/create.md](reference/create.md) |
| `audit` | Analysis | Audit live ad strength and surface actionable fixes (read-only) | [reference/audit.md](reference/audit.md) |
| `update` | Publishing | Apply headline/description rewrites and sitelink changes to live ads | [reference/update.md](reference/update.md) |
| `report` | Analysis | Pull performance metrics and generate a markdown + Chart.js dashboard | [reference/report.md](reference/report.md) |
| `gtm` | Planning | Generate keyword tiers and RSA ad copy for a processed idea | [reference/gtm.md](reference/gtm.md) |
