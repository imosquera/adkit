# spec-minimal preset

Wraps `/speckit-specify` and `/speckit-plan` to trim the generated artifacts without replacing the stock command flow.

## What it cuts

| Command | Default artifacts | Under `spec-minimal` |
|---|---|---|
| `/speckit-specify` | `spec.md` with all sections | `spec.md` minus **Assumptions**, **Key Entities**, and **Success Criteria**, plus an inline HTML preview for UI-touching features |
| `/speckit-plan` | `plan.md` + `research.md` + `data-model.md` + `quickstart.md` + `contracts/` | `spec.md`, `plan.md`, `tasks.md`, `requirements.md`, optionally `quickstart.md` — `research.md`, `data-model.md`, and `contracts/` are forbidden |

The plan wrapper is **strict**: a pre-flight script pre-occupies `research.md`, `data-model.md`, and `contracts/` with empty / read-only directories so the stock flow physically cannot write them (`EISDIR` / `EACCES`). A post-flight verifier fails the run if anything forbidden ended up on disk. Any content that would have lived in those files must be inlined as a section of `plan.md` or `requirements.md`.

## Install

```bash
specify preset add --dev ~/Code/speckit-squads/presets/spec-minimal
```

## Stacking

The `spec-minimal` preset can be stacked with implement-focused presets (for example `worktree-isolation` and `graphify-on-implement`) without command collisions because it composes with the stock `speckit.specify` and `speckit.plan` flows instead of replacing them.

## When NOT to use

- Features that introduce real new entities and need a standalone `data-model.md` (this preset forbids it).
- Public-facing APIs across service boundaries that need a `contracts/` source of truth (forbidden here).
- First feature in a new project (the full artifact set helps establish norms).
