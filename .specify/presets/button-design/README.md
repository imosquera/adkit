# button-design

Holds every feature that touches **web / browser UI** to established
button-design rules, at the two cheapest moments to get them right: the spec
and the plan. Native iOS screens are `button-design-ios`'s job; a mixed project
installs both, and each layer writes and checks only its own sections (see
*Composition*).

| Layer | Adds | Checked by |
|---|---|---|
| `speckit.specify` wrap | `## Actions & Buttons`: a table of every action per screen (label, button vs link, primary/secondary/tertiary, destructive safeguard), or `None — no user-facing web UI.` | `check-buttons.ts spec <spec.md>` |
| `speckit.plan` wrap | `## Button System`: the component to reuse, color roles, states and contrast, touch targets, placement | `check-buttons.ts plan <feature-dir>` |

## What is enforced vs. prompted

**Checked deterministically** (exit 1 fails the phase):

- the section exists, or says `None.`
- kind is `button` or `link`; links take no button role
- at most one `primary` per screen
- button labels are 1–3 words and not generic (`OK`, `Yes`, `Submit`, `Confirm`, `Click here`, …)
- a destructive label (`Delete …`, `Remove …`, `Cancel <object>`, …) names its object and carries a `confirm`/`type-to-confirm`/`undo` safeguard
- the plan's five markers are present and populated; no `N×N` touch target under 44×44

**Prompted, not checked:** plain language instead of jargon, labels that match
the moment (`Download Report`, not `Next`), placement at the end of the task,
consistent styling, and reuse of existing components. A checker that guesses at
these cries wolf, and one that cries wolf gets disabled.

A screen that has buttons but no primary gets a stdout note, not a failure. A
toolbar legitimately has no primary.

## Composition

Both layers are `strategy: wrap` at the default priority, so they stack with
`spec-minimal`, `diff-minimal`, `spec-ui-preview`, and `library-research` in id
order. `spec-minimal`'s stripper never touches
either section.

With `button-design-ios` also installed (`./install.ts --ts --ios`), the iOS
layer owns `## iOS Actions & Buttons` / `## iOS Button System` and this one
owns `## Actions & Buttons` / `## Button System`. Headings match exactly, so
neither checker reads the other's section. A feature whose UI is only on the
iOS side gets `None — no user-facing web UI.` here. With `spec-ui-preview` installed, the preview must show the
same hierarchy as the table.

## Test

```bash
bun presets/button-design/scripts/ts/selftest-button-design.ts
```
