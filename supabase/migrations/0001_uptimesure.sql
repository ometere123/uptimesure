create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

create table if not exists public.guarantees (
  id bigint primary key,
  chain_id integer not null default 84532,
  contract_address text not null,
  provider text not null,
  beneficiary text not null,
  endpoint_url text not null,
  criteria_hash text not null,
  expected_status integer not null,
  expected_fragment text not null default '',
  max_latency_ms integer not null,
  check_interval_seconds integer not null,
  failure_threshold integer not null,
  min_outage_seconds integer not null,
  payout_per_incident numeric(78,0) not null,
  max_payouts integer not null,
  paid_payouts integer not null default 0,
  remaining_coverage numeric(78,0) not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  first_failure_at timestamptz,
  last_observed_at timestamptz,
  consecutive_failures integer not null default 0,
  active boolean not null default true,
  withdrawn boolean not null default false,
  next_check_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.observations (
  observation_id text primary key,
  guarantee_id bigint not null references public.guarantees(id) on delete cascade,
  observed_at timestamptz not null,
  healthy boolean not null,
  http_status integer,
  latency_ms integer,
  body_sha256 text,
  evidence_hash text not null,
  error_code text,
  tx_hash text,
  tx_status text not null default 'pending' check (tx_status in ('pending','confirmed','failed','indexed')),
  created_at timestamptz not null default now()
);

create table if not exists public.incidents (
  id bigint primary key,
  guarantee_id bigint not null references public.guarantees(id) on delete cascade,
  started_at timestamptz not null,
  confirmed_at timestamptz not null,
  recovered_at timestamptz,
  payout_amount numeric(78,0) not null default 0,
  confirm_evidence_hash text not null,
  recovery_evidence_hash text,
  updated_at timestamptz not null default now()
);

create table if not exists public.chain_sync_state (
  id smallint primary key default 1 check (id = 1),
  last_synced_block bigint,
  updated_at timestamptz not null default now()
);

insert into public.chain_sync_state (id) values (1) on conflict (id) do nothing;

create index if not exists guarantees_due_idx on public.guarantees (active, next_check_at) where withdrawn = false;
create index if not exists guarantees_provider_idx on public.guarantees (lower(provider));
create index if not exists guarantees_beneficiary_idx on public.guarantees (lower(beneficiary));
create index if not exists observations_guarantee_time_idx on public.observations (guarantee_id, observed_at desc);
create index if not exists incidents_guarantee_time_idx on public.incidents (guarantee_id, confirmed_at desc);

alter table public.guarantees enable row level security;
alter table public.observations enable row level security;
alter table public.incidents enable row level security;
alter table public.chain_sync_state enable row level security;

-- Public read, service-role-only write. The onchain contract is the financial source of truth; these tables are
-- a read model, so anyone may read them and nobody holding a browser key may write them.
-- Dropped first because `create policy` has no `if not exists` in Postgres 15.
drop policy if exists "public read guarantees" on public.guarantees;
create policy "public read guarantees" on public.guarantees for select using (true);

drop policy if exists "public read observations" on public.observations;
create policy "public read observations" on public.observations for select using (true);

drop policy if exists "public read incidents" on public.incidents;
create policy "public read incidents" on public.incidents for select using (true);

revoke all on public.chain_sync_state from anon, authenticated;
revoke insert, update, delete on public.guarantees from anon, authenticated;
revoke insert, update, delete on public.observations from anon, authenticated;
revoke insert, update, delete on public.incidents from anon, authenticated;

grant select on public.guarantees, public.observations, public.incidents to anon, authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Triggers are dropped first so the whole migration is idempotent: `create trigger` has no `if not exists`,
-- and CI applies every migration twice to prove re-application is safe.
drop trigger if exists guarantees_touch_updated_at on public.guarantees;
create trigger guarantees_touch_updated_at
before update on public.guarantees
for each row execute function public.touch_updated_at();

drop trigger if exists incidents_touch_updated_at on public.incidents;
create trigger incidents_touch_updated_at
before update on public.incidents
for each row execute function public.touch_updated_at();
