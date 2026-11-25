-- Phase 9: spending guard for JSON2Video renders.
--
-- Renders are billed in credits at one credit per output second; the provider
-- publishes no credits-to-dollars rate, so no USD column exists here. The row
-- is written before the paid submission and settled afterwards. A definitive
-- rejection settles zero; an ambiguous failure keeps its estimate counted.
--
-- The ledger belongs to the account. Deleting a project clears project_id but
-- keeps the rows, so a replacement project cannot reset the rolling window.

create table if not exists public.video_usage (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  render_id uuid references public.render_snapshots (id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed')),
  credits_estimate numeric(12, 3) not null check (credits_estimate >= 0),
  -- What the window counts right now. The reservation seeds it with the
  -- estimate; settling narrows it to the provider's consumed credits or the
  -- measured output duration.
  credits_counted numeric(12, 3) not null default 0 check (credits_counted >= 0),
  duration_seconds numeric(12, 3)
    check (duration_seconds is null or duration_seconds >= 0),
  rate_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists video_usage_owner_created_idx
  on public.video_usage (owner_id, created_at desc);

-- One reservation per render, so a retried submit cannot double-charge the
-- account's window. Rows created before a render exists are unconstrained.
create unique index if not exists video_usage_render_key
  on public.video_usage (render_id)
  where render_id is not null;

alter table public.video_usage enable row level security;

drop policy if exists video_usage_select_own on public.video_usage;
create policy video_usage_select_own on public.video_usage
  for select to authenticated using (auth.uid() = owner_id);

revoke all on public.video_usage from anon, authenticated;
grant select on public.video_usage to authenticated;
grant select, insert, update, delete on public.video_usage to service_role;

-- Check and insert in one transaction under a per-owner advisory lock, exactly
-- like the Deepgram guard: two server processes cannot both read the same total
-- before either writes.
create or replace function public.reserve_video_usage(
  p_owner_id uuid,
  p_project_id uuid,
  p_render_id uuid,
  p_credits_estimate numeric,
  p_rate_version text,
  p_credit_limit numeric,
  p_window_seconds integer
) returns table (
  usage_id uuid,
  allowed boolean,
  credits_used numeric,
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
  if p_credits_estimate < 0 then
    raise exception 'video credit estimate must be non-negative' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));

  select coalesce(sum(credits_counted), 0), min(created_at)
    into v_used, v_oldest
    from public.video_usage
   where owner_id = p_owner_id
     and created_at >= now() - make_interval(secs => greatest(0, p_window_seconds));

  if p_credit_limit > 0 and v_used + p_credits_estimate > p_credit_limit then
    return query select null::uuid, false, v_used, v_oldest;
    return;
  end if;

  insert into public.video_usage
    (owner_id, project_id, render_id, status, credits_estimate, credits_counted, rate_version)
  values
    (p_owner_id, p_project_id, p_render_id, 'pending', p_credits_estimate,
     p_credits_estimate, p_rate_version)
  returning id into v_id;

  return query
    select v_id, true, v_used + p_credits_estimate, coalesce(v_oldest, now());
end;
$$;

revoke all on function public.reserve_video_usage(
  uuid, uuid, uuid, numeric, text, numeric, integer
) from public, anon, authenticated;
grant execute on function public.reserve_video_usage(
  uuid, uuid, uuid, numeric, text, numeric, integer
) to service_role;
