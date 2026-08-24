# Security model

UptimeSure is a DevNet implementation. Do not use it to promise production compensation or to hold production secrets/funds.

## Endpoint safety

The program accepts HTTPS only, caps URL/body-fragment input lengths, and rejects obvious loopback, link-local and RFC1918-style literal hosts. This is defense-in-depth, not a complete SSRF boundary: DNS rebinding and resolver-level policy need enforcement at the REX egress layer for a production deployment.

## Breach safety

One failed request cannot pay a claim. The minimum failure threshold is two consecutive observations and is configurable up to 20. REX output is reduced fail-closed: only a strict healthy majority is healthy. One open incident can be paid at most once; total successful payouts are capped at creation time.

## Payer-funding limitation

Native DevNet RLO is transferred from the workflow payer using Rialo's system program pattern. If that account lacks funds, the program records `BREACH_PAYOUT_FAILED` and continues monitoring instead of reverting the whole health callback. The owner may fund the account and call `retry_current_payout` while the incident remains open.

This is not a cryptographic escrow. A production bond/escrow adapter is separate work and must be audited before financial use.

## Keys and CI

The deployment workflow creates a fresh DevNet-only keypair and uses faucet RLO. Never put a mainnet key, production mnemonic, API secret, or real private credential in repository files, workflow inputs, or plain Rialo transaction arguments.
