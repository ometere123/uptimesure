-- Canonical log identity is separate from monitor evidence. Reorg cleanup may invalidate this projection, but it
-- must never delete or rewrite the HTTP measurement that was used to derive a settlement.
alter table public.guarantees add column if not exists exhausted boolean not null default false;

alter table public.observations
  add column if not exists chain_block_number bigint,
  add column if not exists chain_block_hash text,
  add column if not exists chain_log_index bigint,
  add column if not exists chain_event_present boolean not null default false;

alter table public.guarantees
  add column if not exists chain_block_number bigint,
  add column if not exists chain_block_hash text,
  add column if not exists chain_log_index bigint,
  add column if not exists chain_event_present boolean not null default false;

alter table public.incidents
  add column if not exists chain_block_number bigint,
  add column if not exists chain_block_hash text,
  add column if not exists chain_log_index bigint,
  add column if not exists chain_event_present boolean not null default false;

create unique index if not exists observations_chain_log_identity_idx
  on public.observations (chain_block_hash, chain_log_index) where chain_event_present;
create unique index if not exists guarantees_chain_log_identity_idx
  on public.guarantees (chain_block_hash, chain_log_index) where chain_event_present;
create unique index if not exists incidents_chain_log_identity_idx
  on public.incidents (chain_block_hash, chain_log_index) where chain_event_present;
