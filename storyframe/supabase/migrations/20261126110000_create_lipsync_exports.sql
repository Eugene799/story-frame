-- Lip sync through Everypixel Labs.
--
-- One row per request, priced and guarded in seconds: the provider bills per
-- output second and accepts at most 20 seconds of source media, so the ledger
-- reserves the ceiling a request can cost rather than a client-declared length.
-- The output is copied into private storage; only our media id is recorded as
-- the deliverable, never the provider's URL.
--
-- The ledger belongs to the account. Deleting a project clears project_id but
-- keeps the rows, exactly like the video credit window.

create table if not exists public.lipsync_exports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'failed')),
  provider_status text
    check (provider_status is null or char_length(provider_status) between 1 and 32),
  provider_task_id text
    check (provider_task_id is null or char_length(provider_task_id) between 1 and 200),
  source_media_id uuid references public.media_metadata (id) on delete set null,
  audio_media_id uuid references public.media_metadata (id) on delete set null,
  output_media_id uuid references public.media_metadata (id) on delete set null,
  resolution text not null default '720p'
    check (resolution in ('360p', '480p', '720p')),
  seconds_estimate numeric(12, 3) not null check (seconds_estimate >= 0),
  seconds_counted numeric(12, 3)
    check (seconds_counted is null or seconds_counted >= 0),
  usd_estimate numeric(12, 4) not null default 0 check (usd_estimate >= 0),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  failure_code text check (failure_code is null or char_length(failure_code) between 1 and 64),
  failure_message text check (failure_message is null or char_length(failure_message) <= 500),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 1 and 200),
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One lip sync in flight per project, so two tabs cannot both submit.
create unique index if not exists lipsync_exports_live_key
  on public.lipsync_exports (project_id)
  where status = 'pending';

-- A replayed Idempotency-Key resolves to the first export instead of submitting twice.
create unique index if not exists lipsync_exports_idempotency_key
  on public.lipsync_exports (owner_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists lipsync_exports_project_created_idx
  on public.lipsync_exports (project_id, created_at desc);

create index if not exists lipsync_exports_owner_created_idx
  on public.lipsync_exports (owner_id, created_at desc);

alter table public.lipsync_exports enable row level security;

drop policy if exists lipsync_exports_select_own on public.lipsync_exports;
create policy lipsync_exports_select_own on public.lipsync_exports
  for select to authenticated using (auth.uid() = owner_id);

revoke all on public.lipsync_exports from anon, authenticated;
grant select on public.lipsync_exports to authenticated;
grant select, insert, update, delete on public.lipsync_exports to service_role;

create table if not exists public.lipsync_usage (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  export_id uuid references public.lipsync_exports (id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed')),
  seconds_estimate numeric(12, 3) not null check (seconds_estimate >= 0),
  seconds_counted numeric(12, 3) not null default 0 check (seconds_counted >= 0),
  usd_estimate numeric(12, 4) not null default 0 check (usd_estimate >= 0),
  rate_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lipsync_usage_owner_created_idx
  on public.lipsync_usage (owner_id, created_at desc);

-- One reservation per export, so a retried submit cannot charge the window twice.
create unique index if not exists lipsync_usage_export_key
  on public.lipsync_usage (export_id)
  where export_id is not null;

alter table public.lipsync_usage enable row level security;

drop policy if exists lipsync_usage_select_own on public.lipsync_usage;
create policy lipsync_usage_select_own on public.lipsync_usage
  for select to authenticated using (auth.uid() = owner_id);

revoke all on public.lipsync_usage from anon, authenticated;
grant select on public.lipsync_usage to authenticated;
grant select, insert, update, delete on public.lipsync_usage to service_role;

-- Check and insert in one transaction under a per-owner advisory lock, exactly
-- like the video credit and Deepgram guards.
create or replace function public.reserve_lipsync_usage(
  p_owner_id uuid,
  p_project_id uuid,
  p_export_id uuid,
  p_seconds_estimate numeric,
  p_usd_estimate numeric,
  p_rate_version text,
  p_second_limit numeric,
  p_window_seconds integer
) returns table (
  usage_id uuid,
  allowed boolean,
  seconds_used numeric,
  oldest_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used numeric;
  v_oldest timestamptz;
  v_id uuid;
begin
  if p_seconds_estimate < 0 then
    raise exception 'lipsync seconds estimate must be non-negative' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));

  select coalesce(sum(seconds_counted), 0), min(created_at)
    into v_used, v_oldest
    from public.lipsync_usage
   where owner_id = p_owner_id
     and created_at >= now() - make_interval(secs => greatest(0, p_window_seconds));

  if p_second_limit > 0 and v_used + p_seconds_estimate > p_second_limit then
    return query select null::uuid, false, v_used, v_oldest;
    return;
  end if;

  insert into public.lipsync_usage
    (owner_id, project_id, export_id, status, seconds_estimate, seconds_counted, usd_estimate, rate_version)
  values
    (p_owner_id, p_project_id, p_export_id, 'pending', p_seconds_estimate, p_seconds_estimate,
     p_usd_estimate, p_rate_version)
  returning id into v_id;

  return query
    select v_id, true, v_used + p_seconds_estimate, coalesce(v_oldest, now());
end;
$$;

revoke all on function public.reserve_lipsync_usage(
  uuid, uuid, uuid, numeric, numeric, text, numeric, integer
) from public, anon, authenticated;
grant execute on function public.reserve_lipsync_usage(
  uuid, uuid, uuid, numeric, numeric, text, numeric, integer
) to service_role;
