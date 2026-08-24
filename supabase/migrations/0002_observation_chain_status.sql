alter table public.observations
  add column if not exists chain_error text;

alter table public.observations
  drop constraint if exists observations_tx_status_check;

alter table public.observations
  add constraint observations_tx_status_check
  check (tx_status in ('pending', 'confirmed', 'failed', 'indexed', 'not_required'));

comment on column public.observations.tx_status is
  'Chain submission lifecycle. not_required means a healthy steady-state probe was intentionally kept offchain to avoid unnecessary gas.';

comment on column public.observations.chain_error is
  'Chain-only error detail. Probe result remains in error_code so network/contract errors never overwrite service evidence.';
