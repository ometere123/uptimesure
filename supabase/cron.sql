-- Run after replacing the placeholders. Supabase recommends Vault for tokens used by pg_cron/pg_net.
-- The Edge Functions also require CRON_SECRET as a Supabase Function secret.

select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'project_url');
select vault.create_secret('YOUR_SUPABASE_PUBLISHABLE_KEY', 'publishable_key');
select vault.create_secret('GENERATE_A_LONG_RANDOM_SECRET', 'uptimesure_cron_secret');

select cron.schedule(
  'uptimesure-sync-chain-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-chain',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
      'x-uptimesure-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'uptimesure_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'uptimesure-monitor-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/monitor-due',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
      'x-uptimesure-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'uptimesure_cron_secret')
    ),
    body := '{"limit": 20}'::jsonb
  );
  $$
);
