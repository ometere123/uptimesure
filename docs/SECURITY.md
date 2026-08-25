# Security Model

UptimeSure V1 is a testnet product. It is not an audited mainnet insurance system, and nothing in this repository has been reviewed by a third-party auditor.

This document records what the code actually enforces and what it does not. Where a risk is accepted rather than solved, it is named as accepted.

## Bounded monitor authority

The Supabase monitor key holds only `MONITOR_ROLE`. It cannot change a beneficiary, withdraw provider coverage, change payout size, change the maximum payout count, or transfer arbitrary tokens. The beneficiary is fixed at creation and every payout is sent by the contract to that address, so there is no code path by which a monitor redirects compensation to itself.

The constructor requires `monitor != msg.sender` and grants `DEFAULT_ADMIN_ROLE` to the deployer and `MONITOR_ROLE` to the monitor address only. The deployer is therefore never granted `MONITOR_ROLE` at any point, so there is no grant or renounce transaction to get wrong — the separation is structural. The deploy script refuses to run when `MONITOR_ADDRESS` equals the deployer, and after deployment asserts both that the monitor holds the role and that the deployer does not, failing the deployment if either check does not hold.

**Accepted risks.** Two remain, and V1 states them rather than hiding them:

- A compromised monitor can submit *false failure* observations. Because it cannot choose the recipient, the worst outcome is premature payment to the already-fixed beneficiary — a loss to the provider, not theft by the monitor.
- A monitor can *withhold* observations. A real outage that is never reported is never compensated. There is one monitor in V1, so availability of the monitoring path is trusted. Independent monitors with a quorum are required before real value.

## Contract safeguards

- full maximum liability is escrowed before activation; `coverageAmount >= payoutPerIncident * maxPayouts` is enforced at creation
- HTTPS endpoint required
- observation IDs are single-use; the replay guard is keyed `keccak256(abi.encode(guaranteeId, observationId))`, so the namespace is per-guarantee and one guarantee's IDs cannot be used against another
- observations must be fresh (`MAX_OBSERVATION_AGE` 10 minutes) and not dated ahead (`FUTURE_TOLERANCE` 30 seconds)
- observations must be correctly spaced; rapid resubmission is rejected
- failures must be consecutive, and the counter saturates rather than overflowing
- the minimum outage duration must elapse before an incident is confirmed
- only one incident may be open at a time, and an unresolved outage cannot double-pay
- total payouts cannot exceed the configured count or the remaining coverage
- expired coverage returns only to the provider, and only after `expiresAt + SETTLEMENT_WINDOW` (30 minutes), so an outage still settling at expiry cannot be escaped by an early withdrawal
- a coverage token that delivers less than requested, or that fails silently, produces a revert rather than a lost payout
- re-entry from inside a coverage-token transfer is blocked
- emergency pause is admin-only and halts observation processing
- SafeERC20 and ReentrancyGuard protect every token movement path

The 36 tests in `contracts/test/UptimeSureCore.test.ts` cover these paths, including the boundary cases: maximum representable payout and coverage without overflow, counter saturation, settlement inside the post-expiry window, withdrawal blocked while settlement is open, and re-entrancy from a malicious token. A further 6 in `contracts/test/deployment-constants.test.ts` guard the deployment constants, for 42 in the Hardhat suite.

## Endpoint safeguards (SSRF)

`monitor-due` probes attacker-chosen URLs — the endpoint is supplied by whoever creates a guarantee — so the target validator is a security boundary, not a convenience check. Validation runs in two stages and every rejection carries a stable code.

**URL shape.** Requires `https:`; rejects embedded credentials; allows only ports `443`/`8443` (empty meaning default); rejects a missing host, single-label hostnames, blocked hostnames, and internal suffixes including `.localhost`, `.internal`, `.local` and `.arpa`.

Host classification runs against the **raw** host as written, before WHATWG URL canonicalization, because the URL parser silently rewrites several private-address spellings into forms a naive check would pass — `2130706433`, `010.010.010.010`, and `127.0.0.0x1` all denote loopback. Private and reserved ranges are rejected for both IPv4 and IPv6: loopback, `10/8`, `172.16/12`, `192.168/16`, link-local `169.254/16` (which covers cloud instance-metadata endpoints), `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped IPv6 forms that would otherwise smuggle a private v4 address through a v6 literal.

**DNS.** A hostname that passes shape validation is resolved with `Deno.resolveDns` and *every* answer is classified before any connection. A single private answer rejects the target, including the case where `A` is public but `AAAA` is private. Resolution failure **fails closed** — an unresolvable host is rejected, not probed. If `resolveDns` is unavailable the validator throws rather than silently skipping the check.

Redirects are not followed (`redirect: "manual"`): a redirect destination has not been through target validation, so following one would bypass everything above.

Requests time out after 8 s and response bodies are capped at 64 KiB, read incrementally with the stream cancelled once the cap is reached.

**Residual risk — DNS rebinding.** This cannot be fully eliminated with the portable Fetch API, because the resolved socket address is not exposed to the caller. A TOCTOU window exists between our validating resolution and the runtime's own resolution for the connection; a hostile resolver with a very low TTL could answer differently for the two. Closing it requires egress network controls or a resolver/proxy that pins and re-verifies the resolved address at connect time. This is a deployment-level control, and it is not in place on Supabase Edge Functions.

A refused target is recorded as an observation with chain status `unmonitorable` and is **never** submitted onchain, so a policy refusal cannot become a payout.

## Cron endpoint authorisation

`monitor-due` and `sync-chain` are public HTTPS endpoints standing in front of the monitor's signing key. Both require `CRON_SECRET`, compared in constant time. A secret shorter than 24 characters is treated as misconfiguration and the function refuses to run (returning `500`, distinct from `401`) rather than operating with a brute-forceable credential over a public endpoint.

## Database privileges

RLS is enabled on `guarantees`, `observations`, `incidents`, `monitor_runs` and `chain_sync_state`. `anon` and `authenticated` receive `select` only, and only on the three public tables plus the `chain_sync_public` view. `monitor_runs` and `chain_sync_state` have RLS enabled with no public read policy, so lease tokens and cursor internals are not world-readable. All writes, and `execute` on `claim_due_guarantees`, `complete_monitor_run` and `advance_chain_cursor`, are granted to `service_role` alone. Those functions are `security definer` with a pinned `search_path`, so a shadowed object in another schema cannot hijack them.

Postgres is a read model. Deleting or editing an indexed row cannot move coverage; Base Sepolia remains authoritative for beneficiary, liability, incident and payout state.

## Secrets

- `MONITOR_PRIVATE_KEY` lives only in Supabase Function secrets. It never reaches the browser, the repository or any log line.
- The monitor wallet holds testnet gas only, never USDC.
- `CRON_SECRET` is stored as a Function secret and in Supabase Vault for pg_cron requests.
- Deployer keys are never committed. `.gitignore` covers `*.pem`, `*.key`, `*.keystore`, `secrets.json` and `.secrets`, and only `.env.example` files are tracked.
- The browser receives exactly five variables — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL`, `NEXT_PUBLIC_UPTIMESURE_CONTRACT`, `NEXT_PUBLIC_USDC_ADDRESS`. `SUPABASE_SERVICE_ROLE_KEY`, `MONITOR_PRIVATE_KEY`, `CRON_SECRET` and any deployer key appear nowhere in `app/`, `lib/`, `components/` or the build output.

Every blob in the repository's history was scanned for 64-hex private keys, mnemonic phrases, Supabase secret formats (`eyJ`, `sbp_`) and common provider key prefixes (`sk-`, `ghp_`, `AKIA`, `AIza`, `xox`). No matching blob is present in any commit.

That claim is reproducible rather than asserted — `scripts/scan-history-secrets.py` is the scan, and it exits non-zero on any hit:

```bash
python scripts/scan-history-secrets.py
```

At the time of writing it reports 204 of 204 blobs across 57 commits read, 0 skipped, 0 matches. Those counts drift with every commit — including the one that records them — so treat the script's output as authoritative and the numbers here as a sample.

Two design points matter more than the pattern list. The scan enumerates objects with `git cat-file --batch-all-objects`, so it covers blobs that no ref points to, which is the case it exists to catch: a secret committed once and later deleted stays in the object store and a working-tree grep will not see it. And it reports blobs skipped for size instead of passing over them, because a scan that quietly ignores part of its input reads as a clean result it did not earn. Both properties were verified by planting a private key in an unreferenced blob: the scan found it and exited 1, and reported clean again once the object was removed.

## Dependency posture

The frontend and the Edge Functions report **zero known vulnerabilities**. Reaching that required upgrading `next` to 16.3.2 (which cleared four `postcss` advisories and the `sharp`/libvips CVEs), `viem` to 2.55.19 in both the frontend and the Edge Function import pins (clearing two `ws` advisories in the component that holds the monitor key), and `vitest` to 3.2.7 (clearing a critical advisory).

`contracts/` still reports findings, and they are not silenced. `npm audit` there reports **42 advisories (20 low, 7 moderate, 15 high, 0 critical)**, arising from exactly eight packages: `undici`, `adm-zip`, `serialize-javascript`, `tmp`, `uuid`, `bn.js`, `cookie` and `elliptic`. Everything else in the report is a transitive path into one of those eight, so no root cause is undocumented here. Two further findings were fixed with scoped `overrides`: `ws` pinned to 8.21.3 under `@ethersproject/providers` (which pins an exact vulnerable version, so `npm audit fix` was a no-op), and `lodash` to 4.18.1 — both verified still applied, and `ws` no longer appears in the report at any version. The remaining eight sit inside the Hardhat 2 developer toolchain; `npm audit fix --force` resolves them only by installing `hardhat@3.14.0`, which it labels a breaking change.

That migration is deliberately not bundled with this release. The contracts package produces **no runtime artifact**: what deploys is compiled EVM bytecode, and these advisories are reachable only by a developer or CI runner executing the local toolchain against hostile input. Forcing incompatible versions inside Hardhat's own dependency tree risks breaking the 42-test suite that proves the settlement contract safe, which would be a worse security outcome than a build-time advisory. Overrides were applied only where the change stays within a major and a cold compile plus the full suite was re-verified afterwards. Migrating to Hardhat 3 is tracked as follow-up work, not as done.

## Mainnet gaps

Before any real-value use: independent monitors with a quorum, a third-party audit, timelocked admin, a provider dispute policy, legal and regulatory analysis, egress-level SSRF controls that close the rebinding window, production RPC redundancy, and an incident-finality policy.
