# `adbriefs/` — campaign briefs (local source of truth)

One YAML brief per campaign, named `<campaign-slug>.yaml` (a kebab-case slug of the
campaign name). Each file holds that campaign's **full current state** — campaign
settings, ad groups, keywords, RSAs, negatives, budget — in the same format
`/adkit create` publishes.

- **Written by** `/adkit create`, which persists the filled brief here *before*
  publishing and re-syncs it after a successful publish.
- **The review gate:** whenever a campaign changes, the diff between the existing
  brief and the proposed one is shown first; a live mutation runs only after it
  (dry-run by default). See
  [`skills/adkit/reference/conventions.md`](../skills/adkit/reference/conventions.md)
  → *`adbriefs/` — the local source of truth + diff-before-apply gate*.
- **Do not hand-edit a brief while an apply is in flight** — the file is the declared
  intent that the next diff is computed against.
