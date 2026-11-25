-- Phase 9: video export rows on the existing render and job tables.
--
-- The generic /renders and /jobs routes keep writing plain rows. Those rows are
-- marked 'snapshot' / 'generic' by the defaults below, so the export path's
-- one-live-per-project indexes can never constrain them: every unique index
-- here carries `kind = 'video-export'` in its predicate.

alter table public.render_snapshots
  add column if not exists kind text not null default 'snapshot'
    check (kind in ('snapshot', 'video-export')),
  add column if not exists media_id uuid references public.media_metadata (id) on delete set null,
  add column if not exists job_id uuid references public.provider_jobs (id) on delete set null,
  add column if not exists failure_code text
    check (failure_code is null or char_length(failure_code) between 1 and 64),
  add column if not exists failure_message text
    check (failure_message is null or char_length(failure_message) <= 500),
  add column if not exists provider_status text
    check (provider_status is null or provider_status in ('pending', 'running', 'done', 'error', 'timeout')),
  add column if not exists duration_seconds numeric(12, 3)
    check (duration_seconds is null or duration_seconds >= 0),
  add column if not exists byte_size bigint
    check (byte_size is null or byte_size >= 0),
  add column if not exists width integer
    check (width is null or width > 0),
  add column if not exists height integer
    check (height is null or height > 0),
  -- JSON2Video bills one credit per output second and publishes no USD rate,
  -- so the row records credits only.
  add column if not exists credits_estimate integer not null default 0
    check (credits_estimate >= 0),
  add column if not exists credits_consumed numeric(12, 3)
    check (credits_consumed is null or credits_consumed >= 0),
  add column if not exists idempotency_key text
    check (idempotency_key is null or char_length(idempotency_key) between 1 and 200),
  add column if not exists provider_url_expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.provider_jobs
  add column if not exists kind text not null default 'generic'
    check (kind in ('generic', 'video-export'));

-- One live export per project. Generic snapshots/jobs are outside the predicate.
create unique index if not exists render_snapshots_export_pending_key
  on public.render_snapshots (project_id)
  where kind = 'video-export' and status = 'pending';

create unique index if not exists provider_jobs_export_live_key
  on public.provider_jobs (project_id)
  where kind = 'video-export' and status in ('queued', 'running');

-- A replayed Idempotency-Key resolves to the first export instead of submitting
-- a second paid render. Rows without a key (every generic snapshot) are free.
create unique index if not exists render_snapshots_export_idempotency_key
  on public.render_snapshots (owner_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists render_snapshots_project_created_idx
  on public.render_snapshots (project_id, created_at desc);

create index if not exists provider_jobs_project_kind_idx
  on public.provider_jobs (project_id, kind, status);

-- RLS and grants are unchanged: both tables already select-own and write only
-- through service_role. The new columns inherit that.
