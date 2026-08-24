# Security Model

UptimeSure V1 is a testnet product and is not an audited mainnet insurance system.

## Bounded monitor authority

The Supabase monitor key receives only `MONITOR_ROLE`. It cannot change a beneficiary, withdraw provider coverage, change payout size, change maximum payouts or transfer arbitrary tokens. A compromised monitor can still submit false observations, so monitor compromise can cause premature payment to the already-fixed beneficiary. V1 makes that risk explicit rather than hiding it.

## Contract safeguards

- full maximum liability is escrowed before activation
- HTTPS endpoint required
- observation IDs are single-use
- observations must be fresh and monotonically spaced
- failures must be consecutive
- minimum outage duration must elapse
- only one incident can remain open at a time
- an unresolved outage cannot double-pay
- total payouts cannot exceed configured count or remaining coverage
- expired coverage returns only to the provider
- emergency pause is admin-only
- SafeERC20 + ReentrancyGuard protect token movement paths

## Endpoint safeguards

`monitor-due` rejects non-HTTPS URLs, URL credentials, localhost, common private/internal hostnames, raw IPv6 literals and private IPv4 literals. Redirects are not followed, requests time out after eight seconds and bodies are capped at 64 KiB.

DNS rebinding cannot be completely eliminated with the portable Fetch API because the resolved socket address is not exposed. A production monitor should add egress-network controls or a resolver/proxy that verifies resolved addresses before connection.

## Secrets

- `MONITOR_PRIVATE_KEY` lives only in Supabase Function secrets.
- The key should hold testnet gas only and no USDC.
- `CRON_SECRET` is stored both as a Function secret and in Supabase Vault for pg_cron requests.
- Deployer keys are never committed.
- Public frontend variables contain only public RPC, Supabase publishable configuration and deployed addresses.

## Mainnet gaps

Before real-value use: independent monitors/quorum, audit, timelocked admin, provider dispute policy, legal/regulatory analysis, stronger SSRF egress controls, production RPC redundancy and incident-finality policy are required.
