---
description: "Shared reference for the /ads:* skills (invocation, customer-id resolution, JSON envelope, credentials, labor division). Not a command — loaded on demand by the ads skills, not invoked directly."
user-invocable: false
disable-model-invocation: true
---

# Ads skill conventions (shared reference)

Shared mechanics for the `/ads:*` lifecycle (`keywords → create → audit → fix → report`). The individual skills link here instead of re-inlining this boilerplate. Read it once when running any ads skill.

## Invoking `ads.sh`

Every ads subcommand goes through one wrapper:

```bash
.claude/commands/ads/scripts/ads.sh <subcommand> [args…]
```

- `ads.sh` resolves `uv` (`brew install uv`), auto-creates the Python venv at `~/.cache/lead-drop/ads-skill-venv/` on first run via `uv sync`, then dispatches to `ads_skill.bin.*`.
- **No persistent server, no MCP** — every invocation is a single Python process.
- Subcommands: `preflight`, `create`, `audit`, `update`, `keyword-ideas`, `report`, `render-yaml`, `bootstrap-secrets` (`apply-fixes` is a deprecated alias for `update`).

## Customer-id vs login-customer-id

- **`--customer <id>`** (a.k.a. `customerId` / `GOOGLE_ADS_CUSTOMER_ID`) is the **leaf account** the operation reads or mutates. Default leaf is Baymo (`8911925499`).
- **`--login-customer-id <MCC>`** (a.k.a. `--manager`) is only needed when the leaf is reached *through* a manager account. **Omit it for directly-accessible accounts** — the default `None` is correct for Baymo and most clients. Vonteva MCC is `4193158021`.
- **Format rule:** every customer/manager id is **10 digits, no dashes** (`8911925499`, not `891-192-5499`). Strip any dashes a human typed before passing them through.

## JSON envelope contract

Machine-readable subcommands return a single JSON object on **stdout**:

```json
{ "ok": true,  "message": …, /* command-specific payload */ }
{ "ok": false, "error": { "step": "…", "message": "…" } }
```

- On `"ok": false`, surface `error.step` and `error.message` **verbatim** to the operator; do not paraphrase or fabricate a result.
- Human-readable summaries (tables, progress) go to **stderr** — redirect stdout (`> /tmp/out.json`) when you want only the payload.
- Non-zero exit always pairs with an `ok:false` / `failure` payload that names the failing step.

## Credentials & preflight

- Credentials live in `~/.config/google-ads/google-ads.yaml` (or the `GOOGLE_ADS_CREDENTIALS` env). Secrets are in Google Secret Manager (project `vonteva-prod`).
- If the yaml is missing, render it once: `ads.sh render-yaml` (one-time seed of the secrets: `ads.sh bootstrap-secrets`).
- Run **`ads.sh preflight` once per session**. Non-zero exit ⇒ **stop**; surface its `step` and `message` verbatim. On success it confirms credentials work and the target customer is in the accessible list.

## Division of labor — Python is deterministic, the model is creative

- **Python is deterministic.** Counting/validation, finding duplicates, reading Google's own `ad_strength` / `action_items`, computing the per-ad `pathToExcellent`, schema validation, and all live mutations are the executor's job (`ads.sh audit`, `ads.sh update`, `ads.sh create`). It never invents copy.
- **The model is creative.** Authoring RSA headlines/descriptions tuned to an ad group's real keyword, tiering keywords by intent, picking sitelink/callout text, and judging *which* fixes to apply are yours. Templated, keyword-agnostic copy is exactly what grades POOR — write to the specific keyword.
- **Applying is Python's again.** You hand the executor a structured plan (a brief or a fixes plan); it re-validates against the rules and mutates. Dry-run is the default; mutation needs an explicit `--apply` (or the live `create`).
