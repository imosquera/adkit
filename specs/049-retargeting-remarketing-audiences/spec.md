# Feature Specification: Retargeting/Remarketing Campaign Support

**Feature Branch**: `049-retargeting-remarketing-audiences`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "New: retargeting/remarketing campaign support (audience segments + display network) — adkit is search-only today; add an `ads.sh audiences` subcommand (list / create-custom-intent / upload-customer-match), extend the Brief schema with `adGroups[].audienceSegments`, wire `create`/`update` to attach segments in OBSERVATION mode by default, add a scoped `display-remarketing` network setting that only enables Display when a campaign carries audience segments, and make `ads.sh audit` skip/adapt search-specific checks for remarketing/display campaigns."

## Clarifications

### Session 2026-08-02

- Q: What format does `upload-customer-match` accept for input? → A: A local CSV file with `email` and/or `phone` columns (either may be blank per row) — matches Google's own Customer Match upload shape; additional formats can be added later without changing the hashing contract.
- Q: Does `create-custom-intent` accept keyword seeds, URL seeds, or both in one call? → A: Both in a single call — Google's underlying audience resource natively supports mixed `KEYWORD`/`URL` members, so restricting to one seed type per call would be an artificial limitation.
- Q: Should adkit pre-validate minimum audience list size (Google enforces ≥100 members for Search, ≥1000 for Display) before `create`/`update` attaches or targets it? → A: No — defer to Google Ads' own API-side validation and surface that error, rather than adkit re-implementing a threshold Google controls and could change.
- Q: For FR-011, should `ads.sh audit` skip search-specific checks entirely for `display-remarketing` campaigns, or build adapted display-specific equivalents? → A: Skip entirely for v1 — display-creative authoring (and therefore display-specific audit checks) is explicitly out of scope for this issue; adapted checks are a follow-up once display-creative authoring exists.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Attach an existing remarketing/customer-match audience to a new campaign (Priority: P1)

An advertiser who already has a remarketing list or customer-match list in their
Google Ads account wants a new search campaign that observes (reports on) that
audience against an ad group, without changing how the campaign targets or bids.
They list the audiences available on their account, add the audience's ID to an ad
group in their brief, and run the existing create flow.

**Why this priority**: This is the smallest end-to-end slice that delivers the
issue's core value — attaching an audience to a campaign — and it reuses the
existing RSA/search authoring pipeline (no display-creative or network changes
required), so it is safe, additive, and independently shippable.

**Independent Test**: Can be fully tested by running `ads.sh audiences list`,
adding an `audienceSegments` entry to an ad group in a brief, running
`ads.sh create`, and confirming the ad group carries an OBSERVATION-mode audience
criterion in the live account (or dry-run plan) — with no change to any other ad
group's targeting.

**Acceptance Scenarios**:

1. **Given** a Google Ads account with at least one remarketing/user list,
   **When** the advertiser runs `ads.sh audiences list`, **Then** the command
   prints each available audience's ID, name, and type (in-market / affinity /
   custom-intent / user-list).
2. **Given** a brief with `adGroups[0].audienceSegments: [{ audienceId: 123 }]`,
   **When** the advertiser runs `ads.sh create`, **Then** the created ad group has
   an audience criterion for `123` attached in OBSERVATION mode (bid/report only —
   it does not restrict who the ad group otherwise targets).
3. **Given** a brief with an empty or omitted `audienceSegments` list on every ad
   group, **When** the advertiser runs `ads.sh create`, **Then** campaign creation
   behaves exactly as it does today (no audience criteria created, no behavior
   change for existing users of the tool).

---

### User Story 2 - Attach or detach audiences on an existing live ad group (Priority: P2)

An advertiser already running a campaign wants to add (or remove) an audience
segment on a specific ad group after the fact, using the same staged
diff-before-apply update flow the tool already uses for other levers (e.g. the
`addRsa` lever).

**Why this priority**: Most real usage happens after initial launch — audiences
are added iteratively as lists mature (e.g. a 30-day remarketing list only becomes
useful once it has enough members). This depends on User Story 1's schema/plumbing
existing first.

**Independent Test**: Can be fully tested by running `ads.sh update` with an
`audiences` plan lever against a live ad group, confirming the diff preview shows
the intended add/remove before anything is applied, and confirming a second run
with the same add is a no-op (idempotent).

**Acceptance Scenarios**:

1. **Given** a live ad group with no audience criteria, **When** the advertiser
   stages an update plan with `audiences: [{ adGroupId: X, add: [123] }]`,
   **Then** the tool shows a diff indicating audience `123` will be added before
   applying anything.
2. **Given** a live ad group that already has audience `123` attached, **When**
   the advertiser re-applies the same `add: [123]` plan, **Then** the tool
   reports no change needed (idempotent — it does not create a duplicate
   criterion or error).
3. **Given** a live ad group with audience `123` attached, **When** the advertiser
   stages `remove: [123]`, **Then** the criterion is removed and a subsequent
   `audiences list`-style check on that ad group no longer shows it.

---

### User Story 3 - Launch a true remarketing campaign on the Display Network (Priority: P2)

An advertiser wants a campaign that actually serves on the Display Network to
people already on a remarketing list, not just a search campaign observing an
audience. They set `campaign.networkSettings: "display-remarketing"` on a
campaign whose ad groups carry at least one non-empty `audienceSegments` list.

**Why this priority**: This is the feature's namesake capability, but it is scoped
narrowly (reuses the existing RSA authoring pipeline rather than requiring
display-creative support) and depends on Stories 1-2's schema plumbing, so it
lands after the safer, additive observation-only path.

**Independent Test**: Can be fully tested by creating a brief with
`campaign.networkSettings: "display-remarketing"` and a non-empty
`audienceSegments` on at least one ad group, running `ads.sh create`, and
confirming the resulting campaign has the Display Network enabled while a
sibling brief with the same setting but no audience segments is rejected.

**Acceptance Scenarios**:

1. **Given** a brief with `campaign.networkSettings: "display-remarketing"` and
   at least one ad group with a non-empty `audienceSegments` list, **When** the
   advertiser runs `ads.sh create`, **Then** the created campaign has the Display
   Network enabled for that campaign only.
2. **Given** a brief with `campaign.networkSettings: "display-remarketing"` but
   every ad group has an empty or missing `audienceSegments` list, **When** the
   advertiser runs `ads.sh create`, **Then** the tool rejects the brief before
   creating anything, explaining that `display-remarketing` requires at least one
   audience segment.
3. **Given** any brief using the existing `"search-only"` or
   `"search-partners-display"` settings, **When** the advertiser runs
   `ads.sh create`, **Then** the Display Network remains off exactly as it does
   today — the new setting never silently changes existing campaigns' behavior.

---

### User Story 4 - Upload a customer-match list without ever exposing plaintext PII (Priority: P3)

An advertiser has a list of customer emails/phone numbers they want to use as a
customer-match audience. They run the upload command with a source file, and the
tool hashes each identifier before it ever leaves their machine.

**Why this priority**: High value for a subset of advertisers who have existing
customer lists, but it is the most operationally sensitive path (real PII) and
depends on the audience concept from Stories 1-3 already existing, so it is
lowest priority for the MVP slice while still in scope for this issue.

**Independent Test**: Can be fully tested by running
`ads.sh audiences upload-customer-match` against a local sample file and
confirming (a) the network payload sent to Google Ads contains only SHA-256
hashes, never plaintext, and (b) the local process never logs or persists
plaintext identifiers.

**Acceptance Scenarios**:

1. **Given** a local file of plaintext customer emails, **When** the advertiser
   runs `ads.sh audiences upload-customer-match`, **Then** every identifier is
   SHA-256-hashed (per Google's normalization rules — lowercased/trimmed email,
   E.164-normalized phone) before being included in any request payload.
2. **Given** the same command, **When** it completes or fails, **Then** no
   plaintext identifier appears in any log line, error message, or on-disk
   artifact the tool writes.
3. **Given** a malformed input row (invalid email/phone), **When** the advertiser
   runs the upload, **Then** that row is skipped with a clear count of
   skipped/invalid rows reported, rather than the whole upload failing silently
   or the tool guessing at a fix.

---

### Edge Cases

- What happens when an `audienceSegments` entry in a brief references an
  `audienceId` that doesn't exist (or isn't accessible) in the target account? →
  `ads.sh create`/`update` must reject with a clear error naming the invalid ID,
  not silently skip it or fail with a raw API error.
- What happens when `ads.sh audit` runs against an account that has both plain
  search campaigns and `display-remarketing` campaigns? → Search-specific checks
  (RSA count, keyword inclusion, ad-strength scoring) must still run on the
  search campaigns and must be skipped (not falsely flagged) on the
  `display-remarketing` campaigns.
- What happens when the same `audienceId` is listed twice in one ad group's
  `audienceSegments` (or added twice via two `update` runs)? → Treated as
  idempotent — one criterion results, no duplicate-criterion error.
- What happens when a customer-match upload file has zero valid rows after
  hashing/normalization? → The upload is rejected before any request is sent,
  with a message saying so, rather than sending an empty list.
- What happens when `audiences list` is run against a customer with zero
  audiences of any kind? → Returns an empty, valid result (not an error).
- What happens when an audience list is too small to serve (Google enforces
  minimum member counts — e.g. ≥100 for Search, ≥1000 for Display)? → adkit does
  not pre-validate size itself; it passes the attach/target request through and
  surfaces Google Ads' own rejection message rather than re-implementing a
  threshold Google controls.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The tool MUST provide an `ads.sh audiences list` command that
  enumerates a customer's available audience segments (in-market, affinity,
  custom-intent, user-list/remarketing), showing at minimum each audience's ID,
  display name, and type.
- **FR-002**: The tool MUST provide an `ads.sh audiences create-custom-intent`
  command that creates a custom-intent/custom-segment audience from keyword
  and/or URL seeds supplied by the advertiser.
- **FR-003**: The tool MUST provide an `ads.sh audiences upload-customer-match`
  command that accepts a local CSV file with `email` and/or `phone` columns
  (either may be blank per row), normalizes and SHA-256-hashes each identifier
  per Google's customer match requirements, and uploads only the hashed values —
  plaintext identifiers MUST NOT be included in any outbound request, log line,
  or on-disk artifact the tool produces.
- **FR-004**: The Brief schema MUST support an optional `audienceSegments` list
  on each ad group (each entry identifying one audience by ID), defaulting to an
  empty list when omitted, so that briefs written before this feature continue
  to parse and behave unchanged.
- **FR-005**: `ads.sh create` MUST attach each ad group's `audienceSegments`
  entries as audience criteria in OBSERVATION mode by default (bid/report
  visibility only) — it MUST NOT restrict who the ad group otherwise targets
  unless the advertiser has separately configured the campaign to target that
  audience.
- **FR-006**: `ads.sh update` MUST support a plan lever (e.g. `audiences`) that
  adds and/or removes audience criteria on an existing, already-live ad group,
  following the same staged diff-before-apply flow as other update levers (the
  advertiser sees what will change before it is applied).
- **FR-007**: The `audiences` update lever MUST be idempotent per ad group —
  re-adding an audience already attached, or re-removing one already absent,
  MUST NOT error and MUST result in the same end state as if the operation had
  been applied once.
- **FR-008**: The Brief schema's `campaign.networkSettings` MUST support a new
  value (`"display-remarketing"`) that enables the Display Network for that
  campaign only.
- **FR-009**: `ads.sh create` MUST reject a brief that sets
  `campaign.networkSettings` to `"display-remarketing"` when none of that
  campaign's ad groups carry a non-empty `audienceSegments` list — Display MUST
  NOT be silently enabled for a plain search campaign.
- **FR-010**: For every `networkSettings` value other than `"display-remarketing"`,
  existing behavior MUST be unchanged — the Display Network remains disabled
  exactly as it is today.
- **FR-011**: `ads.sh audit` MUST recognize a campaign using
  `"display-remarketing"` and skip the search-ads-specific checks (RSA count,
  keyword inclusion, ad-strength scoring) that do not apply to display ads,
  rather than reporting them as failures. Adapted display-specific equivalents
  are out of scope for v1 (display-creative authoring itself is out of scope —
  see below).
- **FR-012**: All new commands and schema fields MUST validate their input at
  the boundary (CLI args, brief fields, uploaded rows) and fail with a specific,
  actionable error message for invalid audience IDs, malformed identifiers, or
  contradictory settings (e.g. FR-009), rather than passing bad data through to
  the Google Ads API and surfacing a raw API error.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An advertiser can go from "I have a remarketing list in my Google
  Ads account" to "a live ad group is observing it" using only `ads.sh audiences
  list` and one brief edit plus `ads.sh create` — no manual Google Ads UI steps.
- **SC-002**: 100% of existing briefs (with no `audienceSegments` field and
  `networkSettings` values other than `"display-remarketing"`) continue to
  create and update campaigns with identical resulting configuration to before
  this feature shipped.
- **SC-003**: 0 customer-match uploads ever transmit or log a plaintext email or
  phone number — every uploaded identifier is a normalized SHA-256 hash, verified
  by test coverage of the upload path.
- **SC-004**: 0 `display-remarketing` campaigns are ever created without at
  least one attached audience segment — attempting to do so is rejected before
  any API call is made.
- **SC-005**: Running `ads.sh audit` against an account containing both search
  and `display-remarketing` campaigns produces 0 false-positive findings from
  search-specific checks (RSA count, keyword inclusion, ad-strength) against the
  `display-remarketing` campaigns.
