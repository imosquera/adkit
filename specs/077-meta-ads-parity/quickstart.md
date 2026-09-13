# Quickstart: validating Meta Ads parity (077)

Design details live in [plan.md](plan.md) (D1–D10). This guide is how to prove
the feature works.

## 1. Automated (no credentials, no network)

```bash
cd skills/adkit/scripts
npm run typecheck
npm test                       # full suite — Google tests must pass unchanged (SC-005)
npx vitest run src/meta        # Meta slices only
```

Expected: typecheck exits 0; every test passes. The Meta tests cover, per
story:

| Story | What the tests prove |
| --- | --- |
| US1 | `platform` defaults to google; `act_123` and `123` parse to one id; bad ids name their source; `init` writes Meta token only to the secrets file; preflight maps a rejected token / missing permission / disabled account to `ok:false` with the step |
| US2 | insights pages are all fetched; rows shape into `MetaReport` totals and placement/demographic rows; `7d_view` is refused; Google report YAML is byte-identical |
| US3 | one finding per seeded issue type with entity id, severity, fix, playbook link; the fake client's `post` is never called |
| US4 | invalid brief lists every problem with zero calls; dry run makes zero writes; publish order media → campaign → ad sets → creatives → ads, all `PAUSED`; failure mid-publish then re-run creates no duplicates |
| US5 | dry run zero writes; `--apply` writes; third run all skipped; enable/raise lists ids under `enableStartsLiveSpend` / `budgetIncreases`; one failing entry doesn't stop others |

## 2. CLI smoke with a fake Graph API (still offline)

The bin tests run each `src/meta/bin/*.ts` `main` with an injected fake client
and a temp cwd — no manual step needed. To eyeball output:

```bash
cd skills/adkit/scripts
npx vitest run src/meta/bin --reporter verbose
```

## 3. Live smoke test (once a Meta system-user token exists)

Read-only first, on a test or low-stakes ad account:

```bash
ads.sh init                                   # choose meta; paste token; act_<id>
ads.sh preflight                              # expect ok:true, steps credentials/auth/access/permissions
ads.sh report --days 7                        # expect <reports_dir>/<date>-act_<id>-raw.yaml
ads.sh audit --days 14                        # expect findings envelope, no changes in Ads Manager
```

Then a write test with a throwaway brief (everything is created PAUSED):

```bash
ads.sh create adbriefs/meta-smoke.yaml --dry-run   # diff + planned objects, nothing in Ads Manager
ads.sh create adbriefs/meta-smoke.yaml             # campaign/ad set/ad appear PAUSED
ads.sh create adbriefs/meta-smoke.yaml             # re-run: no duplicates
ads.sh update plan.yaml                            # dry run: diff + WARNING lines
ads.sh update plan.yaml --apply                    # change visible in Ads Manager
```

If any Graph call is rejected with an unsupported-version error, change
`GRAPH_API_VERSION` in `src/meta/client.ts` from `v26.0` to `v25.0` (see
research.md) and re-run.
