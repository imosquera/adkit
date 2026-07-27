# Constitution Audit: Fix GAQL SELECT/WHERE field mismatch in report queries

**No constitution defined** — `.specify/memory/constitution.md` contains only
unfilled placeholder headings (e.g. `### [PRINCIPLE_1_NAME]`); confirmed via
`constitution_audit.py list`, which matched zero real principle headings.
There is nothing to audit the implemented code against. (Same finding as
`plan.md`'s Constitution Check.)

The repo's actual binding conventions live in `/Users/iam/Code/adkit/CLAUDE.md`
(functional style, parse-don't-validate) rather than `.specify/memory/constitution.md`.
The code written for this feature honors them: `reportQuery()`'s fix is a pure
function change (a `Set` built once from spread inputs, never mutated), no
classes, no new abstractions, and no new trust boundary requiring a parser
(see `plan.md`'s `## Parse Boundaries` section).
