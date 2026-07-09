# adkit — engineering conventions

These rules are binding for all work in this repo. They override default behavior.

## 1. Always use worktrees

Never do feature work directly on a checkout of `main`. For every task that changes
code, create a git worktree and work there:

```bash
git worktree add -b <branch> /Users/iam/Code/adkit.worktrees/<name> HEAD
```

- All worktrees live under the sibling directory **`/Users/iam/Code/adkit.worktrees/`** (i.e. `adkit.worktrees/<name>`), never inside the repo tree and never as ad-hoc siblings elsewhere.
- One worktree per task/branch. Remove it with `git worktree remove` once the branch is merged.
- Open a PR from the worktree branch; don't push straight to `main`.

## 2. Always write in a functional style

- Pure functions: same input → same output, no side effects in the core logic. Isolate I/O (network, filesystem, stdout, SDK mutations) to the edges.
- Immutable data: never mutate a parameter or build a result by pushing into an accumulator in a loop. Use `map` / `filter` / `reduce` / `flatMap` / spread and return new values.
- No classes for logic. The only acceptable classes are error types (exceptions) and unavoidable third-party SDK objects.
- Prefer expressions over statements; prefer composition over control-flow ceremony.

## 3. Parse, don't validate

Follow type-driven design ("Parse, don't validate", Alexis King). Push correctness
into types so illegal states are unrepresentable and checks happen exactly once.

- **Parse at the boundary.** Turn untrusted/loose input (CLI args, JSON plans, API
  rows, env) into a precise, well-typed value **once**, at the edge — with zod
  (`.parse` / `.safeParse`) or an explicit parse function that returns the strong
  type or fails. Downstream code receives the parsed type and never re-checks.
- **Strengthen arguments, don't weaken results.** If a function can't handle an empty
  list / missing field, take a type that makes that impossible (a non-empty type, a
  required field, a narrowed union) rather than returning `Maybe`/null and forcing
  every caller to re-handle the "impossible" case.
- **A parsed value is a proof.** Carry the evidence in the type: once you hold a
  `Brief`, its invariants are guaranteed — don't defensively re-validate fields that
  parsing already established.
- **No redundant downstream checks.** If you find yourself re-checking something the
  boundary already guaranteed, that's a smell: move the check to the parse step and
  let the type carry the result.
