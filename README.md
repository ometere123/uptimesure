# UptimeSure

**Executable service guarantees on Rialo.**

UptimeSure turns an API uptime promise into a running workflow. A provider defines a public HTTPS endpoint, a repeated-failure threshold, a beneficiary, and a capped compensation amount. Rialo schedules checks; REX/TEE nodes perform the real HTTP observations; the Venus program confirms incidents; and a confirmed breach can transfer provider-funded DevNet RLO automatically.

No custom backend, database, keeper, cron service, or oracle is required.

## What is implemented

- Rialo Venus workflow with persistent SLA state and owner controls.
- Native recurring `AFTER` scheduling with drift/backlog protection.
- REX WASM component that performs real HTTPS GET probes inside the TEE execution surface.
- Strict-majority/fail-closed reduction of REX report outputs.
- Consecutive-failure breach policy, recovery tracking, duplicate-payout prevention and payout caps.
- Native Rialo DevNet RLO compensation using the same system-transfer pattern demonstrated by Rialo's public REX pipeline example.
- Payout failure isolation: an empty provider payer records a failed settlement without killing monitoring.
- HTTPS/private-host input guardrails and bounded policy inputs.
- React/Vite product UI with Rialo Frost wallet connection, live DevNet block height/balance and deployment-proof gating.
- Ubuntu GitHub Actions for the Rialo Linux toolchain, so editing can remain native Windows/VS Code without WSL.
- Separate verification, real DevNet deployment-proof and manual real guarantee-launch workflows.

## Architecture

```text
Static Vercel UI
      |
      v
Rialo DevNet Venus workflow
      |
      +---- timer ----> REX / TEE ---- HTTPS ----> service endpoint
      |                    |
      |<---- report -------+
      |
      +---- repeated-failure policy
      |
      +---- confirmed breach ----> capped native RLO transfer ----> beneficiary
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/SECURITY.md`](docs/SECURITY.md), and [`docs/DEMO.md`](docs/DEMO.md).

## Windows-first development

The frontend and source editing work normally in VS Code on Windows. The repository's GitHub Actions Ubuntu runner installs `rialoman`, pins the Rialo `0.10.1` toolchain, builds the PolkaVM artifact/REX component, and deploys to Rialo DevNet. No WSL or macOS is required for that path.

Frontend locally:

```powershell
cd web
npm install
npm run dev
```

The stock-Rust program type check can run anywhere the published crates support:

```bash
cargo check --manifest-path program/Cargo.toml
```

The deployable artifact is built in CI with:

```bash
cargo build --manifest-path program/artifact/Cargo.toml
```

## Real DevNet proof

`.github/workflows/devnet-proof.yml` deliberately starts with a fresh DevNet-only key, faucet funds it, builds the actual deployable program, calls `rialo client program deploy-venus`, and uploads the deployment log plus generated Venus interface files. `deployment/devnet.json` and `web/public/deployment.json` stay null until a successful deployment gives us evidence worth publishing.

To create a real workflow after deployment, use the GitHub **create-devnet-guarantee** action or the generated CLI launch packet in the frontend. The repository does not substitute mocked agreement state for a network transaction.

## Settlement caveat

The current settlement rail is native **DevNet RLO from the workflow payer**. This is a provider-funded automatic guarantee demo; it is **not** a stablecoin escrow, insurance product, or production custody system. A future production escrow adapter should be separately designed and audited rather than represented here as if it already exists.

## License

MIT
