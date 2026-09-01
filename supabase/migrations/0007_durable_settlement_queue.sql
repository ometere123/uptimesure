-- Durable settlement retries. An HTTP observation is a fact about one scheduled slot; chain submission is a
-- separate, retryable workflow over that immutable fact.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'observations' and column_name = 'body_sha256'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'observations' and column_name = 'body_keccak256'
  ) then
    alter table public.observations rename column body_sha256 to body_keccak256;
  end if;
end $$;

comment on column public.observations.body_keccak256 is
  'Keccak-256 digest of the bounded response body. This is not SHA-256.';

alter table public.monitor_runs
  add column if not exists settlement_pending boolean not null default false;

comment on column public.monitor_runs.settlement_pending is
  'True when immutable evidence exists but chain settlement still needs reconciliation or retry.';

alter table public.observations drop constraint if exists observations_body_sha256_shape;
alter table public.observations
  drop constraint if exists observations_body_keccak256_shape;
alter table public.observations
  add constraint observations_body_keccak256_shape
  check (body_keccak256 is null or body_keccak256 ~ '^0x[0-9a-f]{64}$');

-- A pending settlement remains due, but its lease is immediately reclaimable. A successful retry is the only
-- path that advances the schedule, so chain outages cannot silently consume a scheduled observation.
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
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
begin
  return query
  with due as (
    select g.id, g.next_check_at from public.guarantees g
    where g.active and not g.withdrawn and g.next_check_at <= now()
      and (g.expires_at > now() or exists (
        select 1 from public.observations o
        where o.guarantee_id = g.id and o.scheduled_for = g.next_check_at
          and o.tx_status in ('pending', 'submitted', 'failed')
      ))
    order by g.next_check_at asc limit v_limit for update skip locked
  ), claimed as (
    insert into public.monitor_runs as mr (guarantee_id, scheduled_for, claim_token, lease_expires_at)
    select d.id, d.next_check_at, gen_random_uuid(), now() + make_interval(secs => v_lease) from due d
    on conflict on constraint monitor_runs_pkey do update
      set claim_token = gen_random_uuid(), claimed_at = now(), lease_expires_at = now() + make_interval(secs => v_lease),
          attempts = mr.attempts + 1
      where mr.completed_at is null and mr.lease_expires_at < now()
    returning mr.guarantee_id, mr.scheduled_for, mr.claim_token, mr.attempts
  )
  select c.guarantee_id, c.scheduled_for, c.claim_token, c.attempts, g.endpoint_url, g.expected_status,
    g.expected_fragment, g.max_latency_ms, g.check_interval_seconds, g.failure_threshold, g.expires_at,
    g.last_observed_at, g.consecutive_failures
  from claimed c join public.guarantees g on g.id = c.guarantee_id;
end;
$$;

drop function if exists public.complete_monitor_run(bigint, timestamptz, uuid, text);

create or replace function public.complete_monitor_run(
  p_guarantee_id bigint,
  p_scheduled_for timestamptz,
  p_claim_token uuid,
  p_last_error text default null,
  p_settlement_pending boolean default false
)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_interval integer;
  v_next timestamptz;
begin
  update public.monitor_runs
  set completed_at = case when p_settlement_pending then null else now() end,
      settlement_pending = p_settlement_pending,
      lease_expires_at = case when p_settlement_pending then now() else lease_expires_at end,
      last_error = left(p_last_error, 500)
  where guarantee_id = p_guarantee_id and scheduled_for = p_scheduled_for and claim_token = p_claim_token
    and completed_at is null;
  if not found then return false; end if;
  if p_settlement_pending then return true; end if;

  select check_interval_seconds into v_interval from public.guarantees where id = p_guarantee_id;
  if v_interval is null then return false; end if;
  v_next := greatest(p_scheduled_for + make_interval(secs => v_interval), now());
  update public.guarantees set next_check_at = v_next where id = p_guarantee_id and next_check_at < v_next;
  return true;
end;
$$;

revoke all on function public.complete_monitor_run(bigint, timestamptz, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.complete_monitor_run(bigint, timestamptz, uuid, text, boolean) to service_role;
