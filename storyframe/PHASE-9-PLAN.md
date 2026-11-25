# Phase 9 plan — video export through JSON2Video

**Status: draft, nothing implemented.** This file is the contract to build against. Every provider fact below was read
from <https://json2video.com/docs/v2/> on 2026-11-25 and is cited so it can be re-checked rather than remembered.

Phase 9 turns a saved project revision into a real MP4, stores that MP4 in the private `story-frame` bucket, and keeps
the spend visible and bounded. It does not add templates, voice generation, or a second video provider.

## Settled decisions (2026-11-25)

| Question | Decision |
| --- | --- |
| Default resolution | **`full-hd` (1920×1080)**; the document has no aspect ratio, so this is a stated default, overridable with `VIDEO_RESOLUTION` |
| Scene without an image/video asset | **Text-only card** over the provider's default background; no `background-color` is invented |
| Narration longer than the scene timeline | **Refuse** with `409 VIDEO_NARRATION_OVERFLOW`; speech is never cut, sped up, or stretched |
| Provider copy after a successful download | **Delete it** best-effort with `DELETE /v2/movies`, so the provider does not keep the file |
| Existing `POST /renders` contract | **Kept unchanged.** Video export gets its own `/api/projects/:id/exports/video` routes instead of repurposing the generic render-snapshot write |

### Slice 1 scope

Slice 1 ships submit → poll → single copy → playback → spend guard. Deferred to a later slice, and marked `Later:` in
place below:

- copy retries and the `providerUrl` recovery path (slice 1 copies once; a failed copy is terminal and leaves the
  provider URL recorded),
- the `…/refresh` endpoint (slice 1 advances status through the sweep only),
- the per-account renders-per-day limit (slice 1 guards credits only),
- cancellation of any kind (the provider has none either).

---

## 0. Verified provider facts

| Fact | Value | Source |
| --- | --- | --- |
| Base URL, auth | `https://api.json2video.com/v2/`, header `x-api-key` | `/docs/api`, `/docs/v2/getting-started/quickstart` |
| Submit | `POST /v2/movies` → `{ success, project, timestamp }`; `project` is 16 characters; render is asynchronous | `/docs/v2/reference/api-endpoints/movies-create` |
| Poll | `GET /v2/movies?project=<id>&format=simple` → `movie.status`, `url`, `thumbnail`, `duration`, `size`, `consumed_credits`, `remaining_quota` | `/docs/v2/reference/api-endpoints/movies-status` |
| Status enum | `pending`, `running`, `done`, `error`, plus client-computed `timeout` when `running` and `created_at` is older than 15 minutes | same |
| Failure semantics | Render failures arrive as HTTP `200` with `movie.success: false` and `movie.status: "error"`; `movie.message` is not a stable identifier | `/docs/v2/reference/errors` |
| Sync errors | `400` validation **or bad/missing key**, `401` quota or not enough credits, `403` role or `account_suspended`, `404` not found, `413` movie JSON over 2 MB, `500` transient | same |
| Cost | **1 credit per second of output**, any resolution; failed renders are not billed; `consumed_credits` is a per-step breakdown | `/docs/v2/reference/credits/credit-consumption` |
| USD rate | **Not documented.** No credits-to-USD rate is published, so this phase never reports a dollar cost for a render. | same |
| Output file | `assets.json2video.com/.../<project>.mp4`, **deleted after 7 days**; `DELETE /v2/movies` deletes it immediately (and its thumbnail/audio/ass file) | `/docs/v2/reference/api-endpoints/movies-status`, `/docs/v2/reference/json-syntax/movie` |
| Output destinations | `webhook`, `ftp`, `sftp`, `email`, and **Amazon S3 only**. “S3-compatible services that use their own endpoint (Cloudflare R2, …) are not [supported].” | `/docs/v2/guides/production/amazon-s3` |
| Movie JSON size | 2 MB maximum per `POST /v2/movies` | `/docs/v2/reference/api-endpoints/movies-create` |
| Element durations | `duration: -1` natural length, `-2` match parent scene/movie | `/docs/v2/reference/json-syntax/element/audio`, `.../video` |
| Output frame rate | Every movie renders at **25 fps**; `fps` is validated but not applied | `/docs/v2/reference/json-syntax/movie` |
| Correlation | `client-data` is returned verbatim by `GET /v2/movies` (hyphenated; `client_data` is rejected) | same |
| Cancellation | There is no cancel endpoint. `DELETE /v2/movies` deletes a finished file; a queued/running render cannot be stopped. | `/docs/api` |

**Consequence that shapes the whole phase:** because R2 cannot be an output destination, JSON2Video cannot write into
our bucket. The server must download the finished MP4 and re-upload it through the existing private-media path.
Credits are also account-level, so the guard has to be ours, before submission.

---

## 1. Render contract

### 1.1 Preconditions (all checked before any provider call or spend row)

- [ ] `POST /api/projects/:id/exports/video` requires `Idempotency-Key`; a replay with the same key returns the existing
      export row and never submits (or bills) twice.
- [ ] At least one scene, and a total of `1–VIDEO_MAX_SECONDS` seconds (default `600`).
- [ ] Every scene is approved with a matching `approvedFingerprint` — the same gate Phase 8 uses, so a render is pinned
      to wording that was actually approved. `409 VIDEO_SCRIPT_NOT_APPROVED`.
- [ ] The project revision named in the body exists (`projectRevision`), so `render_snapshots` keeps its composite
      foreign key. A stale revision is `409 PROJECT_REVISION_NOT_FOUND`.
- [ ] If an active narration track exists: it is not stale (`fingerprint` matches the current approved script,
      `409 VIDEO_NARRATION_STALE`) and its **measured** duration fits inside the scene timeline plus
      `VIDEO_TIMING_TOLERANCE_SECONDS` (default `0.5`). A longer track is refused with `409 VIDEO_NARRATION_OVERFLOW`
      and the scene/second numbers in the message. A narration shorter than the timeline is allowed and ends early.
- [ ] Every `scene.assetIds` entry used as a visual is `ready`; a pending or deleted asset is `409 VIDEO_MEDIA_NOT_READY`.
      Audio assets in `assetIds` are ignored (narration and music are attached separately).
- [ ] A scene with no image/video asset renders as an on-screen-text card over the provider's default background (settled
      decision). The response reports `scenesWithoutVisual` so the caller knows.
- [ ] Provider not configured (`JSON2VIDEO_API_KEY` absent) → `503 VIDEO_PROVIDER_DISABLED`, no row, no call.

### 1.2 Movie JSON mapping

Built by a pure function in `server/json2video.ts` → `shared/video-contract.ts`, unit-testable without network access.

| Document input | Movie JSON |
| --- | --- |
| movie canvas | `resolution: "full-hd"` (`1920x1080`) by default, overridable with `VIDEO_RESOLUTION` |
| project + revision | `client-data: { renderId, projectRevision }`, used to correlate a poll result with our row |
| scene order | `scenes[]` in document order |
| `scene.durationSeconds` | `scenes[i].duration` rounded to 3 decimals |
| first ready image asset | `{ type: "image", src: <presigned GET>, duration: -2, resize: "cover", position: "center-center" }` |
| first ready video asset | `{ type: "video", src: <presigned GET>, duration: -2, resize: "cover", position: "center-center", muted: true }` — muted so the clip's own audio cannot fight the narration |
| `scene.onScreenText` | `{ type: "text", text, x: "center", y: "bottom" }`; omitted when empty |
| active narration | movie-level `{ type: "audio", src: <presigned GET>, duration: -1, volume, muted }` |
| active music | movie-level `{ type: "audio", src: <presigned GET>, duration: -2, loop: -1, volume, muted }` |

Rules that keep this honest:

- [ ] No `voice` element and no `subtitles` element. Phase 8 explicitly provides no word-level timings, so Phase 9 does
      not generate subtitles and does not let the provider invent them. On-screen text is the document's own text.
- [ ] No `exports[]` (no webhook, no S3, no email). Output is fetched by us; nothing is delivered to a third party.
- [ ] `quality: "high"`, `cache` left at its default and documented: an identical movie may return a cached render.
      `fps` is not sent because the provider ignores it and always renders 25 fps.
- [ ] Asset-less scenes are text-only cards; no `background-color` is sent in slice 1.
- [ ] The built JSON is asserted under the 2 MB body limit before submission; over the limit is
      `422 VIDEO_MOVIE_TOO_LARGE` with the byte count, never a raw provider `413`.
- [ ] Maximum of 50 scenes and 2 000 characters per text element are re-validated here, not assumed from the editor.

### 1.3 Temporary input access (the deferred Phase 8 concern)

- [ ] Each media input gets a fresh presigned `GET` with TTL `VIDEO_INPUT_URL_SECONDS`, default `7200` (2 h), floor
      `1200` (20 min — longer than the provider's 15-minute render timeout) and ceiling `604800` (the SigV4 maximum).
- [ ] The TTL must cover queueing + attempt + the 15-minute render window; a retry **re-presigns** instead of reusing
      the previous URL.
- [ ] Signed URLs are substituted at submission and are **never** written to `provider_jobs.request`, the render result,
      logs, or the browser. The stored request keeps object keys, the document revision, and the URL expiry timestamps.
- [ ] Unit tests fail if a presigned query string (`X-Amz-Signature`) appears in a stored request or a response body.
- [ ] The provider fetches over the public internet, so no bucket CORS change is needed for this path (CORS stays as the
      browser-upload rule already documented).

### 1.4 Routes (separate from the existing `/renders` contract)

Everything lives under the project's export namespace; `GET`/`POST /api/projects/:id/renders` and
`PATCH /api/projects/:id/jobs/:jobId` keep their current generic behavior and are not modified.

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/projects/:id/exports/video` | POST | Submit a render for `projectRevision`; requires `Idempotency-Key`; `202` with `export` + `job` |
| `/api/projects/:id/exports/video` | GET | List this project's video exports, newest first |
| `/api/projects/:id/exports/video/:exportId` | GET | One export: status, provider status, duration/size/dimensions, failure code, spend |
| `/api/projects/:id/exports/video/:exportId/url` | GET | Short-lived presigned playback URL once `ready`; `409 VIDEO_RENDER_NOT_READY` otherwise |
| `/api/projects/:id/exports/video/:exportId` | DELETE | Release the render reference and delete the stored MP4; the provider copy is deleted best-effort |

- [ ] The export routes are registered before the generic `/renders` handler and use their own `exportId` path segment,
      so a malformed id cannot fall through to the child-table routes.
- [ ] `Later:` `POST /api/projects/:id/exports/video/:exportId/refresh` (poll on demand). Slice 1 poll happens in the
      sweep; `GET` never triggers a provider call.

---

## 2. Job lifecycle and recovery

State lives in Postgres, never in process memory, so a restart resumes instead of orphaning a paid render.

```
pending → (provider done) → ready
   ↓             ↓
 failed       failed (single copy attempt in slice 1)
```

- [ ] Reuse `provider_jobs` (`provider: "json2video"`, `external_id` = the 16-character project id, `request` = stored
      plan without signed URLs, `result` = status snapshot, dimensions, `consumed_credits`, `providerUrl` + its expiry).
- [ ] Reuse `render_snapshots` for the export row; migration adds `media_id`, `job_id`, `failure_code`, `provider_status`,
      `duration_seconds`, `byte_size`, `width`, `height`, `credits_estimate`, `credits_consumed`, `idempotency_key`,
      `provider_url_expires_at`. The existing `pending/ready/failed` status check is unchanged, so `ready` still means
      "the MP4 is ours".
- [ ] One live export per project: partial unique index on `render_snapshots (project_id) where status = 'pending'` and on
      `provider_jobs (project_id) where status in ('queued','running')`. A second request while one is live is
      `429 VIDEO_RENDER_IN_FLIGHT` and costs nothing.
- [ ] One paid submission per account at a time, mirroring the narration in-flight set, so two tabs cannot double-submit.
- [ ] Submission: reserve spend → create `render_snapshots` (`pending`) → create `provider_jobs` (`queued`) → POST.
      A `2xx` stores `external_id` and moves both to `running`. A definitive `400` (validation / bad key) marks both
      `failed` and settles the spend row at 0; `500` is retried with exponential backoff (max 3) because the docs state
      nothing was created or charged.
- [ ] Polling: `GET /v2/movies?project=…&format=simple` from a sweep every `VIDEO_SWEEP_INTERVAL_MS` (default `60000`)
      while at least one live row exists, advancing rows even when no request arrives. One pass at a time; a failing pass
      logs and the next still runs (the Phase 3/7 scheduler pattern). An explicit per-poll interval
      (`VIDEO_POLL_INTERVAL_MS`) is not needed in slice 1; the sweep is the only clock.
- [ ] Status mapping: `pending`/`running` stay live; `done` → copy; `error` → `failed` with a mapped code and the
      provider's message stored (never surfaced raw to the browser); `timeout` or age over `VIDEO_RENDER_TIMEOUT_MS`
      (default `20 min`) → `failed VIDEO_RENDER_TIMEOUT`; the provider's `400 Movie … not found` → `failed
      VIDEO_JOB_NOT_FOUND` and polling stops (retrying cannot succeed).
- [ ] Abandonment: a live row older than `VIDEO_ABANDON_AFTER_MS` (default `45 min`) is settled `failed
      VIDEO_RENDER_ABANDONED` by the sweep, so a stuck row cannot block the project forever. The provider copy is deleted
      best-effort and never copied.
- [ ] No cancel: there is no provider cancel endpoint, so the API does not offer one and says so in the UI. Credits
      already consumed are still recorded; a later completion is not copied.
- [ ] Recovery after a restart: the sweep finds live rows by status and age, re-polls with the stored `external_id`, and
      continues. Nothing depends on in-memory timers, and no render is resubmitted because of a restart.
- [ ] Crashes: a process that dies mid-copy leaves the row `pending` with the provider copy still intact (the delete only
      runs after a successful store), so the next sweep re-polls and copies once. A copy that *fails* is terminal in
      slice 1 — this is crash recovery, not the deferred retry path.
- [ ] Idempotency: replaying the same `Idempotency-Key` returns the same export/job; a different key while an export is
      live is `429 VIDEO_RENDER_IN_FLIGHT`.
- [ ] Provider `401`/`403` (quota, suspended account) → `429 VIDEO_PROVIDER_QUOTA` with the account-level meaning, the
      job marked `failed`, and the spend row settled at 0 (nothing was rendered).

### 2.1 Migration: `20261126090000_add_video_render_jobs.sql`

- [ ] New columns on `render_snapshots` and `provider_jobs` as above; **no status-enum change**.
- [ ] Both partial unique indexes, plus a unique index on `(owner_id, idempotency_key) where idempotency_key is not null`.
- [ ] `media_id` references `media_metadata (id)` on delete set null; `job_id` references `provider_jobs (id)` on delete
      set null; owner/project columns keep the existing composite `(project_id, owner_id)` shape.
- [ ] RLS stays select-own; writes stay `service_role` only — the same `DO` block pattern as the other child tables.
- [ ] `verify:sql` applies the new migration and asserts: both unique indexes reject a second live row, `ready` is
      allowed twice, the idempotency index rejects a duplicate non-null key but allows many nulls, and the auth-user /
      project cascades still remove render rows.

---

## 3. Output storage

- [ ] Copy starts only on `status: "done"` **and** a non-empty `url`, in the same sweep pass that observed it. The
      provider copy expires after 7 days; our bucket copy is the durable one, and the UI never links to
      `assets.json2video.com`.
- [ ] Download guard: `https` only; host must be `assets.json2video.com` (the stock-import host check pattern), no
      redirects to another host, `VIDEO_DOWNLOAD_TIMEOUT_MS` (default `60000`), and a hard cap of `VIDEO_MAX_BYTES`
      (default `268435456`, 256 MiB) enforced while streaming, not from `Content-Length` alone.
- [ ] Bytes must be a real MP4/WebM/MOV via the existing `detectMediaType` magic-byte check and a `video` kind, otherwise
      `failed VIDEO_OUTPUT_INVALID` and nothing is stored.
- [ ] Store through the existing private-media path: reserve `media_metadata` (`pending`, `object_key =
      media/<owner>/<mediaId>`), server-side presigned `PUT`, then the normal completion verification (HEAD size, byte
      detection) so the row lands `ready` with the detected content type and real size.
- [ ] Link both records: `render_snapshots.output_key` = the media object key, `render_snapshots.media_id` = the media id,
      and one `media_references` row with `ref_kind = 'render'` pointing at the render id — so retention cannot delete a
      finished render while its row exists.
- [ ] Playback goes through `GET /exports/video/:exportId/url` with the normal short-lived media URL TTL. The browser
      never sees a bucket key or credential.
- [ ] Slice 1 copy is a **single attempt**. A failure is `failed VIDEO_OUTPUT_COPY_FAILED`, the partial object is deleted,
      and the provider URL plus its expiry stay in `result` so a later slice can add retries. `Later:` up to 3 copy
      attempts with one reused pending media row.
- [ ] After a successful copy, `DELETE /v2/movies` is called best-effort to shorten how long the provider keeps the file;
      a failure is logged and does not fail the render (settled decision).
- [ ] Deleting an export (or the project) deletes the media row and its object through the existing media deletion and
      project-cleanup paths; a second delete is `404`, not a partial state.
- [ ] Storage limits: video output counts against the same per-account media quota, checked before the copy, so a full
      account fails cleanly instead of half-writing an object.

---

## 4. Spending guard

JSON2Video bills **1 credit per second of output** and reports no USD price, so the guard and the UI speak in credits and
seconds. A dollar figure is not invented.

- [ ] `video_usage` table (`20261126100000_create_video_usage.sql`): `id`, `owner_id`, `project_id` (nulled on project
      delete, not deleted — the Phase 8 rule, so a replacement project cannot reset the window), `render_id`,
      `status pending/succeeded/failed`, `credits_estimate`, `credits_counted`, `duration_seconds`,
      `rate_version = 'json2video-2026-11-25'`, timestamps.
- [ ] `reserve_video_usage(...)` RPC: one transaction, per-owner advisory lock, totals the rolling
      `VIDEO_SPEND_WINDOW_HOURS` (default 24) window, then inserts the pending row with
      `credits_estimate = ceil(total scene seconds)`. Limit: `VIDEO_DAILY_CREDITS_PER_USER` (default `600` = 10 rendered
      minutes). Refusal is `429 VIDEO_BUDGET_EXCEEDED` with used/limit/reset, and no provider call is made.
      `Later:` a per-account renders-per-day cap.
- [ ] The reservation is written **before** `POST /v2/movies`, exactly like the Deepgram ledger.
- [ ] Settle on completion: `credits_counted` = sum of `consumed_credits` when the provider returns them, otherwise the
      actual `duration` (rounded up), and `duration_seconds` = the real output length. A run that fails before the
      provider accepted it settles `credits_counted = 0` (the docs state failed renders are not billed).
- [ ] An ambiguous failure (network error after submission, no confirmed rejection) keeps `credits_counted =
      credits_estimate`. Failed rows therefore still consume the window, which is the conservative direction.
- [ ] The function is executable only by `service_role`; authenticated reads of `video_usage` are own-row only, and the
      browser never calls the RPC.
- [ ] `GET /exports/video` returns the window summary (credits used/limit, reset time) next to each export, and the UI
      shows it before the export button, like the Narration tab.
- [ ] Provider-side `remaining_quota` from the status response is displayed read-only and never treated as the guard.

---

## 5. Tests checklist

### Unit and route tests (no network, fake provider + fake Supabase)

- [ ] `tests/json2video.test.ts`: submit URL/headers/body shape; `x-api-key` never echoed; every documented error class
      mapped (`400` validation vs bad key, `401` quota, `403` suspended, `404`, `413`, `500` retryable); status mapping
      including `timeout`; `consumed_credits` parsing; no key or signed URL in any error message.
- [ ] `tests/video-render.test.ts`: movie JSON for image/video/text/narration/music scenes; `duration` values; audio
      assets in `assetIds` ignored; asset-less scene produces a text card with no `background-color`; unapproved scene
      refused with no call; narration stale/overflow refused; revision missing; too-long timeline; over-2 MB body; asset
      not ready; presign TTL bounds enforced; `X-Amz-Signature` never present in the stored `request`.
- [ ] `tests/video-exports.test.ts`: submit → `running` → `done` → copy → `ready` with a byte-identical object; provider
      `error` → `failed` with the mapped code; `timeout` → `VIDEO_RENDER_TIMEOUT`; not-found → stop polling; abandon;
      one-live-export guard; idempotent replay returns the same row and submits once; a failed copy is terminal, deletes
      the partial object, and keeps `providerUrl`; over-credit refusal makes zero provider calls; ambiguous failure keeps
      its credits; settle uses `consumed_credits` when present; sweep resumes after a simulated restart; the generic
      `POST /renders` still behaves exactly as before.
- [ ] `tests/video-panel.test.tsx`: the Preview tab replaces “rendering belongs to Phase 9” with **Export video**, shows
      the credit estimate before submitting, a live status, the failure reason, playback of the finished MP4, and the
      rolling credit line; the button is disabled with a reason for unapproved scenes or a stale narration.
- [ ] `tests/fake-supabase.ts`: `video_usage` rows + `reserve_video_usage` RPC, the new render columns, partial-unique
      behaviour, the idempotency index, and the unchanged status check.
- [ ] The existing render-snapshot and job tests stay green without edits, proving the `/renders` contract was not
      repurposed.

### SQL

- [ ] `scripts/verify-sql.ts` adds `20261126090000_add_video_render_jobs.sql` and
      `20261126100000_create_video_usage.sql`, then asserts the new constraints, both partial unique indexes, the
      idempotency index, the reservation RPC's grant (`42501` for authenticated), budget refusal/allowance,
      project-delete preservation (`project_id` nulled, rows kept), and account-delete cascade.
- [ ] Re-run and record the new total (baseline `113/113` on 2026-11-25; the Phase 8 closure figure is current).

### Opt-in live check

- [ ] `scripts/verify-video-live.ts` + `npm run verify:video-live`, following the existing live-script shape (disposable
      hosted account, real Supabase, real `story-frame` bucket, printed `N/N` and non-zero exit on any failure).
- [ ] Fixture: two scenes, one small image, narration attached from an existing uploaded track (no new Deepgram spend).
      Target duration ≤ 6 seconds, so the run costs about 6 credits — stated in the script header and the README.
- [ ] Asserts: preflight quote, reservation row before submit, provider accepted, status reaches `done` after a sweep,
      MP4 downloaded and stored in R2, `media_metadata` ready with detected `video/*`, export `ready` with real
      duration/size/dimensions, spend row settled with `credits_counted`, playback URL returns those bytes, a second
      submit while live is `429`, over-budget refuses without a provider call, the provider copy is deleted, export
      delete removes row and object, account cleanup.
- [ ] If `JSON2VIDEO_API_KEY` is absent the script prints a clear skip and exits non-zero only with `--require-live`, so a
      missing key is never reported as a pass.

### Documentation

- [ ] README: a Phase 9 section (provider facts, mapping table, lifecycle, guard, limits), a verification table with the
      measured numbers, the route list, and `.env.example` keys with defaults and bounds.
- [ ] README route table gains the `/exports/video` rows and leaves the `/renders` rows untouched.
- [ ] README roadmap line changes from “Phase 9 … has not been started” to the implemented state only when it is true.
- [ ] Stated limits: no cancel, no subtitles/word timings, no USD estimate, one provider, 25 fps, single copy attempt,
      provider copy deleted best-effort after a successful download.

---

## 6. Configuration (`.env.example`)

| Key | Default | Bound |
| --- | --- | --- |
| `JSON2VIDEO_API_KEY` | empty (provider disabled) | secret, server only |
| `VIDEO_RESOLUTION` | `full-hd` | documented enum |
| `VIDEO_TIMEOUT_MS` | `30000` | 5 s – 120 s |
| `VIDEO_SWEEP_INTERVAL_MS` | `60000` | 5 s – 600 s |
| `VIDEO_RENDER_TIMEOUT_MS` | `1200000` | ≥ 15 min (provider timeout) |
| `VIDEO_ABANDON_AFTER_MS` | `2700000` | > render timeout |
| `VIDEO_INPUT_URL_SECONDS` | `7200` | 1200 – 604800 |
| `VIDEO_DOWNLOAD_TIMEOUT_MS` | `60000` | 5 s – 300 s |
| `VIDEO_MAX_BYTES` | `268435456` | 1 MiB – 1 GiB |
| `VIDEO_MAX_SECONDS` | `600` | 1 – 3600 |
| `VIDEO_TIMING_TOLERANCE_SECONDS` | `0.5` | 0 – 5 |
| `VIDEO_DAILY_CREDITS_PER_USER` | `600` | `0` disables the dimension |
| `VIDEO_SPEND_WINDOW_HOURS` | `24` | 1 – 168 |

`VIDEO_POLL_INTERVAL_MS` and `VIDEO_DAILY_RENDERS_PER_USER` arrive with the deferred slice, not now.

---

## 7. Build order

1. `shared/video-contract.ts` + `server/json2video.ts` (types, movie builder, adapter, cost math) with unit tests.
2. Migrations + `verify:sql` additions.
3. `server/video-exports.ts` (store, lifecycle, single copy, guard) + `/exports/video` route wiring + fake-provider tests.
4. Sweep + restart/abandon tests.
5. Preview-tab export UI + DOM test.
6. `verify:video-live` against real JSON2Video/R2/Supabase.
7. README + `.env.example`, then `npm run check`, `npm test`, `verify:sql`, `audit:media`, `verify:video-live`.

---

## 8. Remaining blocker before the live run

1. **`JSON2VIDEO_API_KEY` is not configured** in this workspace. Code and all offline tests can be written without it, but
   the live check and any real acceptance run need the key as a project secret (never in chat).
2. **USD per credit is undocumented.** The plan reports credits and seconds only. If a verified rate is supplied, add a
   rate version and a USD line; do not derive one from a plan price.
