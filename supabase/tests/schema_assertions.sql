-- Schema assertions for the UptimeSure read model.
--
-- Run with `psql -v ON_ERROR_STOP=1` after applying every migration. Each assertion raises an exception on
-- failure, so a non-zero exit means the schema does not match what the application and the contract assume.
--
-- This exists because the read model has two independent writers (the monitor and the chain indexer) and one
-- untrusted reader (the browser, holding a publishable key). A silent schema drift in any of the three - a lost
-- unique index, an RLS policy that grants writes, a check constraint dropped during a rebase - is not visible
-- in application tests but is exactly the kind of thing that turns into a financial bug or a data leak.

\set ON_ERROR_STOP on
\timing off

do $$
begin
  raise notice 'UptimeSure schema assertions starting';
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Tables, views and functions exist
-- ---------------------------------------------------------------------------------------------------------

do $$
declare
  missing text;
begin
  select string_agg(t, ', ')
    into missing
  from unnest(array['guarantees', 'observations', 'incidents', 'chain_sync_state', 'monitor_runs']) as t
  where not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = t and table_type = 'BASE TABLE'
  );
  if missing is not null then
    raise exception 'missing tables: %', missing;
  end if;
end;
$$;

do $$
declare
  missing text;
begin
  select string_agg(x.table_name || '.' || x.column_name, ', ' order by x.table_name, x.column_name) into missing
  from (values
    ('observations', 'body_keccak256'), ('observations', 'chain_block_number'),
    ('observations', 'chain_block_hash'), ('observations', 'chain_log_index'),
    ('observations', 'chain_event_present'), ('monitor_runs', 'settlement_pending'),
    ('guarantees', 'chain_block_number'), ('guarantees', 'exhausted'), ('incidents', 'chain_block_number')
  ) as x(table_name, column_name)
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = x.table_name and c.column_name = x.column_name
  );
  if missing is not null then raise exception 'durable queue/canonical identity columns missing: %', missing; end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.views where table_schema = 'public' and table_name = 'chain_sync_public'
  ) then
    raise exception 'missing view public.chain_sync_public';
  end if;
end;
$$;

do $$
declare
  missing text;
begin
  select string_agg(f, ', ')
    into missing
  from unnest(array['claim_due_guarantees', 'complete_monitor_run', 'advance_chain_cursor', 'touch_updated_at']) as f
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f
  );
  if missing is not null then
    raise exception 'missing functions: %', missing;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Row level security is enabled on every table holding product data
-- ---------------------------------------------------------------------------------------------------------

do $$
declare
  unprotected text;
begin
  select string_agg(c.relname, ', ')
    into unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in ('guarantees', 'observations', 'incidents', 'chain_sync_state', 'monitor_runs')
    and not c.relrowsecurity;
  if unprotected is not null then
    raise exception 'row level security disabled on: %', unprotected;
  end if;
end;
$$;

-- The browser must be able to read the public record and must never be able to write it.
do $$
declare
  writable text;
begin
  select string_agg(format('%s:%s:%s', table_name, grantee, privilege_type), ', ')
    into writable
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and table_name in ('guarantees', 'observations', 'incidents', 'chain_sync_state', 'monitor_runs');
  if writable is not null then
    raise exception 'browser roles hold write privileges: %', writable;
  end if;
end;
$$;

do $$
declare
  readable integer;
begin
  select count(*)
    into readable
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and privilege_type = 'SELECT'
    and table_name in ('guarantees', 'observations', 'incidents');
  if readable <> 3 then
    raise exception 'anon must hold SELECT on guarantees, observations and incidents (found % of 3)', readable;
  end if;
end;
$$;

-- Scheduling and cursor state are operational, not public. anon must not read them directly.
do $$
declare
  leaked text;
begin
  select string_agg(format('%s:%s', table_name, grantee), ', ')
    into leaked
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and table_name in ('chain_sync_state', 'monitor_runs');
  if leaked is not null then
    raise exception 'operational tables exposed to browser roles: %', leaked;
  end if;
end;
$$;

-- Every table with RLS on and no permissive policy is inaccessible; the three public tables need read policies.
do $$
declare
  missing text;
begin
  select string_agg(t, ', ')
    into missing
  from unnest(array['guarantees', 'observations', 'incidents']) as t
  where not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = t and cmd = 'SELECT'
  );
  if missing is not null then
    raise exception 'missing public read policy on: %', missing;
  end if;
end;
$$;

-- No policy anywhere may permit a write from a browser role.
do $$
declare
  bad text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into bad
  from pg_policies
  where schemaname = 'public'
    and cmd <> 'SELECT'
    and (roles = '{public}' or roles && array['anon', 'authenticated']::name[]);
  if bad is not null then
    raise exception 'write policies exposed to browser roles: %', bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Keys, indexes and referential integrity
-- ---------------------------------------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.observations'::regclass and contype = 'f'
      and confrelid = 'public.guarantees'::regclass
  ) then
    raise exception 'observations must reference guarantees';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.incidents'::regclass and contype = 'f'
      and confrelid = 'public.guarantees'::regclass
  ) then
    raise exception 'incidents must reference guarantees';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.monitor_runs'::regclass and contype = 'f'
      and confrelid = 'public.guarantees'::regclass
  ) then
    raise exception 'monitor_runs must reference guarantees';
  end if;
end;
$$;

do $$
declare
  missing text;
begin
  select string_agg(i, ', ')
    into missing
  from unnest(array[
    'observations_slot_idx',
    'incidents_one_open_per_guarantee',
    'monitor_runs_open_idx',
    'guarantees_due_idx'
  ]) as i
  where not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = i);
  if missing is not null then
    raise exception 'missing indexes: %', missing;
  end if;
end;
$$;

-- monitor_runs is keyed on the slot: that primary key is what makes claiming idempotent.
do $$
declare
  cols text;
begin
  select string_agg(a.attname, ',' order by a.attnum)
    into cols
  from pg_constraint c
  join unnest(c.conkey) as k(attnum) on true
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.monitor_runs'::regclass and c.contype = 'p';
  if cols is distinct from 'guarantee_id,scheduled_for' then
    raise exception 'monitor_runs primary key must be (guarantee_id, scheduled_for), found (%)', cols;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Behavioural assertions: the constraints actually reject bad data
-- ---------------------------------------------------------------------------------------------------------

-- A guarantee row is the anchor for everything below.
insert into public.guarantees (
  id, contract_address, provider, beneficiary, endpoint_url, criteria_hash,
  expected_status, expected_fragment, max_latency_ms, check_interval_seconds,
  failure_threshold, min_outage_seconds, payout_per_incident, max_payouts,
  remaining_coverage, created_at, expires_at, next_check_at
) values (
  900001, '0x' || repeat('a', 40), '0x' || repeat('b', 40), '0x' || repeat('c', 40),
  'https://example.com/health', '0x' || repeat('1', 64),
  200, '', 2000, 60, 3, 120, 5000000, 5, 25000000,
  now(), now() + interval '30 days', now()
) on conflict (id) do nothing;

-- Mixed-case addresses must be refused: lower() indexes and equality checks depend on lowercase storage.
do $$
begin
  begin
    insert into public.guarantees (
      id, contract_address, provider, beneficiary, endpoint_url, criteria_hash,
      expected_status, max_latency_ms, check_interval_seconds, failure_threshold,
      min_outage_seconds, payout_per_incident, max_payouts, remaining_coverage,
      created_at, expires_at
    ) values (
      900002, '0x' || repeat('A', 40), '0x' || repeat('b', 40), '0x' || repeat('c', 40),
      'https://example.com/health', '0x' || repeat('1', 64),
      200, 2000, 60, 3, 120, 5000000, 5, 25000000, now(), now() + interval '30 days'
    );
    raise exception 'a mixed-case contract address was accepted';
  exception
    when check_violation then null;
  end;
end;
$$;

-- A non-HTTPS endpoint must be refused at the database layer too, not only in the contract.
do $$
begin
  begin
    insert into public.guarantees (
      id, contract_address, provider, beneficiary, endpoint_url, criteria_hash,
      expected_status, max_latency_ms, check_interval_seconds, failure_threshold,
      min_outage_seconds, payout_per_incident, max_payouts, remaining_coverage,
      created_at, expires_at
    ) values (
      900003, '0x' || repeat('a', 40), '0x' || repeat('b', 40), '0x' || repeat('c', 40),
      'http://example.com/health', '0x' || repeat('1', 64),
      200, 2000, 60, 3, 120, 5000000, 5, 25000000, now(), now() + interval '30 days'
    );
    raise exception 'a plaintext http endpoint was accepted';
  exception
    when check_violation then null;
  end;
end;
$$;

-- paid_payouts may never exceed max_payouts: that would mean the contract paid more incidents than it allows.
do $$
begin
  begin
    update public.guarantees set paid_payouts = 99 where id = 900001;
    raise exception 'paid_payouts was allowed to exceed max_payouts';
  exception
    when check_violation then null;
  end;
end;
$$;

-- The central rule: a policy-refused observation may never be recorded as healthy.
do $$
begin
  begin
    insert into public.observations (
      observation_id, guarantee_id, observed_at, healthy, evidence_hash, tx_status
    ) values (
      '0x' || repeat('2', 64), 900001, now(), true, '0x' || repeat('3', 64), 'unmonitorable'
    );
    raise exception 'an unmonitorable observation was accepted as healthy';
  exception
    when check_violation then null;
  end;
end;
$$;

-- A confirmed observation without a transaction hash is not evidence of anything.
do $$
begin
  begin
    insert into public.observations (
      observation_id, guarantee_id, observed_at, healthy, evidence_hash, tx_status
    ) values (
      '0x' || repeat('4', 64), 900001, now(), true, '0x' || repeat('5', 64), 'confirmed'
    );
    raise exception 'a confirmed observation without a tx_hash was accepted';
  exception
    when check_violation then null;
  end;
end;
$$;

-- The monitor writes the transaction hash before it waits for a receipt, so the in-flight state must be
-- storable. 'submitted' carries a hash; 'pending' must not. Getting this wrong silently discards the only
-- record of a broadcast transaction, which is the one thing needed to recover from a mid-wait crash.
do $$
begin
  insert into public.observations (
    observation_id, guarantee_id, observed_at, healthy, evidence_hash, tx_status, tx_hash
  ) values (
    '0x' || repeat('a', 64), 900001, now(), false, '0x' || repeat('e', 64), 'submitted', '0x' || repeat('f', 64)
  );

  begin
    update public.observations
       set tx_status = 'pending'
     where observation_id = '0x' || repeat('a', 64);
    raise exception 'a pending observation was allowed to keep a tx_hash';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.observations (
      observation_id, guarantee_id, observed_at, healthy, evidence_hash, tx_status
    ) values (
      '0x' || repeat('1', 64), 900001, now(), false, '0x' || repeat('e', 64), 'submitted'
    );
    raise exception 'a submitted observation without a tx_hash was accepted';
  exception
    when check_violation then null;
  end;

  -- A row that reached the chain must not also carry a chain error: that would be evidence contradicting itself.
  begin
    update public.observations
       set chain_error = 'TRANSACTION_REVERTED'
     where observation_id = '0x' || repeat('a', 64);
    raise exception 'a submitted observation was allowed to carry a chain_error';
  exception
    when check_violation then null;
  end;

  delete from public.observations where observation_id = '0x' || repeat('a', 64);
end;
$$;

-- Malformed hex must be rejected rather than silently stored.
do $$
begin
  begin
    insert into public.observations (
      observation_id, guarantee_id, observed_at, healthy, evidence_hash
    ) values ('not-a-hash', 900001, now(), true, '0x' || repeat('6', 64));
    raise exception 'a malformed observation_id was accepted';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.observations (
      observation_id, guarantee_id, observed_at, healthy, evidence_hash
    ) values ('0x' || repeat('7', 64), 900001, now(), true, '0xNOTHEX');
    raise exception 'a malformed evidence_hash was accepted';
  exception
    when check_violation then null;
  end;
end;
$$;

-- Two observations for the same guarantee and slot must collide: that is what makes a retry idempotent.
do $$
begin
  insert into public.observations (
    observation_id, guarantee_id, observed_at, healthy, evidence_hash, tx_status, scheduled_for
  ) values (
    '0x' || repeat('8', 64), 900001, now(), true, '0x' || repeat('9', 64), 'not_required',
    '2026-01-01T00:00:00Z'
  );

  begin
    insert into public.observations (
      observation_id, guarantee_id, observed_at, healthy, evidence_hash, tx_status, scheduled_for
    ) values (
      '0x' || repeat('b', 64), 900001, now(), true, '0x' || repeat('c', 64), 'not_required',
      '2026-01-01T00:00:00Z'
    );
    raise exception 'a duplicate observation for the same scheduled slot was accepted';
  exception
    when unique_violation then null;
  end;
end;
$$;

-- Only one unrecovered incident per guarantee, mirroring the contract's activeIncidentId invariant.
do $$
begin
  insert into public.incidents (
    id, guarantee_id, started_at, confirmed_at, payout_amount, confirm_evidence_hash
  ) values (900001, 900001, now() - interval '5 min', now(), 5000000, '0x' || repeat('d', 64));

  begin
    insert into public.incidents (
      id, guarantee_id, started_at, confirmed_at, payout_amount, confirm_evidence_hash
    ) values (900002, 900001, now() - interval '2 min', now(), 5000000, '0x' || repeat('e', 64));
    raise exception 'a second open incident for one guarantee was accepted';
  exception
    when unique_violation then null;
  end;

  -- Once recovered, a new incident is legitimate.
  update public.incidents set recovered_at = now() where id = 900001;
  insert into public.incidents (
    id, guarantee_id, started_at, confirmed_at, payout_amount, confirm_evidence_hash
  ) values (900002, 900001, now() - interval '2 min', now(), 5000000, '0x' || repeat('e', 64));
end;
$$;

-- An incident confirmed before it started is a timeline the indexer must never produce.
do $$
begin
  begin
    insert into public.incidents (
      id, guarantee_id, started_at, confirmed_at, payout_amount, confirm_evidence_hash
    ) values (900003, 900001, now(), now() - interval '10 min', 0, '0x' || repeat('f', 64));
    raise exception 'an incident confirmed before it started was accepted';
  exception
    when check_violation then null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Claim/lease behaviour: the actual concurrency guarantee
-- ---------------------------------------------------------------------------------------------------------

do $$
declare
  first_count integer;
  second_count integer;
  v_token uuid;
  v_slot timestamptz;
begin
  -- Make the fixture guarantee due right now and clear any prior run.
  delete from public.monitor_runs where guarantee_id = 900001;
  update public.guarantees set next_check_at = now() - interval '1 minute', active = true, withdrawn = false
   where id = 900001;

  select count(*) into first_count from public.claim_due_guarantees(10, 120) where guarantee_id = 900001;
  if first_count <> 1 then
    raise exception 'a due guarantee was not claimed (got % rows)', first_count;
  end if;

  -- The second caller in the same tick must get nothing: the lease is live.
  select count(*) into second_count from public.claim_due_guarantees(10, 120) where guarantee_id = 900001;
  if second_count <> 0 then
    raise exception 'a live lease was claimed twice - concurrent monitors would duplicate work';
  end if;

  -- An expired lease must be re-claimable, otherwise a crashed worker strands the guarantee forever.
  update public.monitor_runs
     set lease_expires_at = now() - interval '1 second'
   where guarantee_id = 900001 and completed_at is null;

  select count(*) into second_count from public.claim_due_guarantees(10, 120) where guarantee_id = 900001;
  if second_count <> 1 then
    raise exception 'an expired lease was not reclaimable (got % rows)', second_count;
  end if;

  select attempts into second_count from public.monitor_runs where guarantee_id = 900001 and completed_at is null;
  if second_count < 2 then
    raise exception 'reclaiming a lease must increment attempts (got %)', second_count;
  end if;

  -- Completing with the wrong token must be refused, so a zombie worker cannot rewind the schedule.
  select scheduled_for, claim_token into v_slot, v_token
    from public.monitor_runs where guarantee_id = 900001 and completed_at is null;

  if public.complete_monitor_run(900001, v_slot, gen_random_uuid(), null) then
    raise exception 'complete_monitor_run accepted a stale claim token';
  end if;

  if not public.complete_monitor_run(900001, v_slot, v_token, null) then
    raise exception 'complete_monitor_run rejected the live claim token';
  end if;

  -- Completing twice is a no-op, not an error.
  if public.complete_monitor_run(900001, v_slot, v_token, null) then
    raise exception 'complete_monitor_run completed the same run twice';
  end if;

  -- The schedule must have advanced past the slot it just finished.
  if (select next_check_at from public.guarantees where id = 900001) <= v_slot then
    raise exception 'completing a run did not advance next_check_at';
  end if;

  -- A completed slot must not be re-claimed even though next_check_at may still be in the past.
  update public.guarantees set next_check_at = v_slot where id = 900001;
  select count(*) into second_count from public.claim_due_guarantees(10, 120) where guarantee_id = 900001;
  if second_count <> 0 then
    raise exception 'a completed slot was claimed again';
  end if;
end;
$$;

-- An expired or withdrawn guarantee must never be claimed for monitoring.
do $$
declare
  claimed integer;
begin
  delete from public.monitor_runs where guarantee_id = 900001;

  -- Backdate creation as well as expiry. `guarantees_policy_bounds` enforces `expires_at > created_at`, so
  -- moving expiry into the past alone would construct a row the schema legitimately forbids and the failure
  -- would be the test's, not the scheduler's. A real expired guarantee was created before it expired.
  update public.guarantees
     set next_check_at = now() - interval '1 minute',
         created_at = now() - interval '31 days',
         expires_at = now() - interval '1 day'
   where id = 900001;
  select count(*) into claimed from public.claim_due_guarantees(10, 120) where guarantee_id = 900001;
  if claimed <> 0 then
    raise exception 'an expired guarantee was claimed for monitoring';
  end if;

  update public.guarantees set expires_at = now() + interval '30 days', withdrawn = true where id = 900001;
  delete from public.monitor_runs where guarantee_id = 900001;
  select count(*) into claimed from public.claim_due_guarantees(10, 120) where guarantee_id = 900001;
  if claimed <> 0 then
    raise exception 'a withdrawn guarantee was claimed for monitoring';
  end if;

  update public.guarantees set withdrawn = false, active = false where id = 900001;
  delete from public.monitor_runs where guarantee_id = 900001;
  select count(*) into claimed from public.claim_due_guarantees(10, 120) where guarantee_id = 900001;
  if claimed <> 0 then
    raise exception 'an inactive guarantee was claimed for monitoring';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Chain cursor behaviour
-- ---------------------------------------------------------------------------------------------------------

do $$
declare
  v_cursor bigint;
begin
  update public.chain_sync_state set last_synced_block = null, deploy_block = 1000 where id = 1;

  v_cursor := public.advance_chain_cursor(1500, 1600, 3, null);
  if v_cursor <> 1500 then
    raise exception 'cursor did not advance to 1500 (got %)', v_cursor;
  end if;

  -- A backwards advance must be ignored: a failed or out-of-order run cannot cause an unbounded replay.
  v_cursor := public.advance_chain_cursor(1200, 1600, 0, 'simulated failure');
  if v_cursor <> 1500 then
    raise exception 'cursor moved backwards to % - replay risk', v_cursor;
  end if;

  if (select last_error from public.chain_sync_state where id = 1) is distinct from 'simulated failure' then
    raise exception 'advance_chain_cursor did not record last_error';
  end if;

  if (select events_indexed from public.chain_sync_state where id = 1) <> 3 then
    raise exception 'events_indexed did not accumulate';
  end if;

  -- The public projection must expose health without exposing anything else.
  if not exists (select 1 from public.chain_sync_public) then
    raise exception 'chain_sync_public returned no row';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Clean up the fixtures so the assertions leave no residue behind
-- ---------------------------------------------------------------------------------------------------------

delete from public.guarantees where id between 900001 and 900003;
update public.chain_sync_state
   set last_synced_block = null, safe_block = null, deploy_block = null,
       events_indexed = 0, last_error = null, last_run_at = null
 where id = 1;

do $$
declare
  residue integer;
begin
  select count(*) into residue from public.guarantees where id between 900001 and 900003;
  if residue <> 0 then
    raise exception 'fixture guarantees were not cleaned up';
  end if;
  -- The cascade must have removed dependent rows with them.
  select count(*) into residue from public.observations where guarantee_id between 900001 and 900003;
  if residue <> 0 then
    raise exception 'observations were not cascade-deleted with their guarantee';
  end if;
  select count(*) into residue from public.incidents where guarantee_id between 900001 and 900003;
  if residue <> 0 then
    raise exception 'incidents were not cascade-deleted with their guarantee';
  end if;
  select count(*) into residue from public.monitor_runs where guarantee_id between 900001 and 900003;
  if residue <> 0 then
    raise exception 'monitor_runs were not cascade-deleted with their guarantee';
  end if;

  raise notice 'UptimeSure schema assertions passed';
end;
$$;
