create table if not exists public.pinterest_connections (
  id text primary key,
  enabled boolean not null default false,
  account_id text,
  username text,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scopes text,
  default_board_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pinterest_oauth_states (
  state_hash text primary key,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.pinterest_connections enable row level security;
alter table public.pinterest_oauth_states enable row level security;

revoke all on table public.pinterest_connections from anon, authenticated;
revoke all on table public.pinterest_oauth_states from anon, authenticated;

grant all on table public.pinterest_connections to service_role;
grant all on table public.pinterest_oauth_states to service_role;

create index if not exists pinterest_oauth_states_expires_at_idx
  on public.pinterest_oauth_states (expires_at);

comment on table public.pinterest_connections is
  'Pinterest OAuth connection metadata. Tokens are encrypted application-side before persistence.';
comment on table public.pinterest_oauth_states is
  'Short-lived hashed OAuth state values used to prevent CSRF during Pinterest authorization.';
