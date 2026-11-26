-- Durable advancement leases.
--
-- Video exports, lip syncs, image pending rows, and media retention advance on
-- a timer inside the server. The rows themselves already live in Postgres, so a
-- restart finds the work again; what a timer cannot guarantee is that only one
-- process advances it. A stored lease per sweep names the one live holder:
-- a second instance is refused while the lease is live, and a restarted
-- instance takes over as soon as the dead holder's lease expires. A running
-- pass renews its lease, so the TTL bounds crash recovery, not pass duration.
--
-- This table is server-only: it has no browser policy and no browser grant.

create table if not exists public.job_leases (
  name text primary key check (char_length(name) between 1 and 64),
  holder uuid not null,
  expires_at timestamptz not null
);

alter table public.job_leases enable row level security;

-- Claim and renew run as the function owner, so the server needs no write
-- grants: only the select it can still make and the delete that releases a lease.
revoke all on public.job_leases from anon, authenticated;
grant select, delete on public.job_leases to service_role;

-- Claims a free name, or takes over one whose lease has expired. The expired
-- row is replaced in place, so a name always has at most one holder and two
-- instances racing for the same expired lease cannot both win.
create or replace function public.claim_job_lease(
  p_name text,
  p_holder uuid,
  p_ttl_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  insert into public.job_leases (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => greatest(1, p_ttl_seconds)))
  on conflict (name) do update
     set holder = excluded.holder,
         expires_at = excluded.expires_at
   where public.job_leases.expires_at <= now()
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

-- Extends only the caller's own live row. A holder whose lease already expired
-- gets false instead of reviving a row another instance now owns.
create or replace function public.renew_job_lease(
  p_name text,
  p_holder uuid,
  p_ttl_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_renewed boolean;
begin
  update public.job_leases
     set expires_at = now() + make_interval(secs => greatest(1, p_ttl_seconds))
   where name = p_name
     and holder = p_holder
  returning true into v_renewed;

  return coalesce(v_renewed, false);
end;
$$;

revoke all on function public.claim_job_lease(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_job_lease(text, uuid, integer) to service_role;

revoke all on function public.renew_job_lease(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_job_lease(text, uuid, integer) to service_role;
