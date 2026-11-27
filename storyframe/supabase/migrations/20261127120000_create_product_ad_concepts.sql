-- Phase 11: grounded ad concepts.
--
-- One row is one generated set of exactly three concepts for one product and
-- one campaign. The product and campaign facts are copied into `snapshot` when
-- the set is generated, so a later catalog edit cannot silently rewrite an
-- approved ad. `concepts` holds the three validated concepts; selecting one
-- freezes `manifest`, built from the snapshot rather than the live rows.
--
-- Rows are owner-scoped and written only by the service role. The browser may
-- select its own rows but cannot bypass the server's validation.

create table if not exists public.product_ad_concepts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  status text not null default 'proposed' check (status in ('proposed', 'selected')),
  -- Frozen product and campaign facts, captured before the provider call.
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text not null check (char_length(snapshot_hash) = 64),
  model_id text not null check (char_length(model_id) between 1 and 64),
  repair_attempted boolean not null default false,
  summary text not null default '' check (char_length(summary) <= 2000),
  notes jsonb not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array'),
  -- Exactly three validated concepts. Deep validation happens in the server;
  -- this check only rejects a shape no generated set can have.
  concepts jsonb not null check (
    jsonb_typeof(concepts) = 'array' and jsonb_array_length(concepts) = 3
  ),
  selected_index integer check (selected_index between 0 and 2),
  manifest jsonb check (manifest is null or jsonb_typeof(manifest) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A selected set names its concept; a proposed set names none.
  check ((status = 'selected') = (selected_index is not null)),
  check ((status = 'selected') = (manifest is not null))
);

create index if not exists product_ad_concepts_owner_updated_idx
  on public.product_ad_concepts (owner_id, updated_at desc);
create index if not exists product_ad_concepts_product_idx
  on public.product_ad_concepts (product_id, created_at desc);
create index if not exists product_ad_concepts_campaign_idx
  on public.product_ad_concepts (campaign_id, created_at desc);

alter table public.product_ad_concepts enable row level security;

drop policy if exists product_ad_concepts_select_own on public.product_ad_concepts;
create policy product_ad_concepts_select_own on public.product_ad_concepts
  for select to authenticated using (auth.uid() = owner_id);

revoke all on public.product_ad_concepts from anon, authenticated;
grant select on public.product_ad_concepts to authenticated;
grant select, insert, update, delete on public.product_ad_concepts to service_role;
