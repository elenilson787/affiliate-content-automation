create table if not exists public.offer_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  list_type text not null default 'intelligent' check (list_type in ('manual','intelligent','hybrid')),
  preset text not null default 'recommended' check (preset in ('recommended','viral','sales','commission','discount','new')),
  enabled boolean not null default true,
  min_commission numeric(7,3),
  min_discount numeric(7,3),
  min_price numeric(12,2),
  max_price numeric(12,2),
  min_sales integer,
  min_rating numeric(3,2),
  sort text check (sort is null or sort in ('commission','price','sales','discount')),
  target_size integer not null default 30 check (target_size between 1 and 100),
  rules jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.offer_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.offer_lists(id) on delete cascade,
  offer_key text not null,
  network text not null default 'shopee',
  offer_id text not null,
  offer_snapshot jsonb not null,
  source text not null default 'smart' check (source in ('smart','manual')),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (list_id, offer_key)
);

create index if not exists idx_offer_lists_enabled on public.offer_lists(enabled, updated_at desc);
create index if not exists idx_offer_list_items_list on public.offer_list_items(list_id, pinned desc, created_at desc);

alter table public.offer_lists enable row level security;
alter table public.offer_list_items enable row level security;

revoke all on public.offer_lists from anon, authenticated;
revoke all on public.offer_list_items from anon, authenticated;
grant all on public.offer_lists to service_role;
grant all on public.offer_list_items to service_role;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'set_offer_lists_updated_at') then
    create trigger set_offer_lists_updated_at before update on public.offer_lists
    for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'set_offer_list_items_updated_at') then
    create trigger set_offer_list_items_updated_at before update on public.offer_list_items
    for each row execute function public.set_updated_at();
  end if;
end $$;
