-- Separates "nothing has been submitted yet" from "a transaction is in flight".
--
-- `observations_tx_hash_presence` requires tx_status 'pending' to have a null tx_hash, but the monitor records
-- the transaction hash the moment `writeContract` returns and before it waits for a receipt. That ordering is
-- deliberate and must not change: if the function is killed mid-wait, the hash is the only way to find out what
-- happened onchain, so it has to be durable before the wait rather than after it. With only 'pending' available
-- that write violated the constraint, which would have left every settled observation with no recorded hash.
--
-- 'submitted' is that in-flight state: hash known, receipt not yet observed. Keeping it distinct from 'pending'
-- also makes the two recovery actions different - a 'pending' row needs the transaction sending, a 'submitted'
-- row needs its receipt looking up - instead of collapsing them into one ambiguous status.

alter table public.observations
  drop constraint if exists observations_tx_status_check;

alter table public.observations
  add constraint observations_tx_status_check
  check (tx_status in ('pending', 'submitted', 'confirmed', 'failed', 'indexed', 'not_required', 'unmonitorable'));

alter table public.observations
  drop constraint if exists observations_tx_hash_presence;

alter table public.observations
  add constraint observations_tx_hash_presence
  check (
    (tx_status in ('pending', 'not_required', 'unmonitorable') and tx_hash is null)
    or (tx_status in ('submitted', 'confirmed', 'indexed') and tx_hash is not null)
    or tx_status = 'failed'
  );

comment on column public.observations.tx_status is
  'Chain submission lifecycle. pending: evidence stored, nothing broadcast. submitted: transaction broadcast, '
  'receipt not yet seen. confirmed: receipt succeeded. failed: receipt reverted or the submission errored. '
  'indexed: the chain indexer attached the hash from an onchain log because the monitor did not record it. '
  'not_required: healthy steady-state probe deliberately kept offchain to avoid unnecessary gas. unmonitorable: '
  'the endpoint was refused by target policy (SSRF/validation), so the row is evidence of a refusal and is '
  'never treated as an outage or submitted onchain.';

-- The read model must not claim an observation reached the chain when the transaction reverted. 'failed' is the
-- only status allowed to carry a chain_error, and the two must agree: a confirmed row with an error recorded
-- against it would be self-contradicting evidence.
alter table public.observations
  drop constraint if exists observations_confirmed_has_no_error;

alter table public.observations
  add constraint observations_confirmed_has_no_error
  check (tx_status not in ('submitted', 'confirmed', 'indexed') or chain_error is null);
