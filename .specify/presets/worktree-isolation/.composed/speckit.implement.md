---
description: Execute tasks.md inside the feature's dedicated worktree
argument-hint: Optional implementation guidance or task filter
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: beadbits
  source: .specify/presets/worktree-isolation/commands/speckit.implement.md
user-invocable: true
disable-model-invocation: false
---


## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It adds exactly one thing: it `cd`s into the feature's dedicated
worktree before any filesystem write performed by the flow below. It does not
change how tasks are executed.

It is deliberately the **outermost** layer on `/speckit-implement`, so the `cd`
happens before any other layer reads or writes a file. See the ordering contract
in the root `README.md`.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

### 0. cd into the feature's worktree (MANDATORY — Principle VII)

Per BeadBits Constitution v2.3.0 Principle VII (Feature-Work Isolation),
/speckit-implement MUST execute with the agent's cwd set to the feature's worktree.
This step runs BEFORE any filesystem write performed by the rest of this
outline.

1. Resolve the current branch with `git rev-parse --abbrev-ref HEAD`. If the
   cwd is not inside a git worktree, ERROR with:
   "Cannot resolve feature: not inside a git worktree.
   Run /speckit-git-feature to create the feature branch and worktree."
   Do NOT proceed.

   Do NOT read `worktree_path` from `.specify/feature.json`. That field no
   longer exists, and no path is ever resolved from that file: it is per-worktree
   state whose `source_issue` is the only key our tooling reads (`feature_directory`
   is written there for core Spec Kit's own resolver). Back when the file was
   tracked, the recorded path named the *previous* feature's worktree in any fresh
   worktree (issue #33).

2. Let `WT` be the worktree whose branch matches the current branch, found via
   `git worktree list --porcelain`. When the cwd is already inside that
   worktree, `WT` is `git rev-parse --show-toplevel`.

3. If no worktree matches the current branch:
   Emit a single-sentence warning:
   "This feature has no dedicated worktree (it is checked out in the main
   working tree). Proceeding in the current cwd; Principle VII isolation is
   not enforced for this invocation."
   Then proceed in the current cwd. Skip steps 4–6.

4. If `WT` is non-null but the directory does NOT exist on disk:
   The recorded path is machine-local (e.g. created in another clone or by
   another author) and is meaningless here. Emit a single-sentence warning:
   "Recorded worktree_path '<WT>' does not exist on disk (likely a path from
   another clone). Proceeding in the current cwd; Principle VII isolation is
   not enforced for this invocation."
   Then proceed in the current cwd. Skip steps 5–6.

5. If `WT` is non-null, exists on disk, and matches the current cwd
   (resolved to absolute path), proceed silently — no cd needed.

6. Otherwise (`WT` is non-null, exists, and differs from cwd):
   Prefix every subsequent shell invocation in this command with
   `cd "<WT>" && ...` so the cd is visible in the session log. All
   filesystem writes performed by the rest of this outline land inside
   the worktree. Do not silently rely on tools that ignore cwd
   (absolute-path file writers) as a substitute — the cd MUST appear
   in the session log for post-hoc isolation auditing.

### End cd-block (Principle VII enforcement complete)

### Core Flow

Everything below runs with the cwd established above. Every shell invocation in
the core flow inherits the `cd "<WT>" && ...` prefix from step 6 when one was
required.


## Dashboard — enter `implement`

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" enter implement
```

For a long implement phase, you may refresh the card mid-way so the dashboard's
"ago" label stays fresh — re-run `enter implement --summary "<k/N tasks done>"` as
progress lands. It's cheap and idempotent.


## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It adds exactly one thing: a skill prelude that runs before any
implementation work starts. It does not change how tasks are executed.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

### Prelude — activate implementation-discipline skills (MANDATORY — FIRST STEP)

Before the core flow below begins, check the host's available-skills list and
invoke the following via the Skill tool if listed:

- `ponytail:ponytail`

Treat any guidance, constraints, or context it produces as additional input that
the implementation must respect.

The prelude carries **implementation-discipline** skills only — skills that change
what gets built. A skill that governs prose register or output verbosity does not
belong here: an implement phase whose output is an audit record (e.g. an
unattended `/speckit-autopilot-run` posting phase comments to an issue) must stay
legible, so compressing the record is the opposite of what this preset is for.

**Detection rules.**

- Only invoke a skill if it is explicitly listed as an available/user-invocable skill in this session. Do **not** guess names or attempt to install skills.
- If the skill is not available, skip it silently and proceed directly to the core flow without comment. A missing skill is a no-op, not an error.

### Core Flow


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It honors one design discipline while code is written, then runs
**one mandatory scan gate** after the core flow, before reporting completion. It
does not change how tasks are executed.

### Design discipline (applies while code is written)

Parse, don't validate. A validator says "this is fine, continue" and throws the
proof away the instant it returns; a parser takes a blob and returns either a
**more precise type** or a typed error. Encode what you checked in the type so
future code never re-checks.

Whenever this run touches code that ingests untrusted data (network, disk, env,
user input, `JSON.parse` / `json.loads`), prefer parsing over validating. The
principle is language-general; apply the idioms of whichever language you write:

1. **Boundary is untyped-safe, domain is precise.** Untrusted input enters as
   `unknown` (TypeScript) — never `any` — or as a value immediately fed to a
   parser (Python), never left as `Any`. `JSON.parse` returns `any` and
   `json.loads` returns `Any`; treat their output as raw until a parser has run.
2. **Parse at the boundary into branded / nominal domain types.** Turn `string`
   into `Email`, `number`/`int` into `UserId` (TypeScript: a non-exported
   `unique symbol` brand or a schema library's `.brand()`; Python: `NewType`, a
   pydantic/attrs model, or a frozen dataclass). Illegal states become
   unrepresentable; downstream code trusts the type instead of re-checking.
3. **Parsers return a discriminated Result, not a boolean and not a throw.**
   TypeScript: a `{ kind: "ok" | "err" }` union so failure is visible in the
   signature and exhaustiveness (`never`-narrowing) catches missing cases.
   Python: return the parsed model or raise a single typed parse error at the
   boundary — do not add boolean `isValid*` / `is_valid_*` / `validate*`
   functions that callers must remember to re-run.
4. **The cast is confined to the parser.** `x as Brand` (TS) / `cast(Brand, x)`
   (Python) is the one sanctioned lie, allowed only inside the parser module
   that owns that brand. Never forge a brand elsewhere.
5. **A schema library is welcome.** Zod / valibot / io-ts (TS) and pydantic /
   attrs / msgspec (Python) satisfy this discipline and are preferred over
   hand-rolled casts when the project already has one. The library is a tool;
   the boundary discipline is still yours.

Respect any project constitution and existing conventions. If the feature has no
TypeScript or Python surface, this discipline is a no-op and you proceed with the
stock flow.

### Core Flow

Apply the discipline above to any TypeScript or Python written by the flow below.


## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It changes **how** each task's code gets written: test first, one
scenario at a time. It does not change which tasks run or in what order.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

### Before the first task — find the test command (MANDATORY)

Read `plan.md` and the project's manifests (`package.json`, `pyproject.toml`,
`go.mod`, `Cargo.toml`, `Makefile`, …) and settle on the **one command that runs
the whole suite**. Run it once now and record the baseline: how many tests, and
which ones (if any) already fail. Save the full output to a file outside the
repo; Jev assist's `baseline` check reads it. A test failing at baseline is not yours to fix
and must not be mistaken for your Red later.

If the project has no test harness, setting up the smallest one the ecosystem
uses by default (`pytest`, `vitest`/`node --test`, `go test`, …) is the first
piece of work. A change that is genuinely untestable (docs, pure config, a
generated file) is exempt — say which files and why in the completion report.

### The cycle (MANDATORY for every task that changes behaviour)

**The TDD Cycle** — this block is copied verbatim into every subagent prompt
the core flow dispatches (see *Subagents* below):

> 1. **List the scenarios.** Before any code, write down the variants of the
>    behaviour this task asks for: the basic case, then each what-if — the
>    dependency times out, the key isn't there yet, the input is empty, the
>    caller lacks permission. Take them from the task line, `spec.md`'s user
>    stories and acceptance scenarios, and `plan.md`. This list is the
>    requirement; code comes after it.
> 2. **Red — write one test for one scenario.** Small, automated, and it would
>    pass only if that scenario's behaviour exists.
> 3. **Run the whole suite. The new test must fail, for the expected reason.**
>    Expected: an assertion that the behaviour is missing, or the symbol under
>    test not existing yet. Not expected: a syntax error, a broken import in the
>    test file, a misconfigured harness — fix those and run again, they are not
>    Red. A new test that **passes immediately** is flawed or the behaviour
>    already exists: find out which before going on. Never count it as Red.
>    Classify the result with **Jev assist** `red-reason` first.
> 4. **Green — write the simplest code that passes the new test.** Hard-coding
>    and inelegance are allowed; step 6 cleans them up. Add no code beyond what
>    the tests exercise.
> 5. **Run the whole suite. Everything must pass** — the new test and every test
>    that passed at baseline. If something fails, fix it with the smallest
>    change. If you are debugging instead of fixing, revert to the last green
>    state and take a smaller step. For each failing test this cycle did not
>    write, ask **Jev assist** `baseline` whether it is yours before chasing it.
> 6. **Refactor — test code and production code, with the suite green.** Remove
>    hard-coded test data from production code, remove duplication, make names
>    self-documenting, move code to where it belongs, split long functions. Run
>    the suite after **each** refactor. Refactor only what this cycle wrote or
>    directly touched; that is not an opportunistic refactor.
> 7. **Repeat from step 2** with the next scenario until the list is done.
>
> Keep each test small and commit at each green-and-refactored point, so a
> broken step is reverted rather than debugged. Test **your** code, not the
> libraries it uses: a test that only proves the library works adds nothing,
> unless there is a stated reason to distrust that library.
>
> For every scenario, keep a one-line record: `scenario — test name — the Red
> failure line — green`, followed by the `record` line of every Jev call made
> for it. Report it back with your result.

### Jev assist (optional — the same block goes to every subagent)

> Jev (TypeSafe's System One model) answers the cycle's bounded judgment calls
> in one fast call. It **only** replaces those pauses: you still write every
> test and every line of code. Call it through the preset's helper:
>
> ```bash
> PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
> JEV="$PROJECT_DIR/.specify/presets/tdd/scripts/ts/jev.ts"
> bun "$JEV" red-reason --scenario "<scenario line>" --test <test file> --output <suite output file>
> bun "$JEV" baseline   --failure <this test's failure output file> --baseline <baseline run output file>
> bun "$JEV" covers     --scenario "<scenario line>" --test <test file>
> bun "$JEV" exempt     --path <file> --diff <file holding its diff>
> ```
>
> Save the suite output to a file first; `-` reads one argument from stdin.
> Every call prints one JSON line. Copy its `record` field into the
> per-scenario record, whatever the outcome.
>
> - **Exit 0: act on `decision`.**
>   - `red-reason`: `expected_red` → go to Green. `harness_error` → fix the
>     test or harness and rerun. `passes_immediately` → stop and investigate,
>     as step 3 says.
>   - `baseline`: `regression` → yours: smallest fix, or revert to the last
>     green state. `baseline_failure` → not yours; carry on.
>   - `covers`: `flag` → name the pair under **Flagged scenario records** in
>     the completion report. `covered` → nothing more.
>   - `exempt`: `refused` → run the cycle for that file. `exempt` → the
>     exemption stands.
> - **Exit 3: decide exactly as you would without Jev.** That covers
>   `SPECKIT_JEV=off`, no `TYPESAFE_API_KEY`, no SDK (the helper installs it
>   into `~/.cache/speckit-squads/jev` on first use), an API error, a
>   low-confidence answer, and `red-reason` in shadow mode. Read the output yourself (step 3), rerun
>   against the base branch (step 5), or keep the exemption you stated.
> - **Exit 2**: your call was malformed. Fix it; never read it as a decision.
>
> Never pass the API key on the command line or put it in a prompt, a file,
> or a record. The helper reads `TYPESAFE_API_KEY` from the environment only.
>
> `red-reason` runs in **shadow mode** until `SPECKIT_JEV_AUTOMATE=red-reason`
> (or the legacy `TDD_JEV_AUTOMATE_RED=1`) is set: it logs its answer but
> always exits 3, so you still make the Red call. Set the variable only after
> `bun "$JEV" measure --case red-reason --records <file.jsonl>` has been run
> over past Red records and its agreement rate and confident share justify
> it. Each record line holds every argument's *content* (not a path) keyed by
> flag name, plus the right verdict as `label`:
> `{scenario, test, output, label}`.

### Tasks that are already split into test and code

When `tasks.md` gives a story separate test tasks and implementation tasks
(the `explicit-task-dependencies` template does), the split **is** the cycle,
spread over two waves:

- A **test task** is Red. When it finishes, run the suite and confirm its tests
  fail for the expected reason **before** the wave holding the implementation
  tasks starts. A test that already passes stops the run: the task plan and
  the code disagree, and that is a finding to report, not to paper over.
- An **implementation task** is Green then Refactor, against those tests. Each
  scenario it covers that has no test yet still goes through the full cycle.

### Subagents

When the core flow dispatches tasks to subagents, every subagent prompt MUST
include **The TDD Cycle** and **Jev assist** blocks above verbatim, plus the
suite command, the baseline failures from the first step, and the saved
baseline run output file. A subagent that reports back without its
per-scenario record has not shown Red, and its task is not done.

### Core Flow


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). Treat empty arguments as "run every unchecked task."

## Pre-Execution Checks

Run the standard `before_implement` hook chain exactly as the canonical `/speckit-implement` does (worktree `cd`, auto-commit prompts, etc.). This preset changes *how* tasks are executed, not whether hooks fire.

## Outline

### 1. Load the feature

1. Resolve the feature directory as `specs/<branch>`, where `<branch>` is the current
   git branch with any leading path segment stripped (`feat/014-x` → `014-x`), unless
   `SPECIFY_FEATURE_DIRECTORY` or `SPECIFY_FEATURE` overrides it. Do not read the
   directory from `.specify/feature.json` — a feature's paths are always derived from
   git, never read out of that file (issue #33). Its `feature_directory` key is there
   for core Spec Kit's own resolver, not for you.
2. Read `<feature_dir>/tasks.md`. If the file is missing or has no `## Execution Wave DAG` section, ERROR with:

   ```
   tasks.md has no Execution Wave DAG. This preset (explicit-task-dependencies)
   requires the matching speckit.tasks override that emits the DAG. Re-run
   /speckit-tasks under this preset, or remove this preset to use the default
   sequential implementer.
   ```

   Do NOT fall back to sequential execution — fail loudly so the user can fix the setup.

3. Read `<feature_dir>/plan.md` and `<feature_dir>/spec.md` for context. Do not re-read them between waves.

### 2. Walk the DAG, one wave at a time

For each `Wave N` block in `## Execution Wave DAG`, in order:

1. **Collect the wave's task IDs.** Skip any that are already `[x]` in the task list.

2. **Partition the wave**:
   - **Parallel set**: tasks whose line in the main task list carries the `[P]` marker.
   - **Sequential set**: tasks without `[P]`. These run inline in declaration order *after* the parallel set completes.

   The DAG guarantees inter-wave ordering. `[P]` controls intra-wave parallelism.

3. **Dispatch the parallel set.** In a **single assistant message**, emit one `Agent` tool call per parallel task. Do not batch them across multiple messages — the point of this preset is wave-level concurrency, which only works when every Agent call in the wave is sent together.

   Each Agent call's prompt MUST include:
   - The task ID and exact task line from tasks.md (verbatim).
   - The file path(s) named in the task description.
   - A pointer to `<feature_dir>/plan.md` and `<feature_dir>/spec.md` for context.
   - The dependency list (so the subagent knows what state to assume already exists).
   - An instruction to make ONLY the changes the task describes — no opportunistic refactors, no cross-task edits.
   - An instruction to report back in under 100 words: what changed, file paths touched, anything blocking.

   Default `subagent_type` is `general-purpose`. Use a more specific type only when the task's nature obviously matches one (e.g. a UI task → a frontend-design agent if present in the project).

4. **Wait for the wave's parallel set to fully return** before dispatching the sequential set or moving to the next wave. The harness returns Agent results when they complete; do not advance until every parallel task in the wave has reported.

5. **Run the sequential set inline** (not via subagents) — these are tasks the original DAG identified as order-sensitive within the wave (e.g. shared-file edits).

6. **Mark each completed task `[x]` in tasks.md** as soon as its agent (or inline run) reports success. Do not batch the checkbox updates across waves.

### 3. Failure handling

- If a subagent reports it could not complete a task: do NOT proceed to the next wave. Surface the failure, the agent's report, and the affected task IDs. Ask the user whether to retry, skip, or abort.
- If a subagent reports it touched files outside the ones named in its task description: flag this in your end-of-wave summary. It is usually a sign the task was under-specified, not a sign to suppress the warning.

### 4. End-of-run summary

After the last wave, print:
- Total tasks executed, broken down by parallel-via-subagent vs. inline-sequential vs. skipped-already-done.
- Wall-clock-equivalent serialization estimate (sum of all task durations) vs. actual elapsed (sum of wave durations) — the speedup is the whole point of this preset.
- Any tasks left unchecked, with the reason.

## Why subagents instead of inline execution

The default `/speckit-implement` executes tasks serially in the main agent. For features with wide DAGs (e.g. five independent model files, four independent endpoints) this leaves parallelism on the floor and inflates context usage in the main agent. Dispatching parallel-safe tasks to fresh subagents:

- Cuts wall-clock time roughly by `serial_sum / wave_max` per wave.
- Keeps the main agent's context lean — only task lines and per-agent summaries land in main context, not the full edited files.
- Surfaces task-level failures in isolation, so one broken task doesn't poison the surrounding context.

The cost is more tool-use overhead per task; for trivial features (one or two tasks per wave) the default implementer is fine. This preset assumes you opted into the wave DAG because the feature was wide enough to be worth parallelizing.

## What this command does NOT change

- Does not modify `tasks.md` beyond marking checkboxes.
- Does not reorder, merge, or split tasks — the DAG is the contract.
- Does not run `after_implement` hooks differently — those fire from the standard hook chain after the last wave completes.


### Completion gate (MANDATORY — after the core flow)

1. Run the whole suite. Every test that passed at baseline, and every test this
   run added, must pass. A red suite is an incomplete run.
2. Check that the change set carries tests:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/tdd/scripts/ts/check-tests-accompany.ts"
```

Run it from the feature worktree; it resolves its own root and base
(`--base <ref>` overrides). Handle the exit code:

- **`0`**: production changes are accompanied by test changes. Proceed.
- **`1`**: production source changed with no test file changed. Go back and run
  the cycle for the listed files. The one way past it is the exemption above,
  named file by file in the report. A missing test is not an exemption. Check
  every claimed exemption with **Jev assist** `exempt`; a `refused` file goes
  back through the cycle.
- **`2`**: the check could not run (no base, not a worktree). Fix the cause and
  re-run; never read this as a pass.
- **`4`**: nothing changed. Proceed only if this run truly wrote no code.

## Completion Report

On success, include:

- The suite command, and the baseline and final test counts.
- The per-scenario records (`scenario — test — Red failure — green`), grouped
  by task.
- Any test that passed on first run and what that turned out to mean.
- Exempt files, each with its reason and its Jev `exempt` record.
- **Flagged scenario records**: every pair Jev `covers` flagged, or `none`.
- Whether Jev was used, and if not, why (the `reason` of the first fallback).
- The `check-tests-accompany.ts` result.


### Mandatory anti-pattern scan (runs AFTER all task execution)

After the entire core flow above finishes, gate completion on a deterministic scan of the
TypeScript changed during this run. **The gate is TypeScript-only for now:** Python
files are skipped — neither scanned nor flagged — unless `PDV_PYTHON=1` is set, so
the discipline above still applies to Python you write but nothing checks it.
Wherever this section says "TypeScript", read "TypeScript or Python" under
`PDV_PYTHON=1`.

1. **Review the discipline items** the scan enforces:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   bun "$PROJECT_DIR/.specify/presets/parse-dont-validate/scripts/ts/parse_dont_validate.ts" checklist
   ```

2. **Scan the changed files.** This is the whole invocation — one command, from
   anywhere in the checkout:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   bun "$PROJECT_DIR/.specify/presets/parse-dont-validate/scripts/ts/parse_dont_validate.ts" scan --new-only
   ```

   With no paths the script inspects the git change set — working-tree changes
   **plus** work already committed on the current branch, so the gate still
   fires even if a post-implement hook has committed the implementation. It
   anchors at the git worktree root itself, so it cannot silently scan one file
   because you started in a subdirectory. `--new-only` re-scans the base ref's
   copy of the same files and subtracts every finding that reproduces there, so
   what you get back is what *this run* introduced — do not hand-verify findings
   against `main` yourself. Pass explicit paths/dirs to narrow, or `--base
   <ref>` to pin the branch base (needed only when the base cannot be
   auto-detected; `--new-only` exits `3` and says so).

   Drop `--new-only` to see the pre-existing findings too — informative, but
   never a reason to hold up this feature.

   **A scan that examined nothing never exits zero.** Exit `2` is a bad
   invocation (an unknown option, `--base` with no ref); exit `3` is a scan that
   could not run (`oxc-parser` could not be installed or loaded, a file failed
   to parse, paths that resolved to no file,
   a cwd outside any git worktree); exit `4` is an empty *input* — the change
   set holds no TypeScript. Read the message and fix the call. Never
   invoke `scripts/ts/pdv_ts_scan.ts` yourself: it takes a JSON job on stdin
   and ignores file arguments, so a direct call with filenames used to print an
   empty findings list that read exactly like a pass.

   The scanner runs under `bun`; if the shell reports `bun: command not found`
   (exit `127`) the gate never ran — install bun (https://bun.sh) and re-run,
   never report it as a pass. Neither language is matched by line regex:
   Python (under `PDV_PYTHON=1`) is tokenized and parsed structurally in-process, and a Python file it
   cannot tokenize (unbalanced brackets, an unterminated string) exits `3`.
   Scanning **TypeScript** needs no `typescript` install in the project (TS 7,
   TS 5 or none): the bun helper parses with a pinned `oxc-parser` from the
   machine cache `~/.cache/speckit-squads/pdv`, installed with `bun add` on first
   use. If the scanner exits `3` because `oxc-parser` could not be installed or
   loaded (e.g. offline on first use), fix that and re-run — do not treat a
   missing parser as a pass.

3. **Resolve every finding.** For each reported `PDVxxx`, either:
   - **Fix it** — replace the validator / `any` / `Any` / stray cast with a
     parser that returns a precise type (this is the default and preferred
     outcome), or
   - **Waive it at the boundary** — if the finding is a legitimate narrowing
     cast or deserialization *inside the parser module*, add a
     `parse-dont-validate: allow PDVxxx (<reason>)` comment on that line (`//`
     for TypeScript, `#` for Python). Waive only at the trusted parser boundary;
     a waiver anywhere else is the bug this preset exists to catch.

   Re-run `scan --new-only` until it **exits zero, or exits `4` on a run you have
   confirmed wrote no TypeScript** (the "verified empty input" case
   below). Those two are the only outcomes you may report completion on.

**The verified empty-input case.** If the run produced no TypeScript,
`scan` exits `4` saying nothing was scanned. That is the one non-zero exit you
may proceed past, and only after checking the change set yourself and confirming
it really holds no `.ts`/`.tsx`/`.mts`/`.cts` file (a Python-only run lands here too). Wherever the rest of
this section says "exits zero", read it as "exits zero, or exits `4` verified
this way". If the run *did* write TypeScript, exit `4` means the
invocation is wrong, not that the gate passed — fix the call and re-run.

## Failure Policy

- A non-zero exit from `parse_dont_validate.ts scan --new-only` is a hard stop on
  reporting completion, with the single verified exit-`4` exception above. Exit
  `1` means findings: fix the flagged code or add a boundary waiver, then
  re-scan. Exits `2`/`3` mean the gate never ran — fix the invocation or the
  environment and run it; they are not a pass. Exit `4` means nothing was
  scanned, which is a pass only for a run you have confirmed wrote no
  TypeScript; report it as such rather than reporting a zero exit.
- Do not silence a finding by deleting the offending line's functionality, by
  widening a type to escape the regex, or by waiving outside a parser module.
  The point is a real parser at the boundary, not a green scan.
- If the feature has no TypeScript or Python, do not fabricate parsing work —
  the gate is a no-op.

## Completion Report

On success, include:
- The normal `/speckit-implement` completion summary from the core flow.
- Whether the parse-don't-validate scan ran and that it exited zero — or, for a
  run with no TypeScript, that it exited `4` and that you confirmed the
  change set holds no such file. State which of the two it was; never claim a
  zero exit for the exit-`4` case.
- Any findings that were fixed (what became a parser) and any that were waived
  at a parser boundary (with the reason).


## Failure Policy

- A skill that is *listed but errors out* during invocation halts the command — surface the error rather than proceeding past a failed prelude. (Missing/not-listed skills are not failures.)
- Do not downgrade the prelude to optional once a skill has been detected and invoked.

## Completion Report

On success, include:
- Which prelude skills were invoked (or that none were available).
- Confirmation that the canonical implementation flow ran after the prelude.
- Readiness for follow-up commands.


## Dashboard — `implement` done

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" done implement --summary "<all tasks complete / what shipped>"
```

If implementation stalls on a blocker you can't clear:
`bun "$REPORT" block implement --reason "<reason>"`.


## Constitution v2.3.0 Principle VII compliance note

This preset override exists specifically to close the resume-case gap left by PR #21
for `/speckit-implement`. The substantive operational behaviour it adds beyond the stock
`speckit-implement` skill is:

1. Resolving the feature's worktree from `git worktree list` by the current branch.
2. `cd`-ing into that path before any filesystem write performed by the implement outline.
3. Falling back to the current cwd (with a warning) when no worktree matches — e.g. the
   branch is checked out in the main working tree.

Deriving the path from git rather than reading a recorded `worktree_path` is deliberate:
that field was a machine-local absolute path committed to `.specify/feature.json`, so a
fresh clone aborted on a path it could never have, and a fresh worktree inherited the
previous feature's path outright (issue #33).

This override SUPERSEDES the in-skill worktree-resolution block previously added in
commit fee6cf3, which auto-created worktrees from the branch name. A missing worktree
directory degrades to the current cwd rather than erroring, so implementation stays
portable across clones.

The cd-block at `### 0.` is byte-identical across all four feature-scoped command
overrides (`/speckit-clarify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`)
modulo the slash-command substitution; this is enforced by SC-002 in
`specs/022-worktree-isolation-resume/quickstart.md`.
