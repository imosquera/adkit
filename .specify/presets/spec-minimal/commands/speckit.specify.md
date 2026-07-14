---
description: "Composable wrapper for /speckit-specify that trims spec output, adds a GitHub-safe inline HTML preview when needed, and still syncs the feature issue."
---

## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow for branch/worktree setup, feature directory creation, template loading, checklist generation, hooks, and reporting. Apply the rules below when the core command renders the spec.

### Output Rules

After the stock command writes `spec.md`, run the deterministic section stripper:

```bash
.specify/presets/spec-minimal/scripts/bash/strip-spec-sections.sh "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

It removes `## Assumptions`, `### Key Entities`, and `## Success Criteria` (idempotently — safe to run repeatedly). Keep all other mandatory sections intact, including User Scenarios, Edge Cases, Functional Requirements, Functional Programming Constraints, and Platform Constraints.

### UI Preview Layer

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

<!-- BEGIN: spec-minimal preset -->
<div style="...">
  ...generated fragment...
</div>
<!-- END: spec-minimal preset -->

</details>
```

When a Functional Requirement is directly expressed by a visible element in the preview, append `(see UI Preview)` instead of repeating the visual details in prose.

### Issue Sync Layer

Create or update the corresponding GitHub issue for the spec. If `.specify/feature.json` already has a numeric `source_issue`, update that issue. Otherwise create a new issue and persist the returned issue number back into `.specify/feature.json` as `source_issue`.

Include at minimum:

- `Spec path: <SPECIFY_FEATURE_DIRECTORY/spec.md>`
- a short summary paragraph
- `## User Scenarios`
- `## Functional Requirements`
- `## Success Criteria`
- `## Notes` with `Generated/updated by /speckit-specify`

Use `gh issue create` for new issues and `gh issue edit <source_issue>` for updates. If `gh` is unavailable, unauthenticated, or the command fails, stop with a clear error instead of silently skipping issue sync.

### Core Flow

{CORE_TEMPLATE}
