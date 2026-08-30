---
description: "Composable wrapper for /speckit-specify that adds a mandatory, GitHub-safe inline HTML UI preview section for UI-touching features."
---

## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow for branch/worktree setup, feature directory creation, template loading, checklist generation, hooks, and reporting.

This layer adds one post-processing step: for UI-touching features it inserts a `## UI Preview (Requirement)` section into the rendered `spec.md`. It runs after the core flow below, not during it — the exact instruction is in **UI Preview Layer (MANDATORY — LAST STEP)** after the core-flow seam.

It also composes with any other wrapper around `speckit.specify` — notably `spec-minimal`. When two wrappers are stacked, the engine orders them by install priority ascending, then alphabetically by preset id; whichever comes first ends up as the outer layer. Ordering does not matter here: the two layers are independent. `spec-minimal`'s section stripper only removes `## Assumptions`, `### Key Entities`, and `## Success Criteria`, and never touches the `## UI Preview (Requirement)` section this preset writes.

### Core Flow

{CORE_TEMPLATE}

### UI Preview Layer (MANDATORY — LAST STEP)

After the entire core flow above has completed and `spec.md` has been written, and
before reporting success, apply this layer to `spec.md` as the final step.

This MUST run **before any post-execution hook renders `spec.md` into a GitHub
issue** (or any other downstream consumer reads the file) — otherwise the issue
body will be missing the preview, which defeats the point of this preset. If the
core flow's post-execution hooks have not yet fired when you reach this point,
insert the preview first and then fire them. If a hook already published an issue
body without the preview, re-run that hook afterward.

If the feature touches user-facing UI, insert a new top-level `## UI Preview (Requirement)` section immediately after `## User Scenarios & Testing` and before `## Functional Requirements`.

The preview must be a self-contained HTML fragment with inline `style="..."` attributes only. Do not use `<style>`, `<script>`, `<link>`, remote assets, or external fonts.

Use this sentinel block so updates can replace the preview idempotently:

```markdown
## UI Preview (Requirement)

This preview is part of the requirement, not a suggestion. Any implementation
that materially diverges from the visual intent below must be re-spec'd. The
markup is GitHub-markdown-safe (inline styles only) and renders inline in
GitHub, VS Code, and Obsidian previews.

<details open>
  <summary><strong>Inline HTML preview</strong> (click to collapse)</summary>

<!-- BEGIN: spec-ui-preview preset -->
<div style="...">
  ...generated fragment...
</div>
<!-- END: spec-ui-preview preset -->

</details>
```

When a Functional Requirement is directly expressed by a visible element in the preview, append `(see UI Preview)` instead of repeating the visual details in prose.

If the feature does not touch user-facing UI, add nothing — do not emit an empty preview section.
