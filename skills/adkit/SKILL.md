---
name: adkit
description: "Manage Google Ads and Meta (Facebook/Instagram) Ads campaigns — init project config, create, audit, update, report, plus Google-only research and GTM keyword/ad-copy generation. Usage: /adkit init | /adkit create | /adkit audit | /adkit update | /adkit report | /adkit research | /adkit gtm"
argument-hint: "init | create | audit | update | report | research | gtm"
user-invocable: true
---

# Ads Skill Router

Read the [shared conventions](reference/conventions.md) once before any subcommand — it covers the platform switch, credentials, customer-id / ad-account-id resolution, and the JSON envelope contract.

---

## Routing Rules

**No argument:** Do not assume or default. Ask the user which subcommand they want and show the commands table below.

**First word matches a command** (see table below): Read that command's reference file immediately and follow its instructions. Everything after the command name is the target or additional context.

**First word doesn't match any command, but intent clearly maps to one:** Read that command's reference file and proceed as if explicitly invoked.

**Intent could map to two commands:** Ask once which the user means. Do not guess.

**IMPORTANT:** Whichever command is resolved, you MUST read its reference file before doing anything else. Non-optional. The reference file defines the full workflow — without it you will skip steps the user expects.

---

## Platform Routing (Google vs Meta)

Every command runs against one ad platform: `google` or `meta`. The command name does not change — the platform does.

- **Resolution:** `--platform google|meta` on the command line, then `ADKIT_PLATFORM`, then `platform:` in `adkit.yaml`, then `google`. A project with no `platform` key behaves exactly as it always has. See [Platform switch](reference/conventions.md#platform-switch-google-vs-meta).
- **Same entry points.** `init`, `preflight`, `create`, `audit`, `update`, and `report` each take the Meta path when the resolved platform is `meta`; you invoke them the same way (`ads.sh report --platform meta`). For `update`, a plan carrying `platform: meta` also selects the Meta path.
- **Read the command's Meta section.** Each reference file keeps the Google workflow and adds a clearly headed Meta section; when the platform is `meta`, follow that section. The Meta playbook (fundamentals, audience mining, account structure, creative, exclusions, analysis) lives under [reference/meta/](reference/meta/1-fundamentals.md).
- **Google-only:** `research`, `keyword-ideas`, and `gtm` have no Meta equivalent (Meta has no keyword planner). `research` and `keyword-ideas` refuse with an `ok:false` envelope (`step: "platform"`) when the resolved platform is `meta`; do not attempt `gtm` for a Meta project either.
- **Mixed projects:** a project using Google for one command and Meta for another passes `--platform` on the command that differs from the `adkit.yaml` default.

---

## Execution Model

**Use subagents aggressively.** Every phase that can run independently must be fanned out to a subagent. Do not run phases sequentially when they can run in parallel.

---

## Commands

| Command | Category | Description | Reference |
| --- | --- | --- | --- |
| `init` | Setup | One-time interactive scaffold of `adkit.yaml` (committed preferences) + `.adkit.secrets.yaml` (git-ignored credentials); asks for the platform (`google`/`meta`) first | [reference/init.md](reference/init.md) |
| `create` | Publishing | Publish a new search campaign from a processed idea markdown file, or a display campaign (responsive display ads) from a `type: display` brief; on Meta, a paused campaign → ad sets → ads from a `type: meta` brief | [reference/create.md](reference/create.md) |
| `audit` | Analysis | Audit live ad strength (Google) or learning, fatigue, fragmentation, breakdown waste, exclusions and conversion signal (Meta), and surface actionable fixes (read-only) | [reference/audit.md](reference/audit.md) |
| `update` | Publishing | Apply headline/description rewrites and sitelink changes to live ads; on Meta, budgets, status, exclusions, creative enhancements and text pools | [reference/update.md](reference/update.md) |
| `report` | Analysis | Pull performance metrics and generate a markdown + Chart.js dashboard | [reference/report.md](reference/report.md) |
| `research` | Analysis | Research competitors + keywords: seed from competitors/campaign, expand to adjacent keywords/competitors, rank the landscape by theme (volume, cost, competitiveness). Google-only | [reference/research.md](reference/research.md) |
| `gtm` | Planning | Generate keyword tiers and RSA ad copy for a processed idea. Google-only | [reference/gtm.md](reference/gtm.md) |
