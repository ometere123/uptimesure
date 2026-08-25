# UptimeSure

> **Put money behind your uptime promise.**

UptimeSure is an executable service-guarantee product for APIs, RPCs, webhooks and online infrastructure. A provider fully funds its maximum promised liability in Circle test USDC on Base Sepolia. Supabase Cron checks the real HTTPS service through Edge Functions. Deterministic breach state is committed onchain. When the configured failure threshold and minimum outage duration are satisfied, the contract compensates the fixed beneficiary automatically.

There is no AI in the payout path and no mock monitoring data.

## Current status

**The contract is not deployed.** `deployments/base-sepolia.json` ships as `awaiting-deployment` with every address and transaction field `null`, and it stays that way until a real transaction succeeds. There is no Supabase project, no indexed guarantee and no end-to-end payout proof in this repository yet, because deployment requires a funded Base Sepolia deployer key and a Supabase access token that are not available to the build.

The frontend *is* live, at **https://uptimesure.vercel.app** — but it is live in the only honest sense available without a deployment: every page reports the missing contract and missing read model as missing. `/status` shows the settlement contract as `Awaiting deployment`, `/guarantees` and `/dashboard` render empty states labelled `NO PLACEHOLDER DATA`, and `/create` refuses to build a transaction. The one live dependency it does exercise is the Base Sepolia RPC, which the status page reads on load and reports as `Healthy` from a real `eth_chainId` call. Nothing on that site is seeded, mocked or hard-coded green.

What *is* verified is the code: the frontend, the settlement contract, the monitoring functions and the database schema all pass the canonical `product-verify` gate. Treat this README as describing a code-complete product awaiting deployment, not a running service. `docs/DEMO.md` is the procedure for producing the missing testnet evidence and the definition of what would count as proof.

## Product stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16 + React 19 on Vercel |
| Settlement | Solidity 0.8.28 on Base Sepolia (chainId 84532) |
| Coverage asset | Circle Base Sepolia test USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals) |
| Database / public read model | Supabase Postgres |
| Scheduler | Supabase Cron / pg_cron |
| Monitoring | Supabase Edge Functions (Deno) |
| Chain reads/writes | viem |
| Future adapter | Rialo Venus + REX prototype retained in repo |

The V1 architecture deliberately starts on free-account-friendly infrastructure. Testnet USDC has no financial value.

## Core flow

```text
Provider creates public SLA terms
  -> approves and fully escrows test USDC
  -> Supabase sync indexes the onchain guarantee
  -> Cron claims the guarantee when due (atomic lease, not a bare timestamp query)
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

A new guarantee specifies: beneficiary, HTTPS endpoint, expected HTTP status, optional expected body fragment, maximum latency, check interval, consecutive-failure threshold, minimum outage duration, payout per confirmed incident, maximum payout count, expiry, and fully funded coverage.

Enforced bounds:

```text
MIN_CHECK_INTERVAL     60 seconds
MAX_CHECK_INTERVAL     86_400 seconds
MAX_LATENCY_MS         30_000
MAX_TERM               366 days
MAX_OBSERVATION_AGE    10 minutes
FUTURE_TOLERANCE       30 seconds
SETTLEMENT_WINDOW      30 minutes
```

The contract rejects an underfunded promise: coverage must be at least `payoutPerIncident * maxPayouts` at creation. Observation IDs cannot be replayed (the guard is namespaced per guarantee), observations must be fresh and correctly spaced, and one unresolved incident cannot pay twice.

`SETTLEMENT_WINDOW` is why a provider cannot reclaim coverage the moment a guarantee expires. An outage that began inside the covered term may still be settling, so `withdrawExpired` requires `block.timestamp > expiresAt + SETTLEMENT_WINDOW`.

## Supabase

`supabase/` contains the Postgres schema, indexes and RLS; the public guarantee/observation/incident read models; Cron setup using pg_cron + pg_net + Vault; the `monitor-due` Edge Function for real HTTPS probes and bounded chain submissions; and the `sync-chain` Edge Function for event indexing.

Supabase is not the source of truth for funds. Deleting or modifying an indexed row cannot move coverage. Base Sepolia contract state remains authoritative for beneficiary, liability, incident and payout rules.

The monitor runs once per minute and processes at most 10 due guarantees per invocation, 5 concurrently. Guarantees are claimed through an atomic lease (`claim_due_guarantees` / `complete_monitor_run`) rather than a bare `next_check_at <= now()` select, so two overlapping invocations cannot both submit an observation for the same scheduled slot, and a crashed run is reclaimed after its lease expires instead of stalling.

Normal healthy observations are evidence-only; chain writes are reserved for failures and recovery resets.

## Frontend

The root Next.js app provides the product landing page, the public guarantee registry, a provider/beneficiary wallet dashboard, the real onchain guarantee creation flow with test-USDC approval, the guarantee detail/proof page with monitoring observations and evidence hashes, incident and compensation history, provider controls for topping up and reclaiming coverage, a live public system-status page, and BaseScan links.

The detail page reads the contract and the index independently. If they disagree it renders the divergence and marks the contract authoritative, rather than presenting a lagging indexer as a change in financial state. When Supabase or the contract address is not configured, the UI names the missing dependency instead of rendering fake success data.

## Local setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Frontend variables — these five, and only these five, reach the browser:

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_UPTIMESURE_CONTRACT=
NEXT_PUBLIC_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
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
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

Use a testnet-only deployer. `MONITOR_ADDRESS` is mandatory and must be a different low-value wallet: the constructor reverts if the monitor equals the deployer, and the script refuses to run otherwise. The constructor grants `DEFAULT_ADMIN_ROLE` to the deployer and `MONITOR_ROLE` to the monitor address only — the deployer never holds `MONITOR_ROLE`, so no grant or renounce transaction is involved. After deploying, the script asserts onchain that the monitor holds the role and the deployer does not, and fails the deployment if either check does not hold.

The monitor wallet should hold only faucet ETH for testnet gas and must never custody guarantee USDC.

A successful deployment writes real evidence to `deployments/base-sepolia.json`: contract address, deployment transaction, block, deployer, monitor address, monitor role hash, source commit and timestamp. `npm run verify:deployment` then re-reads the live contract over RPC and treats that file only as a pointer, checking that the coverage token is Circle test USDC, that the roles are held by the expected addresses and that the deployed bytecode and interface respond.

## Supabase deployment

See `supabase/README.md`. Configure these Function secrets after contract deployment:

```text
CRON_SECRET
BASE_SEPOLIA_RPC_URL
UPTIMESURE_CONTRACT_ADDRESS
UPTIMESURE_DEPLOY_BLOCK
MONITOR_PRIVATE_KEY
```

`MONITOR_PRIVATE_KEY` must correspond to the granted `MONITOR_ADDRESS`. `CRON_SECRET` must be at least 24 characters — the functions refuse to run with a shorter one rather than accept a brute-forceable credential on a public endpoint. Then apply `supabase/cron.sql` with the project URL, publishable key and matching cron secret stored in Vault.

## Verification

GitHub Actions `product-verify` is the canonical release gate for every PR and push to `main`:

```text
web:              npm ci -> tests -> typecheck -> production build
contracts:        npm ci -> compile -> typecheck -> Hardhat tests
edge-functions:   deno check (monitor, sync, shared) -> deno test
committed-secrets: full-history blob scan for keys, mnemonics and provider tokens
database-schema:  migrations applied twice for idempotency -> schema assertions
```

The same matrix runs locally:

```bash
bash scripts/verify-all.sh
```

The `database-schema` job creates the Supabase-managed `anon`/`authenticated`/`service_role` roles, shims the Supabase-only extensions, applies every migration **twice** to prove idempotency, then asserts the schema invariants. `scripts/verify-all.sh` mirrors it against a local Postgres via `scripts/verify-schema.sh`, and skips that one step — reporting the skip — when no local server is installed. CI pins `postgres:15` and is authoritative.

The `committed-secrets` job runs `scripts/scan-history-secrets.py` over every blob in the repository's history, including blobs no ref points to, and exits non-zero on any match. It checks out with `fetch-depth: 0` because the default shallow checkout would scan one commit and pass; the script refuses to run on a shallow clone rather than report a clean result it did not earn. See `docs/SECURITY.md` for how that guarantee was tested.

The Rialo workflows are retained as `workflow_dispatch`-only experimental workflows and do not gate V1.

### Guarded constants

The Base Sepolia coverage-token address is asserted in both suites, in `lib/config.test.ts` and `contracts/test/deployment-constants.test.ts`. This is a regression guard, not a formality: the address shipped for several commits as `…8f3dCF7c` instead of Circle's published `…8f3dCF7e`. One wrong nibble is an address with **no contract** on Base Sepolia, so every `approve`/`transferFrom` against it would have reverted. It survived review because a 40-character hex string reads as correct at a glance, and it was never exercised — nothing had yet been deployed to a real chain.

Two checks now catch that class of mistake without needing to know the right answer or reach the network: EIP-55 encodes a keccak checksum in the letter casing, so any altered nibble makes the address fail strict validation; and the committed `deployments/base-sepolia.json` is asserted to carry real evidence for every field whenever its `status` is `deployed`, which makes fabricated deployment evidence a failing test rather than a plausible-looking file.

## Dependency posture

The frontend and Edge Functions report zero known vulnerabilities. `contracts/` still reports advisories inside the Hardhat 2 developer toolchain; they are documented rather than silenced, because that package produces no runtime artifact and clearing them requires a semver-major Hardhat 3 migration that would risk the test suite proving the settlement contract safe. See `docs/SECURITY.md` for the full position and the two scoped overrides that were applied.

## Rialo migration

The earlier Rialo-native prototype remains in `program/` and `web/`. It reached real DevNet Venus-program and REX-component deployment, and root transactions were accepted — but reliable asynchronous child callback lineage was **never proven**, so no claim of a working Rialo runtime integration is made here.

The program does now compile, CI-verified by a real `cargo check` in `rialo-experimental-verify` rather than asserted. That is a statement about type-checking against `rialo-*` 0.10.x and nothing more: the run executes no code and reaches no network, so the unproven async callback path is exactly as unproven as before. See `docs/RIALO_MIGRATION.md` for the two DSL-grammar defects that had to be fixed to get there.

UptimeSure V1 therefore uses infrastructure available today while keeping a direct migration path:

```text
Supabase Cron        -> Rialo Workflow
Supabase Edge probe  -> Rialo REX / external-data execution
Base contract        -> Venus state or retained EVM settlement
Vercel product UI    -> same product surface
```

See `docs/RIALO_MIGRATION.md`.

## Security

Read `docs/SECURITY.md` before deploying. It records the accepted trust assumptions — a single monitor that can withhold observations, and a residual DNS-rebinding window that cannot be closed with the portable Fetch API — rather than implying they are solved.

This is an unaudited testnet release, not a mainnet financial or insurance product.
