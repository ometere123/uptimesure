-- Chain indexer state: bounded, resumable, reorg-tolerant.
--
-- The indexer previously read `last_synced_block` from a single row created by an unconditional insert, scanned
-- to `latest - 2`, and had nowhere to record why a run failed. Three problems followed: two confirmations is
-- not enough to survive a Base Sepolia reorg; a missing state row made `.single()` throw and the indexer never
-- started; and an operator had no way to see that indexing had silently stalled.
--
-- The read model is never treated as authoritative over the contract. The indexer resolves current guarantee
-- and incident state by reading the contract, not by accumulating event deltas, so re-processing the same block
-- range converges on the same rows instead of double-counting a top-up or a payout.

alter table public.chain_sync_state
  add column if not exists chain_id integer not null default 84532,
  -- The block the contract was deployed in. Scanning starts here, never from genesis.
  add column if not exists deploy_block bigint,
  add column if not exists contract_address text,
  -- Highest block considered final by this indexer: last_synced_block never exceeds it.
  add column if not exists safe_block bigint,
  add column if not exists last_run_at timestamptz,
  add column if not exists last_error text,
  add column if not exists events_indexed bigint not null default 0;

alter table public.chain_sync_state
  drop constraint if exists chain_sync_contract_shape;
alter table public.chain_sync_state
  add constraint chain_sync_contract_shape
  check (contract_address is null or contract_address ~ '^0x[0-9a-f]{40}$');

alter table public.chain_sync_state
  drop constraint if exists chain_sync_blocks_sane;
alter table public.chain_sync_state
  add constraint chain_sync_blocks_sane check (
    (deploy_block is null or deploy_block >= 0)
    and (last_synced_block is null or last_synced_block >= 0)
    and (last_synced_block is null or deploy_block is null or last_synced_block >= deploy_block - 1)
  );

comment on column public.chain_sync_state.deploy_block is
  'Block containing the UptimeSureCore deployment transaction. The indexer never scans below this.';
comment on column public.chain_sync_state.safe_block is
  'Highest block treated as final (head minus the confirmation depth) on the last run.';
comment on column public.chain_sync_state.last_error is
  'Why the most recent indexer run stopped early, or null. Surfaced on the system status page.';

insert into public.chain_sync_state (id) values (1) on conflict (id) do nothing;

/**
 * Advances the sync cursor, refusing to move it backwards.
 *
 * Rewinding is the indexer's own decision (it re-scans an overlap window each run to absorb shallow reorgs) and
 * happens in the range it queries, not in the stored cursor. A cursor that could move backwards would let a
 * failed or out-of-order run replay work indefinitely.
 */
create or replace function public.advance_chain_cursor(
  p_last_synced_block bigint,
  p_safe_block bigint default null,
  p_events integer default 0,
  p_error text default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cursor bigint;
begin
  update public.chain_sync_state
     set last_synced_block = greatest(coalesce(last_synced_block, -1), p_last_synced_block),
         safe_block = coalesce(p_safe_block, safe_block),
         events_indexed = events_indexed + greatest(coalesce(p_events, 0), 0),
         last_run_at = now(),
         last_error = left(p_error, 500),
         updated_at = now()
   where id = 1
  returning last_synced_block into v_cursor;

  return v_cursor;
end;
$$;

comment on function public.advance_chain_cursor(bigint, bigint, integer, text) is
  'Monotonically advances the chain sync cursor and records run telemetry.';

revoke all on function public.advance_chain_cursor(bigint, bigint, integer, text) from public, anon, authenticated;
grant execute on function public.advance_chain_cursor(bigint, bigint, integer, text) to service_role;

-- The status page needs to show indexer health without exposing operational internals or granting write access.
create or replace view public.chain_sync_public as
  select chain_id, deploy_block, contract_address, last_synced_block, safe_block, last_run_at, last_error
  from public.chain_sync_state
  where id = 1;

comment on view public.chain_sync_public is
  'Read-only projection of indexer health for the public status page.';

grant select on public.chain_sync_public to anon, authenticated;
