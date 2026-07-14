---
description: "Composable wrapper for /speckit-plan that strictly enforces a minimal documentation tree (spec.md, plan.md, tasks.md, requirements.md, optional quickstart.md) via a mandatory prompt rule plus a read-only post-flight verifier — nothing is ever pre-created."
---

## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper, such
as the constitution-audit Constitution Check gate, that the core flow expands
to). It enforces a strictly minimal artifact tree.

Enforcement has exactly two parts: a mandatory prompt rule that forbids the agent
from ever creating the forbidden paths, and a read-only post-flight verifier that
fails the run if any forbidden artifact is found on disk. **Nothing is
pre-created** — the feature directory must never contain the forbidden paths at
any point, not even as empty sentinel files or read-only directories.

### Documentation Rule (MANDATORY — NO EXCEPTIONS)

The feature directory MUST contain ONLY these files at the top level:

- `spec.md`
- `plan.md`
- `tasks.md`
- `requirements.md`
- `quickstart.md` (optional but allowed)

`research.md`, `data-model.md`, and `contracts/` **MUST NOT be created** — not as
files, not as directories, not in any form. There is no escape hatch. Any content
that the stock flow would have written into one of those paths MUST instead be
inlined as a section of `plan.md` or `requirements.md`.

When you reach any step of the core flow that would create `research.md`,
`data-model.md`, or `contracts/`, do not create the path. Fold its content into
`plan.md` or `requirements.md` and continue.

In the **Project Structure → Documentation (this feature)** subsection of
`plan.md`, list exactly the allowed files and nothing else.

### Core Flow

{CORE_TEMPLATE}

### Post-Flight Verification (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success, run
the read-only verifier as the final step:

```bash
.specify/presets/spec-minimal/scripts/bash/verify-minimal-tree.sh "$SPECIFY_FEATURE_DIRECTORY"
```

This script creates nothing and deletes nothing. It exits non-zero if any
forbidden artifact (`research.md`, `data-model.md`, `contracts/`) or any other
unexpected entry ended up on disk. If it exits non-zero, surface the error
verbatim to the user and stop — do not retry, do not silently delete, do not
report success. Only report success once this verifier exits zero.
