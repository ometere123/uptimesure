# Supabase runtime

UptimeSure uses one Supabase Free project for Postgres, the public read models, Cron and two Edge Functions.

## Deploy

1. Create a Supabase project.

2. Apply every migration in `migrations/` in filename order:

```text
0001_uptimesure.sql               core schema, indexes, RLS, public read models
0002_observation_chain_status.sql observation chain-status lifecycle
0003_monitor_claim_lease.sql      claim/lease RPCs for single-occupancy scheduling
0004_evidence_integrity.sql       evidence constraints
0005_chain_sync_hardening.sql     cursor state and monotonic advance
0006_observation_submitted_status.sql  submitted status
0007_durable_settlement_queue.sql      immutable evidence settlement retry queue and Keccak column rename
0008_chain_canonical_identity.sql      canonical log identity and reorg invalidation metadata
```

They are idempotent — CI applies the whole set twice and then asserts the schema invariants in `tests/schema_assertions.sql`, so a partial or repeated run is recoverable rather than requiring a reset.

3. Deploy `monitor-due` and `sync-chain`.

4. Configure Function secrets:

```bash
supabase secrets set CRON_SECRET=<random-value-at-least-24-chars>
supabase secrets set BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
supabase secrets set UPTIMESURE_CONTRACT_ADDRESS=<deployed-address>
supabase secrets set UPTIMESURE_DEPLOY_BLOCK=<deployment-block>
supabase secrets set MONITOR_PRIVATE_KEY=<restricted-monitor-key>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform and do not need setting by hand.

`CRON_SECRET` must be at least 24 characters. Both functions return `500 MISCONFIGURED` rather than running if it is shorter, because these are public HTTPS endpoints standing in front of the monitor's signing key.

The monitor key must hold only the contract `MONITOR_ROLE` and enough Base Sepolia ETH for gas. It must not custody guarantee USDC. `UPTIMESURE_DEPLOY_BLOCK` matters for correctness, not just speed: `sync-chain` starts from it instead of genesis, so a wrong value either skips history or wastes the run budget.

5. Edit and run `cron.sql`. Store the project URL, publishable key and the same `CRON_SECRET` in Supabase Vault as shown there. It schedules `sync-chain` and `monitor-due` once per minute each.

## Responsibilities

- `sync-chain`: indexes UptimeSure contract events in bounded block chunks behind a confirmation depth, advancing a persisted monotonic cursor, and refreshes the public read models.
- `monitor-due`: claims due guarantees through an atomic lease, performs bounded HTTPS GET probes against validated targets, stores immutable hashed evidence, and submits observations onchain when contract state requires it. Chain failures keep the same scheduled slot queued; retries reuse the stored observation and never re-probe. Healthy steady state is recorded offchain and costs no gas.
- Postgres: history and read model only. Base Sepolia contract state is authoritative for funds and payout rules; editing a row here cannot move coverage.
