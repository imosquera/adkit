---
name: adkit
description: "Manage Google Ads search campaigns — create, audit, update, report, research, and GTM keyword/ad-copy generation. Usage: /adkit create | /adkit audit | /adkit update | /adkit report | /adkit research | /adkit gtm"
argument-hint: "create | audit | update | report | research | gtm"
user-invocable: true
---

# Ads Skill Router

Read the [shared conventions](reference/conventions.md) once before any subcommand — it covers credentials, customer-id resolution, and the JSON envelope contract.

---

## Routing Rules

**No argument:** Do not assume or default. Ask the user which subcommand they want and show the commands table below.

**First word matches a command** (see table below): Read that command's reference file immediately and follow its instructions. Everything after the command name is the target or additional context.

**First word doesn't match any command, but intent clearly maps to one:** Read that command's reference file and proceed as if explicitly invoked.

**Intent could map to two commands:** Ask once which the user means. Do not guess.

**IMPORTANT:** Whichever command is resolved, you MUST read its reference file before doing anything else. Non-optional. The reference file defines the full workflow — without it you will skip steps the user expects.

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
| `research` | Analysis | Research competitors + keywords: seed from competitors/campaign, expand to adjacent keywords/competitors, rank the landscape by theme (volume, cost, competitiveness) | [reference/research.md](reference/research.md) |
| `gtm` | Planning | Generate keyword tiers and RSA ad copy for a processed idea | [reference/gtm.md](reference/gtm.md) |
