# spec-ui-preview preset

Wraps `/speckit-specify` so that a feature touching user-facing UI must carry a visual preview in its spec, without replacing the stock command flow.

## What it does

When the feature touches UI, the wrapper inserts a top-level `## UI Preview (Requirement)` section between `## User Scenarios & Testing` and `## Functional Requirements`. The preview is:

- **normative** — it is part of the requirement, not a suggestion; a materially divergent implementation must be re-spec'd;
- **self-contained HTML** with inline `style="..."` attributes only (no `<style>`, `<script>`, `<link>`, remote assets, or web fonts), so it renders inline in GitHub, VS Code, and Obsidian;
- **idempotent** — the fragment lives between `<!-- BEGIN: spec-ui-preview preset -->` / `<!-- END: spec-ui-preview preset -->` sentinels, so regenerating the spec replaces the preview in place.

Functional Requirements that are directly expressed by a visible element append `(see UI Preview)` rather than restating the visuals in prose.

Non-UI features get nothing added.

## Install

```bash
specify preset add --dev ~/Code/speckit-squads/presets/spec-ui-preview
```

## Stacking

This preset uses the `wrap` strategy, so it composes with the stock `speckit.specify` flow and with other `speckit.specify` wrappers instead of replacing them.

Stacking with `spec-minimal` is safe in either order. Wrappers are applied in install-priority-ascending order, then alphabetically by preset id, but the two layers are independent: `spec-minimal`'s section stripper only removes `## Assumptions`, `### Key Entities`, and `## Success Criteria`, and never touches `## UI Preview (Requirement)`.

## When NOT to use

- Backend-only, library, or infrastructure projects with no user-facing surface — the preview would never fire and only adds prompt weight.
- Projects that keep visual intent in a real design tool (Figma, Storybook) and link it from the spec; a second inline source of truth would drift.
- Specs whose UI is too dense to convey with inline-styled HTML — reach for a design artifact instead of an approximate fragment.
