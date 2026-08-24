# Supabase runtime

UptimeSure uses one Supabase Free project for Postgres, public read models, Cron and two Edge Functions.

## Deploy

1. Create a Supabase project.
2. Apply `migrations/0001_uptimesure.sql` with the SQL editor or CLI.
3. Deploy `monitor-due` and `sync-chain`.
4. Configure Function secrets:

```bash
supabase secrets set CRON_SECRET=<long-random-value>
supabase secrets set BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
supabase secrets set UPTIMESURE_CONTRACT_ADDRESS=<deployed-address>
supabase secrets set UPTIMESURE_DEPLOY_BLOCK=<deployment-block>
supabase secrets set MONITOR_PRIVATE_KEY=<restricted-monitor-key>
```

The monitor key must hold only the contract `MONITOR_ROLE` and enough Base Sepolia ETH for gas. It must not custody guarantee USDC.

5. Edit and run `cron.sql`. Store the project URL, publishable key and the same CRON_SECRET in Supabase Vault as shown there.

## Responsibilities

- `sync-chain`: indexes UptimeSure contract events and refreshes public read models.
- `monitor-due`: selects due active guarantees, performs bounded HTTPS probes, stores evidence and submits a deterministic observation onchain.
- Postgres: history/read model only. Base Sepolia contract state is authoritative for funds and payout rules.
