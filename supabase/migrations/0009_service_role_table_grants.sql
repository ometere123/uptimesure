-- Edge Functions use the service role through PostgREST.  Supabase's service-role
-- RLS bypass does not replace table privileges, so grant only the operational
-- tables needed by monitor-due and sync-chain.
grant usage on schema public to service_role;
grant select, insert, update, delete on
  public.guarantees,
  public.observations,
  public.incidents,
  public.monitor_runs,
  public.chain_sync_state
to service_role;

