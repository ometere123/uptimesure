# UptimeSure V1 Architecture

UptimeSure is an executable service-guarantee product. Providers fully fund a maximum liability in Circle test USDC on Base Sepolia. Supabase performs deterministic HTTPS checks on a schedule and a restricted monitor key submits bounded observations. The Solidity contract remains authoritative for coverage, thresholds, incidents and payouts.

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

## Authority boundaries

**Base Sepolia contract**

- provider and beneficiary
- endpoint and deterministic monitoring terms
- fully funded coverage
- payout per incident and maximum payout count
- observation replay/spacing/freshness guards
- consecutive-failure and minimum-outage state
- incident confirmation/recovery
- remaining coverage and automatic beneficiary payout

**Supabase Edge Functions**

- perform real HTTPS GET requests
- cap timeout and response bytes
- verify expected status/body fragment/latency
- calculate evidence hash
- submit an observation using a key that has only `MONITOR_ROLE`
- index contract state into public read tables

**Supabase Postgres**

Postgres is a read model and evidence store. It is not authoritative for funds. Deleting a row does not alter coverage or contract state.

**Vercel**

Hosts the frontend only. There is no long-running server and no Railway/Cloudflare dependency.

## Monitoring cadence

V1 requires `checkIntervalSecs >= 60`. One Supabase Cron job calls `monitor-due` each minute. The function selects only rows whose `next_check_at <= now()` and processes at most 20 per invocation in groups of five.

This deliberately fits an early free-tier product rather than pretending to support unlimited sub-second monitoring.

## Evidence

Each probe records HTTP status, latency, bounded response SHA-256, error code and observed time. A keccak256 commitment of these fields becomes the `evidenceHash` submitted onchain. The raw bounded body is not stored.

## Funding model

A guarantee cannot be created unless `coverageAmount >= payoutPerIncident * maxPayouts`. The monitor can never choose a recipient. Every breach payout is sent by the contract to the beneficiary fixed at creation.
