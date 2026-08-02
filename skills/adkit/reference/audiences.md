---
description: "Enumerate, create, and upload Google Ads audience segments (in-market, affinity, custom-intent, user-list/remarketing, customer-match). Read-only for list; create-custom-intent and upload-customer-match mutate. Attach a segment to a campaign via /adkit create's adGroups[].audienceSegments or /adkit update's audiences plan lever."
argument-hint: "list | create-custom-intent --name <name> [--keywords <csv>] [--urls <csv>] | upload-customer-match --file <path.csv> --list-name <name>"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## Role

This skill only manages **audience segments themselves** — enumerating what
exists on an account, creating a custom-intent audience from keyword/URL
seeds, and uploading a customer-match list. It does **not** attach a segment
to a campaign or ad group:

- To attach an audience segment while **creating** a new campaign, add it to
  an ad group's `audienceSegments` in the brief — see the `adGroups[].audienceSegments`
  row in `reference/create.md`.
- To attach or detach an audience segment on an **existing, live** ad group,
  use the `audiences` plan lever on `ads.sh update` — see the `audiences`
  bullet in `reference/update.md`.
- To launch a true remarketing campaign on the **Display Network**, set
  `campaign.networkSettings: "display-remarketing"` in the brief (requires at
  least one `audienceSegments` entry somewhere in the brief) — see
  `reference/create.md`.

Mechanics (ads.sh invocation, customer-id resolution, the JSON envelope,
credentials/preflight) are in **`reference/conventions.md`** — read it once.
Run `ads.sh preflight` once per session.

## `ads.sh audiences list`

Enumerate every audience segment available on a customer: user lists
(remarketing/customer-match), custom audiences (in-market, affinity,
custom-intent), combined audiences, and the newer unified `Audience`
resource.

```bash
ads.sh audiences list --customer <10-digit>
```

Output: `{ "ok": true, "audiences": [{ "id": <number>, "name": <string>, "type": "user-list" | "custom-audience" | "combined-audience" | "audience" }] }`.
An account with zero audiences returns an empty array — not an error. Use the
returned `id` as the `audienceId` in a brief's `adGroups[].audienceSegments`
or a plan's `audiences` lever.

## `ads.sh audiences create-custom-intent`

Create a custom-intent/custom-segment audience from keyword and/or URL
seeds — both accepted together in a single call (a mixed seed list is
Google's own supported shape; there's no need to call this twice).

```bash
ads.sh audiences create-custom-intent --customer <10-digit> \
  --name "people researching running shoes" \
  --keywords "running shoes, marathon training, best running shoes" \
  --urls "https://competitor-a.com,https://competitor-b.com/shoes"
```

`--keywords`/`--urls` are comma-separated; at least one is required. Output:
`{ "ok": true, "resourceName": "customers/.../customAudiences/..." }`.

## `ads.sh audiences upload-customer-match`

Upload a customer-match list (emails/phone numbers) — **every identifier is
SHA-256-hashed (with Google's normalization: lowercased/trimmed email,
E.164-normalized phone) before it ever leaves your machine.** Plaintext is
never included in the request, never logged, and never written to disk.

```bash
ads.sh audiences upload-customer-match --customer <10-digit> \
  --file customers.csv --list-name "vip-customers-2026"
```

`customers.csv` is a plain CSV with `email` and/or `phone` columns (either
may be blank per row):

```csv
email,phone
jane@example.com,555-123-4567
john@example.com,
,555-987-6543
```

A malformed row (neither column populated) is skipped and counted, not
fatal. If **every** row is invalid, the upload is rejected before any network
call — never sent as an empty list. Output: `{ "ok": true, "uploaded": <n>, "skipped": <n>, "skipReasons": [...] }`.

**Prerequisite**: a website-visitor remarketing list needs the Google Ads
remarketing tag (or a linked GA4 property) actually installed and collecting
visitors first — confirm that's in place before *creating* an audience is
useful, independent of when the segment itself is created here.

## Out of scope (v1)

Display-creative (image/responsive display ads) authoring is not part of
this skill or the `"display-remarketing"` network setting — a
`"display-remarketing"` campaign still authors Responsive Search Ads via the
same `/adkit create` pipeline (Search Network with Display Select), not a
separate Display-creative campaign type. A true Display-creative campaign
type, and video/YouTube audiences, are both larger follow-ups.
