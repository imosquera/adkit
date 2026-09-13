# Feature Specification: Meta Ads parity — init, create, audit, update, report for Meta ad accounts

**Feature Branch**: `077-meta-ads-parity`

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "Meta (Facebook/Instagram) Marketing API support in adkit at full parity with Google Ads: init, create, audit, update, report for Meta ad accounts. Add a platform switch (platform: google | meta) in adkit.yaml and SKILL.md routing; Meta credentials (system-user access token, app id/secret) in .adkit.secrets.yaml; ad account id parsing (act_ prefix) at the boundary. Graph API client (plain fetch against graph.facebook.com, pinned API version) replacing the role of gaql/ and google-ads-api for Meta. create: publish campaign → ad set → ad (paused) from a Meta brief (objective, budget CBO/ABO, audience incl. custom/lookalike/Advantage+ audience, exclusions, placements, creative text pools + image/video, creative_features_spec opt-outs) staged in adbriefs/<slug>.yaml with diff before publish. audit: read-only scoring of live ad sets/ads per reference/meta playbook (learning limited, creative fatigue via frequency/CTR, placement breakdowns, missing exclusions, Advantage+ enhancement opt-ins). update: apply a plan to live ads (text pools, budgets, status, exclusions). report: Insights API metrics with breakdowns and attribution windows (7d_click/1d_view; 7d_view/28d_view no longer returned since 2026-01-12) into the existing markdown + Chart.js dashboard. research is out of scope (no keyword planner equivalent) unless a Meta Ad Library competitor pull is trivial. Reuse the existing platform-agnostic modules (adbriefs, cli, markdown/report rendering, config, secrets-guard) rather than forking them. Testing: unit tests with mocked Graph API JSON only; no live credentials yet. Playbook docs live in skills/adkit/reference/meta/ (PR #76). Follow repo CLAUDE.md: functional style, parse-don't-validate with zod at the boundary."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure a project for a Meta ad account (Priority: P1)

An operator who runs Meta (Facebook/Instagram) ads wants to point adkit at their
Meta ad account the same way they point it at a Google Ads account today: one
interactive `init`, the account number in the committed `adkit.yaml`, the access
token in the git-ignored `.adkit.secrets.yaml`, and a `preflight` that proves the
credentials work before anything reads or spends.

**Why this priority**: Every other Meta command depends on a resolved ad account
and a working token. Without it nothing else can run.

**Independent Test**: Run `ads.sh init` choosing `meta`, then `ads.sh preflight`
against a mocked Graph API; confirm `adkit.yaml` holds `platform: meta` and the ad
account id, the secrets file holds the token, and preflight returns `ok: true`
(or `ok: false` naming the failing step for a rejected token).

**Acceptance Scenarios**:

1. **Given** a project with no config, **When** the operator runs `init` and
   picks Meta, **Then** `adkit.yaml` records `platform: meta` and the ad account
   id, and `.adkit.secrets.yaml` records the access token (and app id/secret when
   given), never the other way round.
2. **Given** an ad account id typed as `1234567890` or `act_1234567890`, **When**
   it is read from a flag, env var, or `adkit.yaml`, **Then** both forms resolve to
   the same account; anything that is not digits after an optional `act_` prefix
   is rejected, naming where it came from.
3. **Given** an existing Google-only project with no `platform` key, **When** any
   command runs, **Then** it behaves exactly as it does today (Google).
4. **Given** a token the Graph API rejects or that lacks ads permissions, **When**
   `preflight` runs, **Then** it exits non-zero with `ok: false` naming the
   credential problem and the fix.

---

### User Story 2 - Report on Meta performance (Priority: P1)

An operator wants the same markdown analysis and Chart.js dashboard `report`
produces for Google, built from Meta Insights data: spend, impressions, reach,
frequency, clicks, CTR, CPM, CPC, leads/conversions and cost per result — for a
trailing window or all time — broken down by campaign, ad set, ad, placement,
age, and gender.

**Why this priority**: Read-only, zero spend risk, and it is the feedback loop
every other Meta decision (audit, update) depends on.

**Independent Test**: Run `ads.sh report --platform meta` against recorded
Insights responses; confirm the envelope payload and the rendered markdown and
dashboard contain the expected totals and breakdown rows.

**Acceptance Scenarios**:

1. **Given** a Meta ad account with activity, **When** the operator runs
   `report` for a trailing window, **Then** metrics are aggregated per campaign,
   ad set, and ad and written to the same output directory and file shapes as
   Google reports.
2. **Given** `--all-time` and `--include-paused`, **When** `report` runs,
   **Then** they behave as they do for Google, and the reported window reflects
   the real data span.
3. **Given** default attribution, **When** `report` runs, **Then** results use
   7-day click / 1-day view and the report states which attribution setting was
   used; a request for a removed view window (7-day or 28-day view) is refused
   with a message explaining it is no longer available rather than silently
   returning zeros.
4. **Given** an account with more rows than one API page, **When** `report`
   runs, **Then** all pages are fetched before aggregation.

---

### User Story 3 - Audit live Meta campaigns (Priority: P2)

An operator wants a read-only audit of live Meta ad sets and ads that scores
them against the `reference/meta/` playbook and surfaces concrete fixes:
ad sets stuck in learning limited, creative fatigue (rising frequency with
falling CTR), budget spread too thin across ad sets, placement or demographic
breakdowns burning spend without results, missing customer/employee
exclusions, missing conversion tracking signal, and Advantage+ creative
enhancements left on that the brand should control.

**Why this priority**: It turns report data into the fix list `update` applies.
It is read-only, so it is safe to ship before publishing.

**Independent Test**: Run `ads.sh audit --platform meta` against recorded
campaign/ad set/ad/insights responses containing one of each issue type; confirm
each issue appears once in the envelope with its entity id, a severity, and a
recommended fix, and no mutation call is made.

**Acceptance Scenarios**:

1. **Given** an ad set whose learning status is limited, **When** `audit` runs,
   **Then** the finding names the ad set and recommends consolidation or a
   budget/optimization-event change per the playbook.
2. **Given** an ad whose frequency has risen past the fatigue threshold while CTR
   has fallen over the comparison window, **When** `audit` runs, **Then** it is
   flagged for creative refresh.
3. **Given** an ad set with no existing-customer exclusion on a prospecting
   campaign, **When** `audit` runs, **Then** the missing exclusion is flagged.
4. **Given** any audit run, **When** it completes, **Then** zero write calls were
   made to the ad account.

---

### User Story 4 - Publish a new Meta campaign from a brief (Priority: P2)

An operator wants to publish a campaign → ad set(s) → ad(s) from a Meta brief
without clicking through Ads Manager. The brief declares the objective, budget
(campaign-level or per ad set), schedule, audience (locations, age, custom
audiences, lookalikes, Advantage+ audience), exclusions, placements (Advantage+
or manual), optimization goal and bid strategy, conversion event, and creatives
(primary text / headline / description pools, call to action, destination URL,
local image or video files, and explicit creative enhancement opt-outs).

**Why this priority**: This is the "create" half of parity, but it spends money,
so it follows the read-only stories.

**Independent Test**: Run `ads.sh create` with a Meta brief against a mocked
Graph API in dry-run; confirm the staged `adbriefs/<slug>.yaml` diff and the
planned objects. Then run the publish path against mocks; confirm the calls are
made in dependency order (media → campaign → ad set → creative → ad) and every
object is created paused.

**Acceptance Scenarios**:

1. **Given** a valid Meta brief, **When** the operator runs `create` without
   publishing, **Then** the brief is staged to `adbriefs/<slug>.yaml`, its diff
   is shown, and no write call is made.
2. **Given** the same brief, **When** the operator publishes, **Then** the
   campaign, ad sets, creatives and ads are created paused, the local media is
   uploaded first, and the created ids are recorded in the staged brief.
3. **Given** a publish that fails partway (e.g. the ad set is rejected), **When**
   the operator re-runs `create` for the same brief, **Then** already-created
   objects are reused rather than duplicated, and only the missing objects are
   created.
4. **Given** a brief that is invalid (unknown objective, CBO budget plus ad-set
   budgets, a text field over Meta's hard limit, more than 5 text options per
   field, a missing media file), **When** `create` runs, **Then** it fails before
   any write call, naming every problem found.

---

### User Story 5 - Apply an update plan to live Meta ads (Priority: P3)

An operator wants to apply the audit's recommended fixes through a validated
plan, the same dry-run-unless-`--apply` flow as Google `update`: change campaign
or ad set budgets, pause/enable campaigns, ad sets and ads, add or remove
audience exclusions, change creative enhancement opt-ins, and replace an ad's
text pools (which on Meta means publishing a new creative and swapping the ad
onto it).

**Why this priority**: It closes the audit → fix loop, but each lever touches
live spend, so it lands last.

**Independent Test**: Run `ads.sh update --platform meta` with a plan against
mocked live state in dry-run; confirm the diff. Run again with `--apply`; confirm
the expected write calls. Run a third time; confirm every entry is skipped.

**Acceptance Scenarios**:

1. **Given** an update plan, **When** the operator runs `update` without
   `--apply`, **Then** a diff is printed, the plan is staged into the local brief,
   and no write call is made.
2. **Given** the same plan, **When** run with `--apply`, **Then** the live
   objects match the plan and the staged brief reflects the new values.
3. **Given** a plan entry that matches the live state, **When** `update` runs,
   **Then** the entry is reported skipped with no write call.
4. **Given** a plan that enables a paused campaign or ad set, or raises a budget,
   **When** `update` runs, **Then** a `WARNING:` line is printed and the entity ids
   are listed under a distinct spend-affecting envelope key, mirroring the Google
   `enableStartsLiveSpend` precedent.
5. **Given** one entry that fails, **When** `update --apply` runs, **Then** the
   other entries are still applied and the failure is reported per entry.
6. **Given** a budget edit on an ad set that is in learning, **When** `update`
   runs, **Then** a warning states the change may reset learning.

---

### Edge Cases

- A Graph API rate-limit or transient error response: the call is retried with
  backoff a bounded number of times, then fails with `ok: false` naming the step;
  it is never swallowed into an empty result.
- A token that expires mid-run: the run stops at that step with a credential
  error, and for `create` the partial ids already recorded let a re-run resume.
- A Special Ad Category (credit, employment, housing, social issues) campaign:
  the brief must declare it; targeting options Meta forbids for that category are
  rejected before any write.
- Advantage+ campaigns where ad-set custom-audience exclusions are ignored:
  `create` and `update` warn that the exclusion will not apply instead of
  reporting success silently.
- An ad account in a currency with no minor unit: budgets are converted using the
  account's currency offset, never assumed to be cents.
- Detailed targeting options Meta has retired: the API rejection is surfaced
  verbatim with the option named.
- A project using Google for one command and Meta for another: `--platform` on the
  command overrides the `adkit.yaml` default.
- `research` and `keyword-ideas` invoked with `platform: meta`: they refuse with a
  message that they are Google-only.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `adkit.yaml` MUST accept `platform: google | meta`; absence MUST mean
  `google` so existing projects are unchanged. Every Meta-capable command MUST
  accept `--platform` to override it for one run.
- **FR-002**: Meta config MUST be split by trust level like Google: the ad account
  id (and optional business id) in `adkit.yaml`; the access token and app
  id/secret in `.adkit.secrets.yaml` or env vars, and the existing secrets
  guardrail MUST refuse to write Meta credentials anywhere committable.
- **FR-003**: The ad account id MUST be parsed once at the boundary from flag, env
  var, or `adkit.yaml`, accepting digits with or without the `act_` prefix, and
  rejected otherwise with the source tier named. Downstream code receives only the
  parsed id.
- **FR-004**: `init` MUST offer Meta as a platform and scaffold both files; `preflight`
  MUST verify the token can read the ad account and report missing permissions.
- **FR-005**: All Meta API access MUST go through one client pinned to a single
  Graph API version, handling pagination, bounded retry on rate-limit/transient
  errors, and turning every API error into the standard `ok: false` envelope with
  Meta's error message and code preserved.
- **FR-006**: Every Graph API response MUST be parsed into precise types at the
  client boundary; a response that does not match its schema MUST fail loudly
  rather than yield undefined fields.
- **FR-007**: `report` MUST produce the same output shapes and directories as the
  Google report (JSON envelope, markdown analysis, Chart.js dashboard), including
  `--all-time` and `--include-paused`, with campaign/ad set/ad levels and
  placement, age, and gender breakdowns.
- **FR-008**: `report` MUST default to 7-day click / 1-day view attribution, state
  the attribution used, and refuse removed view windows with an explanatory error.
- **FR-009**: `audit` MUST be read-only and report findings for: learning limited
  ad sets, creative fatigue (frequency and CTR trend), over-fragmented budgets,
  wasted spend by placement/demographic breakdown, missing customer/employee
  exclusions, missing or weak conversion signal, and Advantage+ creative
  enhancements enabled. Each finding carries entity id, severity, evidence, and
  a recommended fix traceable to a `reference/meta/` section.
- **FR-010**: `create` MUST accept a Meta brief, validate it completely before any
  write, stage it into `adbriefs/<slug>.yaml` with a diff, and publish media →
  campaign → ad sets → creatives → ads, all paused, recording created ids in the
  staged brief.
- **FR-011**: `create` MUST be safely re-runnable after a partial publish, reusing
  recorded ids instead of creating duplicates.
- **FR-012**: The Meta brief MUST enforce Meta's hard rules: one budget mode
  (campaign-level or ad-set-level, not both), at most 5 options per text field,
  hard character limits per text field, supported objective/optimization-goal
  pairings, and explicit opt-in/opt-out for each creative enhancement it sets.
- **FR-013**: `update` MUST support levers for campaign/ad set budgets,
  campaign/ad set/ad status, audience exclusions add/remove, creative enhancement
  opt-ins, and ad text pool replacement; dry-run unless `--apply`; skip entries
  that match live state; stage into the local brief.
- **FR-014**: `update` MUST print `WARNING:` and list entity ids under a distinct
  envelope key for every change that starts or increases spend, and warn when an
  edit may reset an ad set's learning phase.
- **FR-015**: A failed `update` entry MUST NOT prevent unrelated entries from
  applying.
- **FR-016**: Google-only commands (`research`, `keyword-ideas`) MUST refuse with a
  clear message when the resolved platform is Meta.
- **FR-017**: `SKILL.md` and the command reference docs (`init`, `create`, `audit`,
  `update`, `report`, `conventions`) MUST document the Meta path and link the
  relevant `reference/meta/` playbook sections.
- **FR-018**: Existing Google behavior MUST be unchanged; the existing test suite
  MUST pass without modification to its expectations.
- **FR-019**: Meta behavior MUST be covered by automated tests using recorded or
  hand-written Graph API responses; no test may require live credentials or
  network access.

### Functional Programming Constraints

- Core logic (brief parsing, audit scoring, plan diffing, report aggregation) MUST
  be pure functions over parsed values; network, filesystem, and stdout stay at the
  command edges.
- No classes except error types; no mutation of parameters or accumulator loops.
- Untrusted input (CLI args, env, YAML briefs and plans, Graph API responses) MUST
  be parsed once at the boundary into precise types; downstream code MUST NOT
  re-validate what parsing established.

### Platform Constraints

- Reuse the existing platform-agnostic modules (`adbriefs/`, `cli/`, markdown and
  report rendering, config loading, secrets guard) by extending them, not by
  forking Meta copies.
- No new runtime dependency is required for Meta API access; the Node runtime's
  built-in HTTP client is sufficient.
- Commands keep running through `ads.sh` with no build step.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can go from an empty project to a Meta performance report
  using only `ads.sh`, with zero steps in Ads Manager.
- **SC-002**: 100% of Meta `create` and `update` runs without publish/`--apply`
  make zero write calls, verified by automated tests.
- **SC-003**: 100% of objects created by `create` start paused.
- **SC-004**: Re-running `create` after a simulated partial failure creates zero
  duplicate objects.
- **SC-005**: The full existing Google test suite passes unchanged.
