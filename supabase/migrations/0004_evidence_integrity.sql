-- Separates "this endpoint was refused by policy" from "this endpoint was down", and tightens row constraints.
--
-- This is the most important correctness rule in the monitoring engine. The previous probe implementation
-- wrapped target validation inside the same try/catch as the HTTP request, so an endpoint rejected for SSRF
-- reasons - a private IP, a credentialed URL, an unresolvable host - was recorded as `healthy = false` and fed
-- into the consecutive-failure counter exactly like a real outage. A guarantee created against such an endpoint
-- would therefore mint incidents and drain the provider's coverage without any service ever having failed.
--
-- A refusal is now a terminal, non-financial status: never healthy, never unhealthy, never submitted onchain.

alter table public.observations
  drop constraint if exists observations_tx_status_check;

alter table public.observations
  add constraint observations_tx_status_check
  check (tx_status in ('pending', 'confirmed', 'failed', 'indexed', 'not_required', 'unmonitorable'));

comment on column public.observations.tx_status is
  'Chain submission lifecycle. not_required: healthy steady-state probe deliberately kept offchain to avoid '
  'unnecessary gas. unmonitorable: the endpoint was refused by target policy (SSRF/validation), so the row is '
  'evidence of a refusal and is never treated as an outage or submitted onchain.';

-- An observation that was refused by policy must never be recorded as a service failure. Enforced in the
-- database rather than only in the function, so no future code path can quietly reintroduce the bug.
alter table public.observations
  drop constraint if exists observations_unmonitorable_not_a_failure;

alter table public.observations
  add constraint observations_unmonitorable_not_a_failure
  check (tx_status <> 'unmonitorable' or healthy = false);

-- A refused observation has no chain transaction, and a confirmed one must have a hash.
alter table public.observations
  drop constraint if exists observations_tx_hash_presence;

alter table public.observations
  add constraint observations_tx_hash_presence
  check (
    (tx_status in ('pending', 'not_required', 'unmonitorable') and tx_hash is null)
    or (tx_status in ('confirmed', 'indexed') and tx_hash is not null)
    or tx_status = 'failed'
  );

-- Shape checks on hex-encoded values. Without these a typo or an encoding change writes silent garbage into
-- the evidence record, and the evidence record is the whole product.
alter table public.observations
  drop constraint if exists observations_evidence_hash_shape;
alter table public.observations
  add constraint observations_evidence_hash_shape check (evidence_hash ~ '^0x[0-9a-f]{64}$');

alter table public.observations
  drop constraint if exists observations_observation_id_shape;
alter table public.observations
  add constraint observations_observation_id_shape check (observation_id ~ '^0x[0-9a-f]{64}$');

alter table public.observations
  drop constraint if exists observations_body_sha256_shape;
alter table public.observations
  add constraint observations_body_sha256_shape
  check (body_sha256 is null or body_sha256 ~ '^0x[0-9a-f]{64}$');

alter table public.observations
  drop constraint if exists observations_tx_hash_shape;
alter table public.observations
  add constraint observations_tx_hash_shape check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$');

alter table public.observations
  drop constraint if exists observations_http_status_range;
alter table public.observations
  add constraint observations_http_status_range
  check (http_status is null or (http_status >= 0 and http_status <= 599));

alter table public.observations
  drop constraint if exists observations_latency_nonnegative;
alter table public.observations
  add constraint observations_latency_nonnegative check (latency_ms is null or latency_ms >= 0);

-- Addresses are stored lowercase-hex so the lower(provider) indexes are usable and equality is unambiguous.
alter table public.guarantees
  drop constraint if exists guarantees_provider_shape;
alter table public.guarantees
  add constraint guarantees_provider_shape check (provider ~ '^0x[0-9a-f]{40}$');

alter table public.guarantees
  drop constraint if exists guarantees_beneficiary_shape;
alter table public.guarantees
  add constraint guarantees_beneficiary_shape check (beneficiary ~ '^0x[0-9a-f]{40}$');

alter table public.guarantees
  drop constraint if exists guarantees_contract_shape;
alter table public.guarantees
  add constraint guarantees_contract_shape check (contract_address ~ '^0x[0-9a-f]{40}$');

alter table public.guarantees
  drop constraint if exists guarantees_endpoint_https;
alter table public.guarantees
  add constraint guarantees_endpoint_https check (endpoint_url like 'https://%');

-- Policy bounds mirrored from UptimeSureCore._validateCreateParams. The contract is authoritative; if a row
-- ever violates these, the indexer has misread an event and the read model is not to be trusted.
alter table public.guarantees
  drop constraint if exists guarantees_policy_bounds;
alter table public.guarantees
  add constraint guarantees_policy_bounds check (
    expected_status between 100 and 599
    and max_latency_ms between 100 and 30000
    and check_interval_seconds between 60 and 86400
    and failure_threshold between 1 and 10
    and min_outage_seconds >= 0
    and max_payouts between 1 and 100
    and paid_payouts >= 0
    and paid_payouts <= max_payouts
    and consecutive_failures >= 0
    and payout_per_incident > 0
    and remaining_coverage >= 0
    and expires_at > created_at
  );

alter table public.incidents
  drop constraint if exists incidents_timeline_ordered;
alter table public.incidents
  add constraint incidents_timeline_ordered check (
    confirmed_at >= started_at
    and (recovered_at is null or recovered_at >= started_at)
    and payout_amount >= 0
  );

alter table public.incidents
  drop constraint if exists incidents_confirm_hash_shape;
alter table public.incidents
  add constraint incidents_confirm_hash_shape check (confirm_evidence_hash ~ '^0x[0-9a-f]{64}$');

-- One open incident per guarantee, matching the contract's activeIncidentId invariant. A second unrecovered
-- incident for the same guarantee means the indexer has double-counted.
create unique index if not exists incidents_one_open_per_guarantee
  on public.incidents (guarantee_id)
  where recovered_at is null;
