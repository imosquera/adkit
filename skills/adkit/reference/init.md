---
description: "Scaffold this project's local config (.adkit.yaml) — Google Ads credentials plus non-secret preferences — via a one-time interactive prompt."
argument-hint: ""
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## Role

You run the one-time setup that scaffolds `.adkit.yaml` — the single local config file every other `/adkit` subcommand reads. This is the first thing to run in a new project, before `preflight` or any other subcommand.

Mechanics (the JSON envelope, credentials, customer-id resolution) are in **`reference/conventions.md`** — read it once if you haven't already.

## Execution

```bash
ads.sh init
```

- **Interactive**: prompts once for each field in `lib/config.ts`'s `CONFIG_FIELDS` — the Google Ads credentials first (`developer_token`, `client_id`, `client_secret`, `refresh_token`, `login_customer_id`, `target_customer_id`; credential fields are read without echo), then the non-secret project preferences (`secrets_project`, `read_backend`, `reports_dir`, `briefs_dir`, `ideas_dir`). A blank answer keeps the field's default (shown inline in the prompt); a field left blank with no default is simply omitted from the file.
- **Create-if-missing**: if `.adkit.yaml` already exists, `init` prints a message and leaves it untouched — it never overwrites. To redo it, delete the file (or hand-edit it directly) and rerun.
- **`.gitignore`**: every run makes sure `.gitignore` excludes `.adkit.yaml` (adding the entry if it's missing), since the file carries real credentials. This happens even when the config file already existed and `init` otherwise no-ops, so a stale or unprotected `.gitignore` gets retrofitted.
- Run it from the project root — `.adkit.yaml` is written to `process.cwd()` (or the `ADKIT_CONFIG` path override).

## After `init`

- If you don't yet have the Google Ads credentials themselves seeded in Secret Manager, run `ads.sh bootstrap-secrets` once.
- `ads.sh render-yaml` pulls the credential fields from Secret Manager and merges them into `.adkit.yaml`, leaving the preferences `init` set untouched.
- Run `ads.sh preflight` once per session afterward to confirm the credentials work and the target customer is reachable.

## Report

Tell the operator which file was written (or that one already existed and was left alone), and whether `.gitignore` was updated. Point them at `bootstrap-secrets`/`render-yaml`/`preflight` as the next steps if credentials aren't live yet.
