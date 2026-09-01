# UptimeSure V1 Architecture

UptimeSure is an executable service-guarantee product. A provider fully funds a maximum liability in Circle test USDC on Base Sepolia. Supabase performs deterministic HTTPS checks on a schedule, and a restricted monitor key submits bounded observations. The Solidity contract remains authoritative for coverage, thresholds, incidents and payouts.

Every constant quoted in this document is the value in the source, not a target. Where the code and this file disagree, the code is correct and this file is a bug.

## Runtime

```text
Browser / wallet
      |
      v
Next.js on Vercel
      |
      +------ public reads ------> Supabase Postgres
      |                                ^
      |                                |
      |                          sync-chain Edge Function
      |                                ^
      v                                |
UptimeSureCore.sol <---- observation ---+
Base Sepolia              ^             |
      |                   |             |
      |              monitor-due        |
      |              Edge Function -----+
      |                   ^
      |                   |
      |              Supabase Cron
      |
      v
Circle Base Sepolia test USDC
```

The frontend reads two independent sources: the contract over RPC, and the Supabase read model. It does not require both. When they disagree the detail page renders the divergence and labels the contract as authoritative, because an indexer that has fallen behind is a display problem and must not be presented as a change in financial state.

## Authority boundaries

**Base Sepolia contract** — provider and beneficiary, endpoint and deterministic monitoring terms, fully funded coverage, payout per incident and maximum payout count, observation replay/spacing/freshness guards, consecutive-failure and minimum-outage state, incident confirmation and recovery, remaining coverage, and the automatic beneficiary payout.

**Supabase Edge Functions** — perform real public unauthenticated HTTPS GET requests, cap timeout and response bytes, verify expected status/body fragment/completed-response latency, compute immutable evidence, submit an observation using a key holding only `MONITOR_ROLE`, and index contract state into the public read tables.

**Supabase Postgres** — a read model and evidence store. It is not authoritative for funds. Deleting a row does not alter coverage or contract state.

**Vercel** — hosts the frontend only. No long-running server.

## Contract parameters

```text
MIN_CHECK_INTERVAL     60 seconds
MAX_CHECK_INTERVAL     86_400 seconds
MAX_LATENCY_MS         30_000
MAX_TERM               366 days
MAX_OBSERVATION_AGE    10 minutes
FUTURE_TOLERANCE       30 seconds
SETTLEMENT_WINDOW      30 minutes
```

`MAX_OBSERVATION_AGE` and `FUTURE_TOLERANCE` bound the timestamp a monitor may assert: an observation that is too old or dated too far ahead is rejected rather than trusted.

`SETTLEMENT_WINDOW` is the reason a provider cannot reclaim coverage the instant a guarantee expires. An outage that began inside the covered term may still be settling when the term ends, so `withdrawExpired` requires `block.timestamp > expiresAt + SETTLEMENT_WINDOW`. The comparison is strict, which is why the frontend's `withdrawableAt` adds one second — enabling the button on the boundary second would offer an action that still reverts.

## Monitoring cadence and concurrency

One Supabase Cron job calls `monitor-due` each minute.

```text
MAX_DUE_PER_RUN      10 guarantees per invocation
PARALLELISM          5 concurrent probes
LEASE_SECONDS        120
RUN_BUDGET_MS        50_000
PROBE_TIMEOUT_MS     8_000
MAX_BODY_BYTES        65_536
RECEIPT_TIMEOUT_MS   60_000
```

Selection is **not** `select ... where next_check_at <= now()`. That pattern lets two overlapping invocations pick the same guarantee for the same slot and submit two observations for one scheduled check. Instead the function calls two `security definer` RPCs:

- `claim_due_guarantees(p_limit, p_lease_seconds)` selects due rows `for update skip locked`, so a concurrent invocation steps over rows already being claimed instead of blocking behind them. It then inserts a `monitor_runs` row keyed `(guarantee_id, scheduled_for)`. That unique key is what makes a slot single-occupancy: the `on conflict do update` takeover fires only `where completed_at is null and lease_expires_at < now()`, so a live lease or an already-completed slot yields no row and the caller simply does not receive that guarantee this tick. Both arguments are clamped in SQL (limit 1–50, lease 30–900 seconds) rather than trusted from the caller.
- `complete_monitor_run(..., p_settlement_pending)` either advances the schedule or leaves the exact slot immediately reclaimable for settlement retry. The token fences a zombie worker: if its lease expired and another worker took over, its token no longer matches and the call becomes a no-op instead of corrupting the schedule.

`next_check_at` advances from the scheduled slot rather than from `now()`, so a slow run does not drift the cadence, and is clamped forward to at least `now()` so a long backlog cannot produce a tight retry loop.

A crashed invocation therefore does not strand a guarantee: the lease expires and the next run reclaims it. `scheduled_for` is part of the observation's identity, which makes a retry idempotent rather than duplicative.

`RUN_BUDGET_MS` is below the platform invocation limit so the function returns deliberately rather than being killed mid-write.

## Chain indexing

```text
LOG_CHUNK              1_000 blocks per getLogs call
MAX_BLOCKS_PER_RUN     5_000 blocks per invocation
DEFAULT_CONFIRMATIONS  8
REORG_OVERLAP          12 blocks
RUN_BUDGET_MS          50_000
CHAIN_ID               84532
```

`sync-chain` starts from the recorded deployment block, never from genesis, and advances a persisted cursor through `advance_chain_cursor`. The cursor is monotonic — it moves forward via `greatest(...)`, so a retried or out-of-order invocation cannot rewind the read model.

Only blocks at least `DEFAULT_CONFIRMATIONS` deep are treated as safe. Each run re-scans `REORG_OVERLAP` blocks behind the cursor. Every event-derived row stores block number/hash, transaction/log identity and a canonical-presence flag; reprocessing marks orphaned chain projections invalid while preserving monitor-owned HTTP evidence. Contract state is read at the safe block where the RPC supports historical reads, and a failed chunk is never advanced past.

`MAX_BLOCKS_PER_RUN` bounds a cold start: catching up a long gap takes several invocations and cannot produce one unbounded run.

## Evidence

Each probe records HTTP status, completed bounded-response latency (headers plus body read), a digest of the bounded response body, an error code and `observed_at` set when that measurement completes. The database calls the digest `body_keccak256`; it is not SHA-256.

The commitment is `keccak256(abi.encode(...))`, not a JSON or line-oriented digest, so the value can be recomputed inside the EVM by whoever wants to check it. Two domain separators namespace the two hashes:

```text
OBSERVATION_DOMAIN  keccak256("uptimesure.observation.v1")
EVIDENCE_DOMAIN     keccak256("uptimesure.evidence.v1")
```

Variable-length fields are folded through `keccak256` into fixed-width slots before encoding, so no two distinct field sets can be made to collide by shifting bytes across a boundary. The raw response body is never stored — only its digest.

## Observation lifecycle

A stored observation carries one of seven chain statuses:

```text
pending         evidence recorded, chain submission not yet attempted
submitted       transaction sent, receipt not yet seen
confirmed       receipt observed by the monitor
indexed         the settled observation was re-read from chain logs
failed          submission attempted and rejected
not_required    healthy steady state, deliberately never submitted
unmonitorable   the target was refused by policy and never probed
```

`not_required` is the common case. A healthy check does not need a transaction, so steady state costs no gas; chain writes are reserved for failures and for the first healthy check after a failure, which is what resets onchain state.

`unmonitorable` exists because a policy refusal is not an outage. Such a row is stored with `healthy = false` (the column is not nullable and a constraint ties the two together), so the frontend renders it as **Refused**, never as a failure. Reporting a refused target as downtime would tell a provider their service broke when it was never probed at all.

Settlement retry states are durable: `pending` means evidence exists but no broadcast is known, `submitted` means a transaction hash is known and receipt lookup is pending, and `failed` means the attempt can be retried unless the stored chain error is a definitive revert. The same observation id, timestamp, verdict, status, latency, body digest, reason and evidence hash are reused.

## Funding model

A guarantee cannot be created unless `coverageAmount >= payoutPerIncident * maxPayouts`. The contract rejects an underfunded promise rather than accepting a guarantee it could not honour.

The monitor can never choose a recipient. Every breach payout is sent by the contract to the beneficiary fixed at creation.
