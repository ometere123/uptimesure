# UptimeSure

> **Put money behind your uptime promise.**

UptimeSure is an executable service-guarantee product for APIs, RPCs, webhooks and online infrastructure. A provider fully funds its maximum promised liability in Circle test USDC on Base Sepolia. Supabase Cron checks the real HTTPS service through Edge Functions. Deterministic breach state is committed onchain. When the configured failure threshold and minimum outage duration are satisfied, the contract compensates the fixed beneficiary automatically.

There is no AI in the payout path and no mock monitoring data.

## Product stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 15 + React 19 on Vercel |
| Settlement | Solidity on Base Sepolia |
| Coverage asset | Circle Base Sepolia test USDC |
| Database / public read model | Supabase Postgres |
| Scheduler | Supabase Cron / pg_cron |
| Monitoring | Supabase Edge Functions |
| Chain reads/writes | viem |
| Future adapter | Rialo Venus + REX prototype retained in repo |

The V1 architecture deliberately starts on free-account-friendly infrastructure. Testnet USDC has no financial value.

## Core flow

```text
Provider creates public SLA terms
  -> approves and fully escrows test USDC
  -> Supabase sync indexes the onchain guarantee
  -> Cron selects the guarantee when due
  -> monitor-due performs a real bounded HTTPS probe
  -> probe evidence is hashed and stored in Postgres
  -> steady-state healthy checks stay offchain to avoid unnecessary gas
  -> failures are submitted by the restricted MONITOR_ROLE
  -> the first healthy check after a failure is submitted to reset/recover state
  -> contract applies freshness + spacing + consecutive-failure + outage rules
  -> confirmed breach creates an incident and pays the fixed beneficiary
```

This keeps the financial state deterministic without spending a Base Sepolia transaction for every successful one-minute health check.

## Contract guarantees

`contracts/contracts/UptimeSureCore.sol` enforces the financial and lifecycle rules. The monitoring signer cannot choose recipients or payout amounts.

A new guarantee specifies:

- beneficiary
- HTTPS endpoint
- expected HTTP status
- optional expected body fragment
- maximum latency
- check interval
- consecutive-failure threshold
- minimum outage duration
- payout per confirmed incident
- maximum payout count
- expiry
- fully funded coverage

The contract rejects an underfunded promise. Coverage must be at least `payoutPerIncident * maxPayouts` at creation. Observation IDs cannot be replayed, observations must be fresh and correctly spaced, and one unresolved incident cannot pay twice.

## Supabase

`supabase/` contains:

- Postgres schema, indexes and RLS
- public guarantee / observation / incident read models
- Cron setup using pg_cron + pg_net + Vault
- `monitor-due` Edge Function for real HTTPS probes and bounded chain submissions
- `sync-chain` Edge Function for contract event indexing and canonical-state refresh

Supabase is not the source of truth for funds. Deleting or modifying an indexed row cannot move coverage. Base Sepolia contract state remains authoritative for beneficiary, liability, incident and payout rules.

The monitor runs once per minute and processes at most ten due guarantees per invocation in batches of five. Normal healthy observations are evidence-only; chain writes are reserved for failures and recovery resets. That design keeps the early testnet release practical on free tiers and with faucet-funded gas.

## Frontend

The root Next.js app provides:

- product landing page
- public guarantee registry
- provider/beneficiary wallet dashboard
- real onchain guarantee creation flow
- test-USDC approval flow
- guarantee detail / proof page
- monitoring observations and evidence hashes
- incident and compensation history
- live public system-status page
- BaseScan links

When Supabase or the contract address is not configured, the UI shows the missing dependency instead of rendering fake success data.

## Local setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Frontend variables:

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_UPTIMESURE_CONTRACT=
NEXT_PUBLIC_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7c
```

## Contracts

```bash
cd contracts
cp .env.example .env
npm install
npm run compile
npm test
npm run deploy:base-sepolia
```

A Base Sepolia deployment requires:

```text
BASE_SEPOLIA_RPC_URL
DEPLOYER_PRIVATE_KEY
MONITOR_ADDRESS
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7c
```

`MONITOR_ADDRESS` is mandatory and must be a different low-value wallet from the deployer/admin. The deploy script grants that wallet `MONITOR_ROLE` and renounces the deployer's constructor-granted monitor role. The monitor wallet should hold only faucet ETH for testnet gas and must not custody guarantee USDC.

A successful deployment writes real evidence to `deployments/base-sepolia.json`, including the contract address, deployment transaction, block, monitor grant transaction and deployer monitor-role renunciation transaction. The repository intentionally ships that file as `awaiting-deployment` until a real transaction succeeds.

## Supabase deployment

See `supabase/README.md`.

At minimum configure these Function secrets after contract deployment:

```text
CRON_SECRET
BASE_SEPOLIA_RPC_URL
UPTIMESURE_CONTRACT_ADDRESS
UPTIMESURE_DEPLOY_BLOCK
MONITOR_PRIVATE_KEY
```

`MONITOR_PRIVATE_KEY` must correspond to the `MONITOR_ADDRESS` granted by the deployment script. Then apply `supabase/cron.sql` with the project URL, publishable key and matching cron secret stored in Vault.

## Verification

GitHub Actions `product-verify` is the canonical release gate and checks three independent surfaces on every PR and product-branch/main push:

```text
web:            tests -> typecheck -> production build
contracts:      compile -> Hardhat tests
edge-functions: Deno typecheck for monitor + chain sync
```

The earlier Rialo workflow is retained as a manual experimental workflow and no longer gates V1.

No Base Sepolia deployment, Supabase runtime execution, payout or public live-app claim is made until there is real evidence.

## Rialo migration

The earlier Rialo-native prototype remains in `program/` and `web/`. It successfully reached real DevNet Venus-program and REX-component deployment, but reliable asynchronous child callback lineage was not proven. UptimeSure V1 therefore uses infrastructure available today while keeping a direct migration path:

```text
Supabase Cron        -> Rialo Workflow
Supabase Edge probe  -> Rialo REX / external-data execution
Base contract        -> Venus state or retained EVM settlement
Vercel product UI    -> same product surface
```

See `docs/RIALO_MIGRATION.md`.

## Security

Read `docs/SECURITY.md` before deploying. This is a testnet release, not an audited mainnet financial or insurance product.
