# Proof procedure

The proof bar for this repository is deliberately strict: source code, passing tests and a green-looking local UI are not enough. A Hardhat test proving the settlement logic is not a demonstration that the product works — it exercises the contract against a simulated chain, a simulated clock and no real HTTP request. The two are separate claims and this file keeps them separate.

**Nothing below has been run against a live deployment.** `deployments/base-sepolia.json` is `awaiting-deployment`, so there is no contract address, no guarantee, no incident and no payout to point at. This is the procedure to produce that evidence, not a record of it.

## What counts as V1 proof

The canonical demo is the Base Sepolia path, because that is what the product is. It requires all of the following to be real and independently checkable on a block explorer:

```text
1  contract deployed to Base Sepolia, verified by reading it back over RPC
2  test-USDC approval transaction from the provider wallet
3  createGuarantee transaction, and the guarantee ID it actually returned
4  the guarantee appearing in Supabase because sync-chain indexed it
5  a real outbound HTTPS probe recorded with its evidence hash
6  consecutive failures reaching the configured threshold
7  the minimum outage duration elapsing
8  an incident confirmed onchain
9  a test-USDC transfer to the beneficiary, and the balance change
10 endpoint recovery, and the observation that resets onchain state
11 the frontend rendering 3-10 from real data, with no fallback values
```

Steps 5 through 10 cannot be faked into existence by editing Postgres: the contract is authoritative for incident and payout state, and the read model is rebuilt from logs.

## Running it

Deploy and verify the contract:

```bash
cd contracts
npm run deploy:base-sepolia
npm run verify:deployment
```

`verify:deployment` treats `deployments/base-sepolia.json` as a pointer only. It re-reads the live contract and asserts bytecode is present, `coverageToken` is Circle test USDC, the monitor holds `MONITOR_ROLE`, the deployer does not, `nextGuaranteeId` is initialised, the declared interface is callable and the contract is not paused.

Then configure Supabase per `supabase/README.md` — migrations, both Edge Functions, the Function secrets, and `cron.sql`, which schedules `sync-chain` and `monitor-due` once per minute each.

Create the guarantee through the UI at `/create` rather than a script. Doing it through the wallet flow is part of what is being demonstrated: approval, network switch, validation, the transaction, and the guarantee ID read back from the receipt.

## Demonstrating a breach

Point a second guarantee at an endpoint **you control** — a paused Vercel deployment, a route that returns 503 on demand, or a host you own that you can stop. Do not point a failure test at a third-party service; the monitor makes repeated automated requests on a fixed cadence, and aiming that at infrastructure you have no authority over is an attack, not a test.

Set the threshold and minimum outage low enough to observe inside a session while staying above the contract minimums (`MIN_CHECK_INTERVAL` is 60 seconds), fund the provider wallet with faucet ETH for monitor gas, then take the endpoint down and let the schedule run. Healthy checks are deliberately not submitted onchain, so the first transactions you should expect are the failure observations.

Bring the endpoint back up afterwards. The first healthy observation after a failure *is* submitted, because that is what resets onchain state, and recovery is part of the proof rather than an afterthought.

Capture every transaction hash as you go. A screenshot of the UI is not evidence on its own — the explorer links are.

## Rialo DevNet demo (experimental, not V1)

This section documents the earlier Rialo-native prototype under `program/`. It is retained as a migration path and is **not** the product being shipped. Its async execution path was never proven: Venus program and REX components deployed to DevNet and root transactions were accepted, but child workflow/REX callback lineage stayed at a single node throughout validation. Treat any run of the commands below as an experiment whose central question is still open.

```bash
rialo config network switch devnet
rialo client airdrop --amount 1
cargo build --manifest-path program/artifact/Cargo.toml
rialo client program deploy-venus program
rialo client program invoke <PROGRAM_ID> --program-dir program --function create_guarantee ...
rialo client get-workflow-lineage <CREATE_TX_SIGNATURE> --full-id true
```

The lineage command is the one that matters. A demo of this path is only meaningful if it shows at least two automatic timer/REX callbacks and lineage extending past the root node. Until it does, the honest description is a deployed program with unproven asynchronous continuation — not a working Rialo integration.

On Windows, do not install WSL just for this repository. The Rialo workflows run the Linux-only toolchain steps on Ubuntu runners, and V1 development needs none of it.
