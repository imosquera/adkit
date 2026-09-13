# Research: Meta Ads parity (077)

All findings below come from live fetches on 2026-09-13 (npm registry, GitHub API, developers.facebook.com).

## Meta Graph/Marketing API client

**Candidates considered:** `facebook-nodejs-business-sdk` (official Meta SDK covering every Marketing API object), plain `fetch` against `https://graph.facebook.com/<version>/` (Node >=24 built-in, zero deps)
**Recommendation:** build custom
**Why:** The official SDK is actively generated on GitHub (v26.0.1 tagged 2026-08-25, `FacebookAdsApi.VERSION` hard-coded to `'v26.0'`), but npm's `latest` is still 24.0.1 from 2025-11-21, so the published package pins a Marketing API version that expires 2026-10-06. It ships CommonJS only (`main: ./dist/cjs.js`, no `exports`/`types`; Flow-typed, community `@types` stuck at 24.0.0), weighs ~30.9 MB unpacked across 1170 files, pulls in axios/mixwith and five other deps, uses the non-OSI "Facebook Platform License", and models every entity as a class (`AdAccount`, `Campaign`, `Cursor`), which conflicts with the no-classes rule. The endpoints we need are a small set of form-encoded GET/POST calls, so a thin `fetch` wrapper with zod-parsed responses is less code to own than adapting the SDK's object model.

## Retry/backoff for HTTP

**Candidates considered:** `p-retry` (Sindre Sorhus; ESM-only, bundled types, MIT, v8.0.1 released 2026-09-01, Node >=22, one dep `is-network-error`), `exponential-backoff` (Apache-2.0, v3.1.3, last modified 2026-05-13), custom ~20-line helper
**Recommendation:** build custom
**Why:** `p-retry` is well maintained and an ESM/TS fit, but the real logic is Meta-specific: classify `error.code` (1, 2 transient; 4, 17, 32, 613, 80000-80014 throttling), honour `error.is_transient`, and read `X-Business-Use-Case-Usage`'s `estimated_time_to_regain_access` / `X-Ad-Account-Usage`'s `reset_time_duration` for the wait. That classifier and delay function have to be written either way, and wrapping them in a recursive async retry loop is about 20 lines, so the library saves almost nothing. Meta's rate-limiting doc also warns that some 613 subcodes (for example 1487632, "change your ad set budget 4 times per hour") will not clear with a short backoff, so those need a non-retry path regardless.

## Graph API cursor pagination

**Candidates considered:** `facebook-nodejs-business-sdk` `Cursor` class (stateful, class-based, mutates itself on `next()`), `fbgraph` (MIT, last published 2022-06-17, unmaintained), `facebookgraph` (Apache-2.0, last published 2022-06-17, unmaintained)
**Recommendation:** build custom
**Why:** No maintained standalone library exists. The SDK's cursor is a mutable class, and the two small libraries have had no release since 2022. Meta's pagination contract is simple: follow `paging.next` until it's missing, and don't stop on an empty page, because "a page may be empty but contain a `next` paging link". That fits in a short async generator (or a recursive fold) over the `fetch` client with zod-parsed `{ data, paging }` pages. Cursors shouldn't be persisted, since they "will be invalidated if the item is deleted or removed".

## Video upload to /act_{id}/advideos

**Candidates considered:** `facebook-nodejs-business-sdk` `VideoUploader` (implements `upload_phase` start/transfer/finish chunking, but is class-based and CJS), custom non-chunked multipart `source` POST via `fetch` + `FormData`/`Blob`, custom chunked `upload_phase` loop
**Recommendation:** build custom
**Why:** The advideos reference supports a single-request `source` form-data upload, a `file_url` fetch, and a resumable `upload_phase` flow (start/transfer/finish/cancel with `upload_session_id`, `start_offset`/`end_offset`, `video_file_chunk`). Using the SDK's `VideoUploader` would bring in the whole SDK (see the first section). Ad creative videos are usually well under the size limit, so a non-chunked `source` POST (plus `file_url` when the asset is already hosted) is enough for the first version. Add the chunked `upload_phase` loop later only if large files show up. The ~1 GB simple-upload ceiling comes from third-party guides (roaspig.com); Meta's fetched pages (advideos reference, video-upload-limits) don't state a number, so enforce a conservative local size check and surface Meta's size error codes.

## Graph API version

- **Pin:** `v26.0`
- **Released:** July 29, 2026 (Graph API and Marketing API)
- **Expiry:** "Available until TBD" (no date announced yet). For comparison, Marketing API v24.0 expires October 6, 2026 and v25.0 (released February 18, 2026) is also TBD.
- **Sources:** https://developers.facebook.com/docs/graph-api/changelog/versions and https://developers.facebook.com/docs/graph-api/changelog/version26.0 (the Marketing API section reads "Released July 29, 2026 | Available until TBD").
- **Note:** The Marketing API versioning page (https://developers.facebook.com/docs/marketing-api/overview/versioning) and the marketing-api-changelog page still say v25.0 is current, and the versions page notes "Marketing API version auto-upgrade will release on July 29, 2026". Before implementation, verify that v26.0 calls work against a test ad account. If they don't, fall back to v25.0 (also expiry TBD).
