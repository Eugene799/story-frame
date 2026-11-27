-- Phase 11: product catalog and campaign records.
--
-- A product keeps the facts a paid ad may use: the original name and variant,
-- brand settings, approved claims with their evidence notes, and the wording
-- that must never appear. A campaign keeps the offer being advertised. Both are
-- owner-scoped rows written only by the service role; the browser can select
-- its own rows but cannot bypass server validation.
--
-- Media ids point at ready rows in media_metadata. They are recorded here so a
-- product's real asset and logo can be reused without regenerating packaging.

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  variant text not null default '' check (char_length(variant) <= 200),
  -- Brand voice, colours, and similar text settings; bounded by the server.
  brand_settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(brand_settings) = 'object'),
  -- [{ id, text, evidence }] only; a claim without evidence is still kept but
  -- is never treated as approved by the planning step.
  approved_claims jsonb not null default '[]'::jsonb
    check (jsonb_typeof(approved_claims) = 'array'),
  prohibited_wording text[] not null default '{}',
  asset_media_ids uuid[] not null default '{}',
  logo_media_id uuid references public.media_metadata (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists products_owner_updated_idx
  on public.products (owner_id, updated_at desc);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  audience text not null check (char_length(audience) between 1 and 500),
  offer text not null check (char_length(offer) between 1 and 1000),
  price numeric(12, 2) not null check (price >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  promotion_start timestamptz,
  promotion_end timestamptz,
  timezone text not null check (char_length(timezone) between 1 and 64),
  cta text not null check (char_length(cta) between 1 and 200),
  destination text not null check (char_length(destination) between 1 and 2048),
  duration_seconds integer not null check (duration_seconds between 5 and 600),
  aspect_ratio text not null check (aspect_ratio in ('16:9', '9:16', '1:1', '4:5')),
  disclaimer text not null default '' check (char_length(disclaimer) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    promotion_start is null or promotion_end is null or promotion_end > promotion_start
  )
);

create index if not exists campaigns_owner_updated_idx
  on public.campaigns (owner_id, updated_at desc);
create index if not exists campaigns_product_idx
  on public.campaigns (product_id, created_at desc);

alter table public.products enable row level security;
alter table public.campaigns enable row level security;

drop policy if exists products_select_own on public.products;
create policy products_select_own on public.products
  for select to authenticated using (auth.uid() = owner_id);

drop policy if exists campaigns_select_own on public.campaigns;
create policy campaigns_select_own on public.campaigns
  for select to authenticated using (auth.uid() = owner_id);

revoke all on public.products from anon, authenticated;
revoke all on public.campaigns from anon, authenticated;
grant select on public.products to authenticated;
grant select on public.campaigns to authenticated;
grant select, insert, update, delete on public.products to service_role;
grant select, insert, update, delete on public.campaigns to service_role;
