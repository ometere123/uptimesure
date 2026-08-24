import { createClient } from "npm:@supabase/supabase-js@2.56.1";
import { parseEventLogs } from "npm:viem@2.37.3";
import { authorizedCron, json } from "../_shared/auth.ts";
import { contractAddress, coreAbi, eventAbi, publicClient } from "../_shared/chain.ts";

const LOG_CHUNK = 1_000n;
const MAX_BLOCKS_PER_RUN = 5_000n;

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service credentials unavailable");
  return createClient(url, key, { auth: { persistSession: false } });
}

const iso = (seconds: bigint | number) => Number(seconds) === 0 ? null : new Date(Number(seconds) * 1000).toISOString();

async function syncGuarantee(id: bigint) {
  const supabase = adminClient();
  const client = publicClient();
  const g = await client.readContract({ address: contractAddress(), abi: coreAbi, functionName: "getGuarantee", args: [id] });
  if (!g.provider || /^0x0{40}$/i.test(g.provider)) return;
  const row = {
    id: Number(id), chain_id: 84532, contract_address: contractAddress(), provider: g.provider.toLowerCase(), beneficiary: g.beneficiary.toLowerCase(),
    endpoint_url: g.endpointUrl, criteria_hash: g.criteriaHash, expected_status: Number(g.expectedStatus), expected_fragment: g.expectedFragment,
    max_latency_ms: Number(g.maxLatencyMs), check_interval_seconds: Number(g.checkIntervalSecs), failure_threshold: Number(g.failureThreshold),
    min_outage_seconds: Number(g.minOutageSecs), payout_per_incident: g.payoutPerIncident.toString(), max_payouts: Number(g.maxPayouts),
    paid_payouts: Number(g.paidPayouts), remaining_coverage: g.remainingCoverage.toString(), created_at: iso(g.createdAt), expires_at: iso(g.expiresAt),
    first_failure_at: iso(g.firstFailureAt), last_observed_at: iso(g.lastObservedAt), consecutive_failures: Number(g.consecutiveFailures),
    active: g.active, withdrawn: g.withdrawn,
  };
  const { error } = await supabase.from("guarantees").upsert(row, { onConflict: "id" });
  if (error) throw error;
}

async function syncIncident(id: bigint) {
  const supabase = adminClient();
  const client = publicClient();
  const incident = await client.readContract({ address: contractAddress(), abi: coreAbi, functionName: "getIncident", args: [id] });
  if (incident.guaranteeId === 0n) return;
  const row = {
    id: Number(id), guarantee_id: Number(incident.guaranteeId), started_at: iso(incident.startedAt), confirmed_at: iso(incident.confirmedAt),
    recovered_at: iso(incident.recoveredAt), payout_amount: incident.payoutAmount.toString(), confirm_evidence_hash: incident.confirmEvidenceHash,
    recovery_evidence_hash: /^0x0{64}$/i.test(incident.recoveryEvidenceHash) ? null : incident.recoveryEvidenceHash,
  };
  const { error } = await supabase.from("incidents").upsert(row, { onConflict: "id" });
  if (error) throw error;
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!authorizedCron(req)) return json({ error: "unauthorized" }, 401);

    const deployBlockRaw = Deno.env.get("UPTIMESURE_DEPLOY_BLOCK");
    if (!deployBlockRaw || !/^\d+$/.test(deployBlockRaw)) return json({ error: "UPTIMESURE_DEPLOY_BLOCK is not configured" }, 503);
    const deployBlock = BigInt(deployBlockRaw);
    const supabase = adminClient();
    const client = publicClient();
    const latest = await client.getBlockNumber();
    const safeLatest = latest > 2n ? latest - 2n : latest;
    const { data: state, error: stateError } = await supabase.from("chain_sync_state").select("last_synced_block").eq("id", 1).single();
    if (stateError) return json({ error: `sync_state:${stateError.message}` }, 500);

    let fromBlock = state?.last_synced_block == null ? deployBlock : BigInt(state.last_synced_block) + 1n;
    if (fromBlock < deployBlock) fromBlock = deployBlock;
    if (fromBlock > safeLatest) return json({ synced: 0, latest: safeLatest.toString(), caughtUp: true });

    const maxToBlock = fromBlock + MAX_BLOCKS_PER_RUN - 1n;
    const targetLatest = maxToBlock < safeLatest ? maxToBlock : safeLatest;
    const touchedGuarantees = new Set<string>();
    const touchedIncidents = new Set<string>();
    let observationEvents = 0;
    let cursor = fromBlock;

    while (cursor <= targetLatest) {
      const chunkEnd = cursor + LOG_CHUNK - 1n;
      const toBlock = chunkEnd > targetLatest ? targetLatest : chunkEnd;
      const logs = await client.getLogs({ address: contractAddress(), fromBlock: cursor, toBlock });
      const parsed = parseEventLogs({ abi: eventAbi, logs, strict: false });
      for (const log of parsed) {
        const args = log.args as Record<string, unknown>;
        if (typeof args.guaranteeId === "bigint") touchedGuarantees.add(args.guaranteeId.toString());
        if (typeof args.incidentId === "bigint") touchedIncidents.add(args.incidentId.toString());
        if (log.eventName === "ObservationRecorded") {
          observationEvents++;
          const observationId = String(args.observationId);
          const indexed = await supabase.from("observations").upsert({
            observation_id: observationId,
            guarantee_id: Number(args.guaranteeId),
            observed_at: iso(args.observedAt as bigint),
            healthy: Boolean(args.healthy),
            evidence_hash: String(args.evidenceHash),
            tx_hash: log.transactionHash,
            tx_status: "indexed",
          }, { onConflict: "observation_id", ignoreDuplicates: true });
          if (indexed.error) throw indexed.error;
        }
      }
      cursor = toBlock + 1n;
    }

    for (const id of touchedGuarantees) await syncGuarantee(BigInt(id));
    for (const id of touchedIncidents) await syncIncident(BigInt(id));

    const saved = await supabase.from("chain_sync_state").upsert({ id: 1, last_synced_block: targetLatest.toString(), updated_at: new Date().toISOString() });
    if (saved.error) throw saved.error;

    return json({
      fromBlock: fromBlock.toString(),
      toBlock: targetLatest.toString(),
      networkSafeHead: safeLatest.toString(),
      caughtUp: targetLatest >= safeLatest,
      guarantees: touchedGuarantees.size,
      incidents: touchedIncidents.size,
      observations: observationEvents,
    });
  },
};
