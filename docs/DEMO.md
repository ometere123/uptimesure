# Real DevNet demo

The proof bar for this repository is deliberately strict: source code and green local-looking UI are not enough.

A complete demo should show a successful Ubuntu CI artifact build, a real Rialo DevNet program deployment, a `create_guarantee` transaction against a public HTTPS endpoint, the workflow lineage, at least two automatic timer/REX callbacks, and the resulting workflow state. For payout proof, point a separate guarantee at a deliberately failing public test endpoint, keep the provider payer funded with faucet RLO, wait for the configured consecutive-failure threshold, then show the beneficiary balance/transaction evidence.

The canonical commands are the official Rialo CLI path:

```bash
rialo config network switch devnet
rialo client airdrop --amount 1
cargo build --manifest-path program/artifact/Cargo.toml
rialo client program deploy-venus program
rialo client program invoke <PROGRAM_ID> --program-dir program --function create_guarantee ...
rialo client get-workflow-lineage <CREATE_TX_SIGNATURE> --full-id true
```

On Windows, do not install WSL just for this repository. The GitHub Actions workflows run the Linux-only toolchain steps on Ubuntu; development and frontend work can stay in VS Code on Windows.
