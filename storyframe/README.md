# StoryFrame — Phase 2: Supabase auth, usage ledger, and project data model

This repository state implements the first Phase 2 slices: a **server-verified Supabase session boundary**, a
**durable, idempotent usage ledger** for the existing AI endpoints, and the **project data model** (`projects`,
`project_revisions`, their child tables, and per-user profiles) with owner-scoped access. The Phase 1 Ollama connection and its bounded test endpoint remain, now
behind real sessions and request-level idempotency keys.

The connection-test screen now uses real Supabase email/password sign-in, refreshes its session through the Supabase
client, and signs out. It remains a development harness only. The workspace UI, scene generation, R2, rendering,
billing, discovery, and deployment are **not** started here.

## Architecture

```
Browser (Vite + React) → Supabase Auth      (email/password, refresh, sign-out)
      └─ /api/ai/test       (current Supabase access token)
      ↓ Vite dev proxy (development only)
Node server (127.0.0.1:8787)
      ├─ Supabase Auth  GET /auth/v1/user  → verified user id
      ├─ Supabase REST  POST /rest/v1/ai_usage → pending reservation
      ├─ Ollama Cloud   POST /api/chat         → final reply
      └─ Supabase REST  PATCH /rest/v1/ai_usage → stored outcome
```

- The browser never receives the Ollama key or the Supabase service-role key.
- User identity always comes from the verified Supabase session; a client-supplied owner id is rejected.
- A billable call is refused unless Supabase auth, the usage ledger, and the Ollama key are all configured.
- `POST /api/ai/test` remains bounded: 4 KB body, 500-character prompt, 120 output tokens, 30 s provider timeout, one
  concurrent request per account, six requests per minute per account, no automatic retries.
- Every test request requires an `Idempotency-Key`. A unique `(user_id, idempotency_key)` reservation is written before
  the provider call, so a retry cannot bill twice.
- A reservation left `pending` by a dead request is settled as `REQUEST_ABANDONED` on a later retry, without calling the
  provider (see `POST /api/ai/test`).
- `GET /api/ai/usage` returns the caller’s own recent completed ledger rows.
- `/api/projects` reads and writes only the caller’s own projects: every query filters on the verified owner id, and
  revision history is written by a database trigger.

Row-level security is enabled on the ledger: authenticated users may only `select` their own rows; writes are made
with the server-only service role. Server-side isolation is also enforced explicitly by filtering reads on the
verified user id.

**This is still a development arrangement, not a production hosting solution.** The Node process is loopback-only and
reached through the Vite dev proxy. Production hosting, durable cross-instance quotas, and broader account flows (sign-up, password reset, MFA, OAuth)
remain future work.

## Run locally

```bash
cd storyframe
npm install
cp .env.example .env
# fill in Ollama + server Supabase values, plus the two VITE_ browser auth values
npm run dev
```

`npm run dev` starts:

- API: `http://127.0.0.1:8787`
- Web: `http://localhost:3000` (Vite proxies `/api` to the API)

Before using the ledger or any project route, apply the five migrations in order. See
[Applying the migrations](#applying-the-migrations) for the compatibility check that must pass
first and the current state of the configured project.

Other commands:

```bash
npm run check             # TypeScript type-check (app, server, scripts, tests)
npm test                  # Vitest (mocked provider + fake Supabase)
npm run build             # type-check + production frontend build
npm run smoke:live        # opt-in: five real requests + ledger check (see Tests)
npm run verify:live-routes # provider-free two-user live route + ledger checks
npm run verify:sql        # apply every migration to in-memory PostgreSQL and assert RLS, triggers, cascades
npm run start:server      # server without watch
```

For an external preview hostname, allow it explicitly instead of using a blanket allowlist:

```bash
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<preview-hostname> npm run dev
```

## Applying the migrations

`npm run verify:sql` proves the five files against a real PostgreSQL engine before they touch a
hosted project. They are written for a project whose `public` schema does not already contain
these tables. Apply them in filename order:

1. `20261124090000_create_ai_usage.sql`
2. `20261124100000_add_ai_usage_idempotency.sql`
3. `20261124120000_create_projects.sql`
4. `20261124140000_create_project_children.sql`
5. `20261124150000_create_profiles.sql`

Run the compatibility check first. It must return no rows:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'ai_usage', 'projects', 'project_revisions', 'scenes', 'media_metadata',
    'sources', 'claims', 'generation_proposals', 'provider_jobs',
    'render_snapshots', 'profiles'
  );
```

Then apply the files with the CLI, or paste each one into the Supabase SQL editor in the same
order:

```bash
supabase link --project-ref <project-ref>
supabase db push          # applies supabase/migrations in filename order
```

Afterwards, check the running server rather than assuming the schema is ready:

1. `GET /api/ai/status` must report `auth.configured: true` and `ledger.ready: true`.
2. With a real session token, read and write `GET/PUT /api/profile`, create one project, and
   list one child table. A `503` with `PROJECTS_UNAVAILABLE`, `PROFILE_UNAVAILABLE`, or
   `CHILD_STORE_UNAVAILABLE` means the hosted columns still do not match these files.
3. Set `SMOKE_SUPABASE_ACCESS_TOKEN` to a session token and run `npm run smoke:live` (five
   billable calls, described under Tests).

**Applied to the configured project on 2026-11-24.** The obsolete `public` schema in
`myrohtkfsuppcabedwmn` (16 tables from an earlier project, plus `public.handle_new_user()` attached
to `auth.users`) was exported first — six `model_registry` rows and a catalog snapshot — and then
replaced with these five migrations. The hosted schema now has the 11 tables listed above, RLS and
one select-own policy on each, and the `projects_record_revision` trigger; the old `auth.users`
trigger is gone. `GET /api/ai/status` reports `ledger.ready: true`. Live profile, project, child, and
two-user isolation routes were then exercised with disposable users; those users and their rows were
deleted afterwards. `npm run smoke:live` was run twice: the first five-call run exposed a missing
`status` column in the reservation lookup, and after the fix the second five-call run exited 0 with
5/5 families and an identical stored replay. The project is empty again. Keep the compatibility
check above for any other project.

## Environment

### Browser-visible Supabase Auth

These values are compiled into the Vite client and are public configuration. Use only the publishable (or legacy
anon) key; never the service-role key.

| Name | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL used by the browser auth client. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key used by the browser auth client. `VITE_SUPABASE_ANON_KEY` is accepted as a fallback. |

### Server-only

| Name | Purpose |
| --- | --- |
| `OLLAMA_API_KEY` | Ollama Cloud bearer key. Read only in the Node process. |
| `OLLAMA_BASE_URL` | Must be `https://ollama.com`; other values are refused. |
| `SUPABASE_URL` | Supabase project URL used for Auth and the ledger. |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key sent as `apikey` to Auth. `SUPABASE_ANON_KEY` is accepted as a fallback. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for ledger reads/writes. Never expose it to the browser. |
| `AUTH_TIMEOUT_MS` | Supabase Auth/ledger timeout (default 5000). |
| `OLLAMA_MODEL_*` | Optional exact-request-id overrides for the six families. |
| `AI_TIMEOUT_MS`, `AI_MAX_PROMPT_CHARS`, `AI_MAX_OUTPUT_TOKENS`, `AI_MAX_REQUESTS_PER_MINUTE` | Optional bounds. |
| `AI_ABANDON_AFTER_MS` | Age at which a pending reservation may be settled as abandoned instead of retried (default 90000, floored at the provider timeout plus three auth timeouts). |
| `APP_ORIGIN` | Optional additional origin restriction for API calls. |
| `SMOKE_SUPABASE_ACCESS_TOKEN` | Only for `npm run smoke:live`; a valid session token. Never commit it. |

`.env` is git-ignored; `.env.example` contains placeholders only. Only public Supabase auth configuration uses a
`VITE_` name; no secret is prefixed with `VITE_`, returned by the API, logged, or placed in a URL. The Supabase client
persists session tokens in browser `localStorage` and sends them only to the Node server in the `Authorization` header.

## Authentication

The browser creates a Supabase client with `persistSession` and `autoRefreshToken` enabled. The sign-in screen posts an
email and password to Supabase Auth; an existing session is restored on load. The server still verifies the resulting
access token on every AI and data route. Before a request, the app reads the current session with `getSession()` and
sends the token it returns; the Supabase client refreshes inside its own 90-second pre-expiry margin and single-flights
concurrent refreshes, so the app never starts a second refresh of its own. `onAuthStateChange` updates the screen on
sign-in, token refresh, and sign-out. Sign-out uses `scope: "local"`: it clears this browser's stored session and leaves
the account's other sessions active. Sign-out is paused while a billable request is in flight so its reply is not lost.

There is no sign-up, password-reset, MFA, or OAuth flow yet. The test screen remains a development harness, not a
production account-management UI.

## API

### `GET /api/ai/status`

Safe configuration data: provider key presence, Supabase auth presence, ledger configuration and **readiness**, fixed
upstream, catalog check date, bounds, and the allowlisted models. Readiness probes the columns added by both `ai_usage`
migrations, so a configured but unmigrated project reports `ledger.ready: false`. No keys or session tokens are
returned.

### `POST /api/ai/test`

Headers:

- `Authorization: Bearer <Supabase access token>`
- `Content-Type: application/json`
- `Idempotency-Key: <8-128 chars: A-Z a-z 0-9 . _ : ->`

```json
{
  "model": "gemma",
  "prompt": "Write one short welcome sentence for StoryFrame."
}
```

The server verifies the session, validates the key, and inserts a `pending` reservation before contacting Ollama. The
unique `(user_id, idempotency_key)` index means only one request can own an attempt, including across processes. The
server then calls `https://ollama.com/api/chat` with `stream: false`, `think: false` and `options.num_predict`, stores
the exact success or sanitized error response, and returns only the final `message.content` plus the returned model,
measured latency, and the usage counts Ollama supplied.

Reusing the same key with the same model and prompt returns the stored response without calling Ollama. Reusing it for a
different request returns `409 IDEMPOTENCY_KEY_REUSED`. If the original is still pending, the server returns
`409 IDEMPOTENCY_IN_PROGRESS`. A completed reservation with no stored response (for example a partially written row)
returns `503 IDEMPOTENCY_REPLAY_UNAVAILABLE` instead of re-billing the provider. A key is scoped to the verified user,
so two accounts may use the same key and each attempt is billed once. Use a new key only for a genuinely new attempt.

If the original is still `pending` but older than `AI_ABANDON_AFTER_MS` (default 90 s, never below the provider timeout
plus three auth timeouts), the server assumes that attempt died. It settles the row as a terminal `error` with
`REQUEST_ABANDONED` (HTTP 409, no token counts, zero latency) and returns that response **without contacting Ollama**,
because the original attempt may already have been billed. That key then replays `REQUEST_ABANDONED` for good: only a
new key starts a new paid attempt. The settlement is conditional on the row still being `pending`, still owned by the
caller, and still older than the threshold, so a concurrent completion wins the race and is replayed instead. The
completion write is likewise filtered by the verified caller's user id, so a mismatched reservation id cannot settle
another account's row.

A completion write that fails after Ollama answered is retried once. If it still cannot be recorded, the reply is
returned anyway (HTTP 200) with `X-Storyframe-Usage: unrecorded`, because the provider was already paid for it, and no
second provider call is made. The same header is sent when the conditional completion matches no `pending` row: the
reservation was settled elsewhere, usually as `REQUEST_ABANDONED` by a concurrent retry. A response lost after a
committed write also produces this warning, so it means "not confirmed" rather than proof the row is absent. In the
write-failure case the key stays `pending`, so a later retry can only settle it as `REQUEST_ABANDONED`: the reply was
delivered but the ledger never learned it. The development screen shows that header as a warning beside the reply
instead of an ordinary success.

The development screen keeps one key per attempt while the outcome is unknown (a network failure or an in-progress
request) and starts a fresh key after a recorded outcome — success, a provider error, or `REQUEST_ABANDONED` — so a
recorded failure can be retried without replaying the cached error.

### `GET /api/ai/usage`

Returns the caller’s 20 most recent ledger rows:

```json
{
  "ok": true,
  "usage": [
    {
      "id": "…",
      "modelId": "gemma",
      "configuredModel": "gemma4:31b",
      "returnedModel": "gemma4:31b",
      "promptEvalCount": 22,
      "evalCount": 13,
      "latencyMs": 777,
      "status": "success",
      "errorCode": null,
      "upstreamStatus": null,
      "createdAt": "2026-11-24T…"
    }
  ]
}
```

### `GET /api/profile` and `PUT /api/profile`

Both routes use the verified session only; the owner id never comes from the request body.

- `GET` returns the caller's own workspace record, or `404 PROFILE_NOT_FOUND` when the account has none yet. It does not
  invent a default row.
- `PUT` upserts it (`200`) from
  `{ "displayName": "Ada", "workspaceName": "Ada's studio", "settings": { "theme": "dark" } }`. `displayName` is
  optional and may be null; `workspaceName` is required; `settings` defaults to `{}` and is bounded to 4 KB. Unknown
  fields, including `owner_id`, are rejected with `400 UNEXPECTED_FIELD`.

A workspace is one row per account: `owner_id` is the primary key of `profiles`, so a second account's write cannot land
on the first account's row.

## Projects

`projects` and `project_revisions` are the first slice of Phase 2 application persistence. Each project belongs to the
verified Supabase user, carries one of three kinds (`story`, `product-ad`, `repurpose`), and stores a **versioned**
`document`. Two numbers matter and they are not the same: `schema_version` is the shape of the document, while
`version` is the optimistic concurrency token for the row.

Every accepted write appends an immutable revision in the same transaction: the `projects_record_revision` trigger
copies the new row into `project_revisions`, numbered by `projects.version`. History cannot drift from the row, and a
rejected request cannot append a revision.

| Route | Purpose |
| --- | --- |
| `POST /api/projects` | Create from `{ projectType, title, document }`. Returns `201` with `version: 1`. |
| `GET /api/projects` | The caller's 50 most recently updated projects, without documents. |
| `GET /api/projects/:id` | One owned project, including its document. |
| `PUT /api/projects/:id` | Replace `{ title, document }`, sending the `version` last read. |
| `DELETE /api/projects/:id` | Delete an owned project; its revisions cascade. |

Ownership is enforced explicitly on every query: the server filters on the id verified from the session, never on a
client-supplied owner. Another account's project id reports `404 PROJECT_NOT_FOUND` for read, update, and delete, so it
does not disclose that the project exists, and the row is left untouched. A save that loses the version race returns
`409 PROJECT_VERSION_CONFLICT` and writes nothing. Request bodies are bounded (128 KB, 200-character title,
2000-character summary, 50 scenes, 20 000 characters per scene), and only known fields are accepted at every level.

Row-level security is enabled on both tables. Authenticated users may only `select` their own rows; projects and
revisions are written exclusively by the server with the service role, so document validation and the owner check
cannot be bypassed by calling PostgREST with a browser token.

### Project child tables

The remaining Phase 2 tables follow the same ownership pattern and are created by
`20261124140000_create_project_children.sql`:

| Table | Holds |
| --- | --- |
| `scenes` | The addressable form of each scene (`scene_key`, `position`), linked to a project. |
| `media_metadata` | Uploaded or generated media: kind, private object key, content type, size, status. Ownership lives in `owner_id`, never in the object key. |
| `sources` | Where material came from: kind, title, URL, retrieval time. |
| `claims` | Statements checked against a source, with an `unverified`/`supported`/`contradicted` status. |
| `generation_proposals` | A proposed generation (model, prompt, proposal JSON) and whether it was accepted. |
| `provider_jobs` | Asynchronous provider work such as JSON2Video: provider, status, external id, request/result. |
| `render_snapshots` | Outputs pinned to a project revision that must exist, enforced by a composite foreign key. |

Every table carries `owner_id`, cascades from both `projects` and `auth.users`, has RLS enabled with a
`select ... using (auth.uid() = owner_id)` policy, and grants writes only to `service_role`. One `DO` block creates all
of those policies, so no table can drift from the pattern. Six of them are reachable through owner-scoped routes:

| Route | Purpose |
| --- | --- |
| `GET`/`PUT /api/projects/:id/scenes` | Read or replace the addressable scene list (`key`, `heading`, `body`), ordered by array position. |
| `GET`/`POST /api/projects/:id/sources` | List sources, or add one. |
| `DELETE /api/projects/:id/sources/:sourceId` | Remove one owned source. |
| `GET`/`POST /api/projects/:id/claims` | List claims, or add one, optionally linked to a source of the same project. |
| `PATCH /api/projects/:id/claims/:claimId` | Set `unverified`, `supported`, or `contradicted`. |
| `GET`/`POST /api/projects/:id/proposals` | List generation proposals, or record a frozen proposal. |
| `PATCH /api/projects/:id/proposals/:proposalId` | Accept or reject a proposal. |
| `GET`/`POST /api/projects/:id/jobs` | List provider jobs, or queue one. |
| `PATCH /api/projects/:id/jobs/:jobId` | Move a job's status and record its result. |
| `GET`/`POST /api/projects/:id/renders` | List render snapshots, or create one pinned to an existing revision. |

Every child route first resolves the project with the verified owner id, so another account's project id is
`404 PROJECT_NOT_FOUND` and no child row is read at all. Child writes filter on `owner_id` and `project_id` as well, so
a guessed child id cannot reach a row, and such a write is `404 CHILD_RECORD_NOT_FOUND`. A render for a revision the
project does not have is refused with `409 PROJECT_REVISION_NOT_FOUND`; the composite foreign key enforces the same
rule in the database. Replacing scenes upserts first and prunes afterwards, so a failed save cannot lose the current
list, and a key that already exists keeps its row id and `created_at`.

`media_metadata` still has no HTTP route: media rows are only meaningful once Phase 3 adds private R2 uploads. It uses
the same policies and grants, so it is ready for that work.

`profiles` (`20261124150000_create_profiles.sql`) is the per-user workspace record: `owner_id` is its primary key, so
each account has exactly one, and deleting the account cascades it. It uses the same policy and grant shape.

## Model catalog (verified 2026-11-24)

Direct request identifiers come from `https://ollama.com/api/tags`, which the API documentation names as the source of
truth for `ollama.com/api/chat`.

| Family | Configured identifier | Public catalog |
| --- | --- | --- |
| deepseek-v4.1-flash | `deepseek-v4.1-flash` | listed |
| gemma4 | `gemma4:31b` | listed |
| glm-5.3-flash | `glm-5.3-flash` | listed |
| gpt-oss | `gpt-oss:20b` (also listed: `gpt-oss:120b`) | listed |
| minimax-m3.1-flash | `minimax-m3.1-flash` | listed |
| nemotron-3-nano | — | **not listed** |

`nemotron-3-nano` is disabled. Its library page advertises `nemotron-3-nano:30b-cloud` only through a signed-in local
Ollama server, and the direct-request catalog lists only `nemotron-3-super` and `nemotron-3-ultra`. No substitute is
configured.

## Live verification (Phase 1, 2026-11-24)

These requests were made through the application server before the Phase 2 auth boundary was added. They remain the
record of provider/model availability; latency and output counts vary between runs.

| Family | Request ID | Returned model | Result | Latency | Prompt tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- |
| Gemma 4 31B | `gemma4:31b` | `gemma4:31b` | success | 777 ms | 22 | 13 |
| DeepSeek V4.1 Flash | `deepseek-v4.1-flash` | `deepseek-v4.1-flash` | success | 948 ms | 13 | 14 |
| GLM 5.3 Flash | `glm-5.3-flash` | `glm-5.3-flash` | success | 920 ms | 21 | 29 |
| GPT-OSS 20B | `gpt-oss:20b` | `gpt-oss:20b` | success | 643 ms | 76 | 29 |
| MiniMax M3.1 Flash | `minimax-m3.1-flash` | `minimax-m3.1-flash` | success | 871 ms | 211 | 14 |
| Nemotron 3 Nano | — | — | unavailable | — | — | — |

- GLM 5.3 Flash initially returned an empty final message because its thinking trace consumed the output bound. The
  server sends `think: false`, and the retest succeeded.
- **Nemotron 3 Nano is unavailable for direct requests.** It is absent from `/api/tags`, so the server returns
  `MODEL_UNAVAILABLE` without contacting Ollama.

Phase 2’s authenticated path was verified with a local fake Supabase (real HTTP auth + PostgREST calls) because no
user session token was available in this environment. On 2026-11-24 the configured `story-frame` project’s obsolete
`public` schema was exported and replaced with these five migrations (see
[Applying the migrations](#applying-the-migrations)). The hosted catalog now matches this code: 11 tables, RLS and a
select-own policy on each, the revision trigger, no `auth.users` trigger, and `/api/ai/status` reporting
`ledger.ready: true`. Live routes were then exercised with two disposable users (37/37 checks,
including two-user isolation), and `smoke:live` exited 0 with 5/5 model families and an identical
stored replay. The test users and rows were deleted; the project is empty again.

`npm run verify:sql` applies all five migrations to a real PostgreSQL engine (PGlite, PostgreSQL compiled to
WebAssembly) with Supabase-like `anon`, `authenticated`, and `service_role` roles plus an `auth.uid()` stub, then
asserts what the server relies on: the revision trigger, owner-only reads on every table, refused browser writes, the
conditional version update, constraint and foreign-key rejections, and the cascades from both `projects` and
`auth.users`. It runs offline, in memory, and exits non-zero on the first broken expectation. This validates the SQL
logic and the policies themselves, but not the live project’s role configuration.

## Tests

All automated provider tests use a local mock and are labelled `MOCKED`. Supabase is replaced by a local fake Auth and
PostgREST service, so tests exercise the real HTTP client code without external calls.

Coverage includes:

- Missing, invalid, and **expired** sessions (rejected before any provider call or ledger write)
- Missing Supabase auth or ledger configuration (billable calls refused)
- A configured but unreachable ledger or missing `ai_usage` table (refused **before** the provider is called)
- **Two-user isolation**: each account reads only its own ledger rows, and a client-supplied owner id is rejected
- Ledger rows written from actual reported usage, plus error rows for provider failures
- A successful provider call whose ledger completion keeps failing still returns the reply, flagged
  `X-Storyframe-Usage: unrecorded`, after one paid call and with the row left `pending`
- A completion write that fails once is retried, and that key then replays the recorded reply
- A completion that loses to a concurrent abandonment is reported `unrecorded`, keeps the paid reply, and leaves the
  `REQUEST_ABANDONED` row untouched
- Missing, malformed, replayed, reused, and in-progress idempotency keys
- Successful and provider-error replays without a second provider call
- A pending reservation blocks a retry from billing again
- A stale pending reservation is settled as `REQUEST_ABANDONED` with no provider call, and that key replays the outcome
- A stale takeover that loses its race leaves the row pending and reports `IDEMPOTENCY_IN_PROGRESS`
- The abandon threshold never drops below the provider timeout plus three auth timeouts, so a live request is never
  settled, and a pending reservation inside that window is left untouched
- A key scoped to one account: two users may share a key and are each billed once
- A completed reservation with no stored response (503, no provider call)
- The fake PostgREST returns only the selected columns, so a reservation lookup that omits a column it reads fails the
  replay tests instead of passing against a fuller live row
- Project create/read/list/update/delete with owner-only access, revision history, and cascade delete
- Project isolation: another account's id is `404` for read, update, and delete, leaves the row intact, and never
  appears in that account's list
- Optimistic concurrency: a stale `version` returns `409 PROJECT_VERSION_CONFLICT` without writing a revision
- Project payload validation (kind, title, document schema, unknown fields at every level) and a stored document from
  a schema the server cannot read
- The development screen reuses a key while an outcome is unknown and starts a new key after a recorded error
- Profile read/write for the caller, an upsert that never adds a duplicate row, and `404` before a profile exists
- Profile isolation: the second account's read is `404`, and its write creates its own row without touching the first
- Profile payload validation (blank workspace name, oversized display name or settings, client-supplied `owner_id`)
- Child records: scene replacement, in-place key updates, pruning, sources, claims and their status, proposals and
  their acceptance, provider jobs and their results, and a render pinned to a revision that exists
- Child isolation: another account's project is `404` on every child route and writes nothing; a foreign source, claim,
  or proposal id is `404`; child rows cascade when their project is deleted
- Child payload validation (duplicate scene key, unknown or client-supplied fields, non-http URL, unknown enum value,
  render revision below 1)
- Missing key, unknown/disabled model, oversized prompt/body, provider auth failure, rate limiting, timeout,
  malformed/empty responses, success extraction, secret leakage, and duplicate submission
- UI reply rendering, error display, and duplicate-submission suppression
- Supabase Auth UI: initial session restore, email/password sign-in, local sign-out, sign-in errors, and
  expired/unreadable sessions. The refresh itself belongs to the Supabase client, and the session tests assert that the
  app does not start a second one.

### Repeatable live smoke check

```bash
SMOKE_SUPABASE_ACCESS_TOKEN=<valid session token> npm run smoke:live
```

This check is **opt-in** and makes **five real requests** (one per enabled family), which count against your Ollama
usage and write five ledger rows. It requires `OLLAMA_API_KEY` plus Supabase configuration in the environment or
`storyframe/.env`, and a valid session token. It starts an isolated API server on an ephemeral loopback port, runs the
five families sequentially, then reads `/api/ai/usage` to confirm the ledger is working. It then repeats one successful
request with its original `Idempotency-Key`: the replay must return the same stored values and leave the ledger row
count unchanged, which proves no second provider call was billed. Because `response_body` is JSONB, the comparison
ignores object key order. It exits non-zero on failure, performs no retries, and never prints the provider key or
session token. Nemotron is checked only for its disabled status and is
never called.

### Provider-free live route checks

```bash
npm run verify:live-routes
```

This check is **provider-free**: it never calls Ollama and spends no billable tokens. It requires `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_PUBLISHABLE_KEY` (or the legacy `SUPABASE_ANON_KEY`) in the environment
or `storyframe/.env`. It creates two disposable auth users, starts an isolated API server on an ephemeral loopback
port, and checks the hosted schema through the real routes: profile isolation, project IDOR refusals, optimistic
conflict, every child table, cross-owner source rejection, render revisions, ledger completion ownership, and usage
isolation. It seeds its own rows, then deletes both users and verifies their ledger, profile, and project rows are
gone. It exits non-zero on failure and never prints access tokens or keys. It does not require or use
`OLLAMA_API_KEY`, and must not be pointed at a project whose data it should not create temporary users in.

## Security limitations

- Email/password sign-in only; there is no sign-up, password-reset, MFA, OAuth, or account-management UI. The
  Supabase client persists session tokens in browser `localStorage`; production needs an explicit session-storage and
  CSP review. Sign-out is local to this browser and does not revoke the account's other sessions.
- The migrations and RLS policies are applied to the configured Supabase project. The hosted catalog was checked (11
  tables, RLS, policies, grants, revision trigger), live profile/project/child routes and two-user isolation passed
  39/39 checks on the hardening commit, and the disposable users were deleted afterwards. Rerun these checks with
  `npm run verify:live-routes`. `smoke:live` exposed a live-only missing-column
  bug; after the fix a clean five-call run exited 0 with 5/5 families and an identical stored replay.
- Pending reservations are recovered only lazily, when a retry with the same key arrives after `AI_ABANDON_AFTER_MS`.
  There is no background sweeper, so a key nobody retries stays `pending`, and the original attempt's outcome is never
  learned: the row becomes a terminal `error` with `REQUEST_ABANDONED`, no token counts, and zero latency. Recovery
  never calls the provider, so it cannot bill twice, but it cannot tell you whether the original attempt was charged.
- A reply whose completion could not be recorded after the retry is delivered but not persisted: the ledger holds no
  usage row for it, and retrying that key later can only end as `REQUEST_ABANDONED`, because the reply exists nowhere
  the server can read.
- The threshold is a guard, not a lock: if a process were frozen for longer than it, that process's late completion can
  no longer overwrite the settled row (it stays `REQUEST_ABANDONED`), although the live caller still receives its real
  response.
- Rate limiting is in-memory and per-process; it is scoped to the verified account but is not a durable quota shared
  across processes or instances.
- The Vite proxy and loopback API are a development arrangement; production needs a deployed API, managed secrets,
  durable quotas, and a real auth flow.
- Projects have a server API but no workspace UI yet, and only document schema v1 exists. There is no conflict merging:
  a stale save is refused and the caller must reload.
- The migrations are verified against a real PostgreSQL engine by `npm run verify:sql`, by the test fakes, and by
  live routes against the configured project. The project is empty again after test cleanup.
- A workspace is one profile per user, with no shared or multi-user workspace, which matches the isolation
  requirement. There is no workspace UI yet; the profile is reachable only through the API.
- Child routes record what the server is told; they do not call a provider. Nothing yet writes a provider job or a
  render automatically, and `media_metadata` has no route until Phase 3 adds private media uploads.
