# UptimeSure

> **Put money behind your uptime promise.**

UptimeSure is an executable service-guarantee product for APIs, RPCs, webhooks and online infrastructure. A provider fully funds a maximum liability in Circle test USDC on Base Sepolia. Supabase Cron checks the real HTTPS service through Edge Functions. Deterministic failures are committed onchain. When the configured threshold and outage duration are satisfied, the contract compensates the fixed beneficiary automatically.

There is no AI in the payout path and no mock monitoring data.

## Product stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 15 + React 19 on Vercel |
| Settlement | Solidity on Base Sepolia |
| Coverage asset | Circle Base Sepolia test USDC |
| Database / read model | Supabase Postgres |
| Scheduler | Supabase Cron / pg_cron |
| Monitoring | Supabase Edge Functions |
| Chain reads/writes | viem |
| Future adapter | Rialo Venus + REX prototype retained in repo |

Testnet USDC has no financial value.

## Core flow

```text
Provider creates terms
  -> approves and fully escrows test USDC
  -> Supabase sync indexes the onchain guarantee
  -> Cron selects it when due
  -> Edge Function performs a real bounded HTTPS probe
  -> evidence is hashed and stored
  -> restricted MONITOR_ROLE submits the observation
  -> contract applies spacing + failure + outage rules
  -> breach creates an incident and pays the fixed beneficiary
  -> healthy observation records recovery
```

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

The contract rejects underfunded promises. Coverage must be at least `payoutPerIncident * maxPayouts` at creation.

## Supabase

`supabase/` contains:

- SQL schema, RLS and indexes
- Cron setup using pg_cron + pg_net + Vault
- `monitor-due` Edge Function
- `sync-chain` Edge Function

Supabase is not the source of truth for funds. It stores monitoring evidence and a fast public read model of Base Sepolia state.

## Frontend

The root Next.js app provides:

- marketing/product landing page
- public guarantee registry
- provider/beneficiary wallet dashboard
- real onchain guarantee creation flow
- USDC approval flow
- guarantee detail page
- monitoring observations and evidence hashes
- incident and compensation history
- BaseScan links

When Supabase or the contract address is not configured, the UI fails visibly instead of rendering fake data.

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

Deployment requires a funded Base Sepolia deployer and optionally a separate `MONITOR_ADDRESS`. The script writes real deployment evidence to `deployments/base-sepolia.json`. The repository intentionally ships that file as `awaiting-deployment` until a real transaction succeeds.

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

Then apply `supabase/cron.sql` with the project URL, publishable key and matching cron secret stored in Vault.

## Verification

GitHub Actions `product-verify` checks three independent surfaces:

```text
web:            tests -> typecheck -> production build
contracts:      compile -> Hardhat tests
edge-functions: Deno typecheck for monitor + chain sync
```

No deployment or payout is claimed until there is real testnet evidence.

## Rialo

The earlier Rialo-native prototype remains in `program/` and `web/`. It successfully reached real DevNet program/REX deployment, but reliable asynchronous callback lineage was not proven. UptimeSure V1 therefore uses infrastructure available today while keeping a direct migration path to Rialo Workflow + REX.

See `docs/RIALO_MIGRATION.md`.

## Security

Read `docs/SECURITY.md` before deploying. This is a testnet release, not an audited mainnet financial product.
