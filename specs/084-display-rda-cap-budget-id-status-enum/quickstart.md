# Quickstart: validate feature 084

All commands run from `skills/adkit/scripts`.

1. `npm run typecheck` — exits 0.
2. `npm test` — all green, including:
   - a display ad with 10 + 10 marketing images is rejected naming the combined cap of 15; 8 + 7 passes; 3 + 3 logos is rejected (cap 5);
   - a `budgets` block with a quoted `campaignId` finds the live budget, same as unquoted;
   - `normalizePlanIds` converts `"24362682893"` → `24362682893` and leaves `"0123"` / `"abc"` untouched;
   - a live campaign/ad-group status of `2` with target ENABLED is skipped and excluded from the live-spend warning.
3. Optional live check (needs creds): re-run an enable plan against an already-ENABLED campaign with `ads.sh update plan.yaml` (no `--apply`). Expect `status already ENABLED, skipped` and no `WARNING: ENABLE starts live spend`.
