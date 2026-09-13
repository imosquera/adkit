---
description: "Scaffold this project's local config — the committed adkit.yaml plus the git-ignored .adkit.secrets.yaml — via a one-time interactive prompt."
argument-hint: ""
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## Role

You run the one-time setup that scaffolds the two local config files every other `/adkit` subcommand reads. This is the first thing to run in a new project, before `preflight` or any other subcommand.

| File | Tracked | Contents |
| --- | --- | --- |
| `adkit.yaml` | **committed** | `mcc_customer_id`, `target_customer_id`, `secrets_project`, `read_backend`, `reports_dir`, `briefs_dir`, `ideas_dir` |
| `.adkit.secrets.yaml` | git-ignored, mode 0600 | `developer_token`, `client_id`, `client_secret`, `refresh_token`, `psi_api_key` |

That table is a **Google** project. A **Meta** project (`platform: meta`) writes the same two files with Meta's fields instead — see [Meta projects](#meta-projects) below.

The preferences are committed because they describe the *project* — a collaborator, a CI job and a git worktree all want the same values, and none of them is a secret. The credentials are per-machine and never committed.

Mechanics (the JSON envelope, credentials, customer-id resolution) are in **`reference/conventions.md`** — read it once if you haven't already.

## Execution

```bash
ads.sh init
```

- **Platform is resolved, not prompted**: `--platform` → `ADKIT_PLATFORM` → `platform` in an existing `adkit.yaml` → `google`. With none of those set, `init` runs the Google scaffold described in the rest of this list, unchanged; `ads.sh init --platform meta` runs the [Meta scaffold](#meta-projects). Only the resolved platform's fields are prompted for and written. An unknown value is refused with an `ok:false` envelope (`step: "platform"`) before any prompt.
- **Interactive**: prompts once for each field of the file(s) it is about to write — the Google Ads credentials first (`developer_token`, `client_id`, `client_secret`, `refresh_token`, `psi_api_key`; read without echo, except the public `client_id`), then the non-secret project preferences (`mcc_customer_id`, `target_customer_id`, `secrets_project`, `read_backend`, `reports_dir`, `briefs_dir`, `ideas_dir`). A blank answer keeps the field's default (shown inline in the prompt); a field left blank with no default is simply omitted from the file.
- **Two files, written separately.** Preferences go to `adkit.yaml` (world-readable, commit it); credentials go to `.adkit.secrets.yaml` at mode 0600. Neither file can pick up the other's fields — the writer emits only the keys that belong to it.
- **Keeping the credentials out of the repo entirely is the stronger option.** `export ADKIT_CONFIG=~/.config/adkit/<project>.secrets.yaml` before running `init` and the credentials are written there instead: nothing in the tree can commit them, and they survive into git worktrees (which an ignored root file never does). `adkit.yaml` is still written to the repo root.
- **The ids live in the committed yaml; only the real credentials come from Secret Manager.** `bootstrap-secrets` seeds and `render-yaml` fetches exactly `developer_token`, `client_id`, `client_secret`, `refresh_token` (plus the optional `psi_api_key`). `target_customer_id` and `mcc_customer_id` are account numbers — they are set here or by hand-editing `adkit.yaml`, and `render-yaml` never fetches or overwrites them. Omit `mcc_customer_id` entirely for a directly-accessible account (no manager); leaving it blank is correct, not incomplete.
- **If you skip `target_customer_id` here, the first command that needs it will ask.** Any subcommand that resolves no target id — no flag, no `GOOGLE_ADS_CUSTOMER_ID`, no yaml entry — prompts once on a terminal, validates the answer (10 digits, dashes stripped), writes it into `adkit.yaml`, and carries on; you are not asked again. With no terminal (CI, a pipe) it does not prompt: it exits non-zero with the `ok:false` envelope naming the field and the config path. `mcc_customer_id` is never prompted for — absent means "directly accessible".
- **Create-if-missing, per file**: an existing file is printed about and left untouched — `init` never overwrites. If only one of the two is missing, only that file's fields are prompted for. To redo one, delete it (or hand-edit it directly) and rerun.
- **`.gitignore`**: every run makes sure `.gitignore` excludes `/.adkit.secrets.yaml` **and** the legacy `/.adkit.yaml` (adding whichever entry is missing), since both carry real credentials. This happens even when the config files already existed and `init` otherwise no-ops, so a stale or unprotected `.gitignore` gets retrofitted. `adkit.yaml` is deliberately *not* ignored — it is meant to be committed.
- **The guardrail**: before writing the credentials, `init` checks that the target path is not committable. A path git does not ignore, or already tracks, is **refused** with an `ok:false` envelope (`step: "secrets-path"`) naming the path, the reason, and the fix — nothing is written and nothing is prompted for. A path inside a tracked directory (a vendored `.agents/skills/adkit`, say) is warned about loudly. See `reference/conventions.md` for the full table.
- **A legacy `.adkit.yaml`** (the old single combined file) stops the scaffold: `init` leaves it exactly as it is — it still works, and still out-ranks both new files — and prints a deprecation notice naming the two files to create and which fields go in each. The hand-migration is: move the five credential fields into `.adkit.secrets.yaml` (`chmod 600`), the rest into `adkit.yaml`, then delete `.adkit.yaml`. There is no automated migration.
- Run it from the project root — `adkit.yaml` is written to `process.cwd()`, and `.adkit.secrets.yaml` alongside it unless `ADKIT_CONFIG` moves it.

## Meta projects

Run `ads.sh init --platform meta` (or export `ADKIT_PLATFORM=meta` first) and `init` scaffolds a Meta project. Every rule above — create-if-missing per file, `.gitignore` retrofit, the `secrets-path` guardrail, `ADKIT_CONFIG`, the legacy `.adkit.yaml` stop — applies unchanged; only the fields differ.

```bash
ads.sh init --platform meta
```

| File | Tracked | Meta contents |
| --- | --- | --- |
| `adkit.yaml` | **committed** | `platform: meta`, `meta_ad_account_id`, `meta_page_id`, `meta_pixel_id`, `secrets_project`, `reports_dir`, `briefs_dir`, `ideas_dir` |
| `.adkit.secrets.yaml` | git-ignored, mode 0600 | `meta_access_token`, `meta_app_id`, `meta_app_secret`, `psi_api_key` |

- **Prompt order**: the Meta credentials first (`meta_access_token`, read without echo; `meta_app_id`, optional; `meta_app_secret`, optional and read without echo — it enables `appsecret_proof` on every request; `psi_api_key`, optional and read without echo — it enables `audit`'s PageSpeed Insights landing-page diagnosis), then the preferences (`meta_ad_account_id`, `meta_page_id`, `meta_pixel_id`, `secrets_project`, `reports_dir`, `briefs_dir`, `ideas_dir`). No Google Ads field is asked for, and `read_backend` is Google-only.
- **`platform: meta` is written to `adkit.yaml`** so every later command takes the Meta path without a flag. A Google project never writes a `platform` key — absent already means `google`.
- **`meta_access_token`** is a system-user (or long-lived user) access token with `ads_read` and `ads_management`. It is the only required Meta credential.
- **`meta_ad_account_id`** accepts `1234567890` or `act_1234567890`. `init` stores it exactly as typed and does not check it; every Meta command parses it into `act_<digits>` when it reads it, and a malformed value fails there with `step: "ad-account"`, naming the field. If you skip it here, the first Meta command that needs it asks once on a terminal and saves it to `adkit.yaml` (off a terminal: `ok:false`, `step: "ad-account"`).
- **`meta_page_id`** (the Facebook Page ads are published as) is needed by `create`; **`meta_pixel_id`** (the pixel / dataset id) by conversion campaigns. Both are optional here — a Meta brief can set them itself. A non-numeric value fails later with `step: "config"`.
- **Credentials from Secret Manager**: `ads.sh bootstrap-secrets --platform meta` prompts for `meta-access-token` and `meta-app-secret` only, skipping a blank answer. `ads.sh render-yaml` on a Meta project **requires** `meta-access-token` (it aborts without it) and fetches `meta-app-secret` (and any other secret) when present. Both commands resolve the platform the same way `init` does, so `platform: meta` in `adkit.yaml` makes the flag unnecessary.
- **Next step**: `ads.sh preflight` (the `platform: meta` in `adkit.yaml` routes it) runs `credentials` → `auth` → `access` → `permissions` and names the first step that fails — an inactive ad account or a missing `ads_read` / `ads_management` permission is reported by name. See [Meta credentials](conventions.md#meta-credentials) and [Meta ad account id](conventions.md#meta-ad-account-id-act_). For the strategy behind the account, start with the [Meta fundamentals](meta/1-fundamentals.md) playbook.

## After `init`

- If you don't yet have the Google Ads credentials themselves seeded in Secret Manager, run `ads.sh bootstrap-secrets` once.
- `ads.sh render-yaml` pulls the credential fields from Secret Manager into `.adkit.secrets.yaml` (only that file, only those fields), leaving the preferences `init` set — the customer ids included — untouched in `adkit.yaml`.
- Run `ads.sh preflight` once per session afterward to confirm the credentials work and the target customer is reachable.

## Report

Tell the operator which files were written (or which already existed and were left alone), and whether `.gitignore` was updated. If the guardrail refused, surface its `step`, `reason`, and `message` verbatim — the credentials were not written anywhere. Point them at `bootstrap-secrets`/`render-yaml`/`preflight` as the next steps if credentials aren't live yet.
