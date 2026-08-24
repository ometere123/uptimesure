-- Atomic claim/lease for the monitoring engine.
--
-- The previous scheduler selected due rows with `next_check_at <= now()` and then updated them. Two Edge
-- Function invocations firing on the same cron tick - or one slow run overlapping the next tick - would both
-- select the same guarantee and both probe and submit it. Onchain, the second submission either wastes gas on
-- an ObservationTooSoon revert or, worse, counts a second consecutive failure for a single real outage and
-- pulls a payout forward. The fix is to make claiming a slot an atomic, leased, idempotent operation.
--
-- Guarantees provided here:
--   * Atomic claim         - `for update skip locked` means two concurrent callers never receive the same row.
--   * Slot idempotency     - the primary key (guarantee_id, scheduled_for) makes a scheduled slot claimable
--                            exactly once while it is in flight or completed.
--   * Crash recovery       - a lease that expires without `completed_at` may be re-claimed, so a worker killed
--                            mid-run does not strand its guarantee forever.
--   * Zombie fencing       - completion requires the claim token, so a worker whose lease expired and was
--                            stolen cannot overwrite the newer worker's scheduling decision.

create table if not exists public.monitor_runs (
  guarantee_id bigint not null references public.guarantees(id) on delete cascade,
  -- The scheduled slot this run is responsible for: the value of guarantees.next_check_at at claim time.
  -- Part of the key, so retrying a slot is idempotent while moving to a new slot is always a fresh row.
  scheduled_for timestamptz not null,
  claim_token uuid not null,
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  completed_at timestamptz,
  attempts integer not null default 1 check (attempts > 0),
  last_error text,
  constraint monitor_runs_pkey primary key (guarantee_id, scheduled_for)
);

comment on table public.monitor_runs is
  'One row per (guarantee, scheduled slot). Held lease prevents concurrent or duplicate monitoring of a slot.';

-- Lets the sweeper and operators find stuck or repeatedly failing runs without scanning the whole table.
create index if not exists monitor_runs_open_idx
  on public.monitor_runs (lease_expires_at)
  where completed_at is null;

create index if not exists monitor_runs_recent_idx
  on public.monitor_runs (guarantee_id, claimed_at desc);

alter table public.monitor_runs enable row level security;

-- Operational scheduling state, not part of the public financial record: no anon/authenticated read policy.
revoke all on public.monitor_runs from anon, authenticated;

/**
 * Atomically claims up to p_limit due guarantees and returns everything the monitor needs to probe them.
 *
 * A guarantee is due when it is active, not withdrawn, unexpired, and next_check_at has passed. A due
 * guarantee is claimable when it has no open run for its current slot, or when the open run's lease has
 * expired (the previous worker died).
 */
create or replace function public.claim_due_guarantees(
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  guarantee_id bigint,
  scheduled_for timestamptz,
  claim_token uuid,
  attempts integer,
  endpoint_url text,
  expected_status integer,
  expected_fragment text,
  max_latency_ms integer,
  check_interval_seconds integer,
  failure_threshold integer,
  expires_at timestamptz,
  last_observed_at timestamptz,
  consecutive_failures integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- Every RETURNS TABLE column above is also an in-scope PL/pgSQL variable, so a bare `guarantee_id` inside the
-- query body is ambiguous and Postgres refuses to guess. The conflict is resolved two ways, because each
-- covers a case the other cannot: this pragma makes an ambiguous *reference* resolve to the column, and the
-- ON CONFLICT clause below names the constraint instead of re-listing columns, because the inference-list
-- position is not a value expression and the pragma does not reach it.
#variable_conflict use_column
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
begin
  return query
  with due as (
    select g.id, g.next_check_at
    from public.guarantees g
    where g.active
      and not g.withdrawn
      and g.next_check_at <= now()
      and g.expires_at > now()
    order by g.next_check_at asc
    limit v_limit
    -- Skips rows another transaction is already claiming instead of blocking behind them.
    for update skip locked
  ),
  claimed as (
    insert into public.monitor_runs as mr (guarantee_id, scheduled_for, claim_token, lease_expires_at)
    select d.id, d.next_check_at, gen_random_uuid(), now() + make_interval(secs => v_lease)
    from due d
    on conflict on constraint monitor_runs_pkey do update
      set claim_token = gen_random_uuid(),
          claimed_at = now(),
          lease_expires_at = now() + make_interval(secs => v_lease),
          attempts = mr.attempts + 1
      -- Only an abandoned run may be taken over. A live lease or a completed slot yields no row, so the
      -- caller simply does not receive that guarantee this tick.
      where mr.completed_at is null
        and mr.lease_expires_at < now()
    returning mr.guarantee_id, mr.scheduled_for, mr.claim_token, mr.attempts
  )
  select
    c.guarantee_id,
    c.scheduled_for,
    c.claim_token,
    c.attempts,
    g.endpoint_url,
    g.expected_status,
    g.expected_fragment,
    g.max_latency_ms,
    g.check_interval_seconds,
    g.failure_threshold,
    g.expires_at,
    g.last_observed_at,
    g.consecutive_failures
  from claimed c
  join public.guarantees g on g.id = c.guarantee_id;
end;
$$;

comment on function public.claim_due_guarantees(integer, integer) is
  'Atomically leases due guarantees for monitoring. Concurrent callers never receive the same slot.';

/**
 * Releases a claimed run and advances the guarantee to its next slot.
 *
 * The claim token fences a zombie worker: if its lease expired and another worker took over, its token no
 * longer matches and this call becomes a no-op rather than corrupting the schedule.
 *
 * next_check_at advances from the scheduled slot rather than from now(), so a slow run does not drift the
 * cadence. It is clamped forward to at least now() so a long backlog cannot produce a tight retry loop.
 */
create or replace function public.complete_monitor_run(
  p_guarantee_id bigint,
  p_scheduled_for timestamptz,
  p_claim_token uuid,
  p_last_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_interval integer;
  v_next timestamptz;
  v_matched boolean;
begin
  update public.monitor_runs
     set completed_at = now(),
         last_error = left(p_last_error, 500)
   where guarantee_id = p_guarantee_id
     and scheduled_for = p_scheduled_for
     and claim_token = p_claim_token
     and completed_at is null;

  v_matched := found;
  if not v_matched then
    return false;
  end if;

  select check_interval_seconds into v_interval
  from public.guarantees
  where id = p_guarantee_id;

  if v_interval is null then
    return false;
  end if;

  v_next := greatest(p_scheduled_for + make_interval(secs => v_interval), now());

  update public.guarantees
     set next_check_at = v_next
   where id = p_guarantee_id
     -- Never move a schedule backwards: the chain indexer may already have advanced it.
     and next_check_at < v_next;

  return true;
end;
$$;

comment on function public.complete_monitor_run(bigint, timestamptz, uuid, text) is
  'Closes a leased monitoring run and advances next_check_at. Returns false if the claim token no longer holds.';

-- Only the service role reaches these. The browser holds a publishable key and must never schedule work.
revoke all on function public.claim_due_guarantees(integer, integer) from public, anon, authenticated;
revoke all on function public.complete_monitor_run(bigint, timestamptz, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_due_guarantees(integer, integer) to service_role;
grant execute on function public.complete_monitor_run(bigint, timestamptz, uuid, text) to service_role;

-- The observation a monitor writes is derived from (guarantee, slot); a retry must collide rather than insert a
-- second row for the same slot. observation_id is already the primary key and is derived deterministically from
-- those two values, so this index documents and enforces the intent explicitly.
alter table public.observations
  add column if not exists scheduled_for timestamptz;

create unique index if not exists observations_slot_idx
  on public.observations (guarantee_id, scheduled_for)
  where scheduled_for is not null;
