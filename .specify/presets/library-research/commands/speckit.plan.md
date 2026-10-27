---
description: "After the plan is written, research npm libraries for its TypeScript/web technical unknowns"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow, then add one mandatory
research pass: identify TypeScript/web build-it-yourself surface area in the
finished plan and check, via live web search, whether an existing npm library
already solves it well enough that hand-rolling it would be wasted effort.
Findings go in this layer's own section of the shared `research.md`.

### Core Flow

Run the core plan flow first so that `plan.md` exists before research begins.

{CORE_TEMPLATE}

### Platform scope and the shared `research.md`

This layer is the **TypeScript/web** half of a pair. Its sibling,
`library-research-ios`, wraps the same command in a mixed project (e.g. a
SwiftUI app with a TypeScript backend) and writes to the same files, so the
two split them by platform and section:

- **Platform.** Consider only surface area the plan builds in
  TypeScript/JavaScript: web app, Node / Cloud Functions backend, build and
  maintenance scripts. Swift / iOS app-side work is never a research target
  here, even when it appears in the same `plan.md`.
- **Your section.** In `$SPECIFY_FEATURE_DIRECTORY/research.md` you own exactly
  one section, from the line `## Library research — TypeScript/web` up to (not
  including) the next level-2 `## ` heading or end of file. Create or rewrite
  only that section. Never edit, move, or delete anything outside it — in
  particular `## Library research — iOS`, which belongs to the sibling layer.
- **Creating vs. updating.** If `research.md` is absent, create it with just
  your section. If it exists but has no `## Library research — TypeScript/web`
  heading (including an older `research.md` written before these headings
  existed, or one another tool wrote), leave all existing content intact and
  append your section at the end. If the heading exists, replace that section
  in place. Never overwrite the whole file.

Inside your section, each researched unknown is a level-3 (`### `) heading, so
the section boundary above stays unambiguous.

### Research Pass (MANDATORY — runs after the core flow)

0. **Applicability gate.** Ask Jev whether the plan hand-rolls anything a
   library could provide:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   bun "$PROJECT_DIR/.specify/presets/library-research/scripts/ts/jev.ts" applies-library --plan "$SPECIFY_FEATURE_DIRECTORY/plan.md"
   ```

   The question is platform-agnostic, so read its answer as an upper bound:
   exit 0 with `decision: "skip"` → take the no-surface-area path in step 1
   (the `N/A` line in **your section only**, `plan.md` untouched) without
   scanning. Exit 0 with `"applies"`, exit 3, or any other exit → continue
   with step 1 as usual; `"applies"` may still be about the iOS side, in which
   case step 1's scan finds nothing web-side and takes the same `N/A` path.
   Quote the printed `record` line in the Completion Report.

1. **Scan `plan.md` for TypeScript/web technical unknowns.** Look for
   components the plan builds in TypeScript/JavaScript from scratch that
   commonly have mature npm solutions — auth, session/token handling,
   parsing/validation, queues, retries/backoff, rate limiting, caching,
   diffing, scheduling, PDF/image processing, i18n, payments, and similar.
   Ignore plain internal business logic (domain rules specific to this
   feature) and anything on the Swift / iOS side — neither is a research
   target here.

   If the plan has no such web-side surface area, write your section as:

   ```markdown
   ## Library research — TypeScript/web

   N/A — no TypeScript/web build-it-yourself surface area identified in this plan.
   ```

   following the create/append/replace rules above (never overwrite the
   file), skip straight to Completion Report, and do not modify `plan.md`.

2. **Research each unknown using real web search** (`WebSearch` / `WebFetch`
   tools) — do not rely on memorized/training-data knowledge of the library
   ecosystem, since versions, maintenance status, and best-fit choice change
   over time. For each unknown, find 1-3 candidate libraries and check:
   - still maintained (recent releases/commits, not archived)
   - license compatible with the project (avoid GPL/AGPL for permissively
     licensed projects unless the plan already accepts that)
   - fits the project's existing runtime and dependencies (check `plan.md`
     and the `package.json` / lockfile of the package that will use it —
     e.g. the web app's or the functions package's, not the iOS app's —
     before recommending)
   - genuinely reduces scope versus hand-rolling — a library that only
     covers a sliver of the unknown, or adds more integration complexity
     than it removes, is not a win

3. **Write your section of `research.md`** with one subsection per unknown
   researched:

   ```markdown
   ## Library research — TypeScript/web

   ### <Unknown, e.g. "Rate limiting">

   **Candidates considered:** <library> (<one-line why>), <library> (<one-line why>)
   **Recommendation:** use `<library>` | build custom
   **Why:** <2-3 sentences — maintenance status, fit, scope saved or why nothing fit>
   ```

   `research.md` is a valid artifact under this repo's presets — it is
   explicitly allowed by `spec-minimal` (v1.1.0+) when that preset is also
   installed. A shared file rather than a second one keeps it that way.

4. **Revise `plan.md` in place** for every unknown where the recommendation
   is "use `<library>`": replace the custom-build description with a note
   that the feature will use the library instead, naming it and linking to
   `research.md` for the rationale (e.g. `See research.md (TypeScript/web) —
   using <library> instead of a custom implementation.`). Touch only the
   TypeScript/web parts of the plan; never edit iOS/Swift sections or notes
   the sibling layer wrote. Do not touch sections for unknowns where the
   recommendation was "build custom" or where no unknown was found.

### Failure Policy

- Do not fabricate library names, versions, or maintenance status. Every claim
  in `research.md` must come from an actual search/fetch result performed
  during this run, not from memory.
- If web search tools are unavailable in this session, write that fact as the
  body of **your section** instead of guessing (never overwrite the file), and
  leave `plan.md` untouched.

## Completion Report

On success, include:
- Whether research ran, and if so, how many unknowns were identified and
  researched.
- The Jev `record` line from the applicability gate.
- Any unknown where the recommendation was "use `<library>`", naming the
  library and the plan section it now replaces.
- The normal stock `/speckit-plan` completion summary.
