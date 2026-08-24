/**
 * sync-chain — projects UptimeSureCore's onchain state into the Postgres read model.
 *
 * The contract is the financial source of truth. This function exists only so the frontend can read history
 * cheaply; nothing here is ever allowed to become authoritative over a balance, a coverage figure, or a payout.
 * Four properties keep that true:
 *
 *   1. State is resolved by *reading the contract*, not by accumulating event deltas. Events say only which ids
 *      changed; `getGuarantee`/`getIncident` say what they changed to. Re-processing a block range therefore
 *      converges on the same rows instead of double-counting a top-up or a payout.
 *
 *   2. Scanning is bounded and resumable. It starts at the deployment block (never genesis), advances in fixed
 *      chunks, stops at a block ceiling and a wall-clock budget, and persists its cursor through
 *      `advance_chain_cursor`, which refuses to move backwards. A crash mid-run costs at most one chunk.
 *
 *   3. Reorgs are absorbed rather than ignored. Only blocks below head-minus-confirmations are considered, and
 *      each run re-scans a small overlap window beneath the cursor so a shallow reorg's replacement blocks are
 *      picked up. Every write is idempotent, so re-scanning is free of consequence.
 *
 *   4. Monitor-written evidence is never overwritten. The monitor records what it actually observed (status,
 *      latency, body digest); the indexer only fills in rows the monitor lost and attaches the transaction hash
 *      the monitor may have crashed before recording.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.56.1";
import { parseEventLogs } from "npm:viem@2.55.19";
import { authorizeCron, cronRejection, json } from "../_shared/auth.ts";
import { contractAddress, coreAbi, deployBlock, eventAbi, publicClient } from "../_shared/chain.ts";

/**
 * The chain-specialised client type. Not viem's generic `PublicClient`: baseSepolia's OP-stack formatters add a
 * `deposit` transaction type, so the concrete client is not assignable to the generic one.
 */
type ChainClient = ReturnType<typeof publicClient>;

/** Blocks per getLogs call. Base Sepolia RPC providers reject much wider windows. */
const LOG_CHUNK = 1_000n;
/** Ceiling on blocks examined per invocation, so a long backfill is spread over many cron ticks. */
const MAX_BLOCKS_PER_RUN = 5_000n;
/**
 * Confirmation depth. Base is an OP-stack chain whose unsafe head can be replaced before it is derived from
 * L1; two confirmations (the previous value) is not enough to keep an orphaned log out of the read model.
 */
const DEFAULT_CONFIRMATIONS = 8n;
/**
 * Blocks re-scanned below the cursor on every run. Covers a reorg shallower than the confirmation depth that
 * nonetheless replaced a block already indexed. Cheap because every write is idempotent.
 */
const REORG_OVERLAP = 12n;
const RUN_BUDGET_MS = 50_000;
const CHAIN_ID = 84532;

function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_SERVICE_CREDENTIALS_MISSING");
  return createClient(url, key, { auth: { persistSession: false } });
}

function confirmations(): bigint {
  const raw = Deno.env.get("CHAIN_CONFIRMATIONS");
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_CONFIRMATIONS;
  const value = BigInt(raw);
  return value > 0n ? value : DEFAULT_CONFIRMATIONS;
}

const iso = (seconds: bigint | number): string | null =>
  Number(seconds) === 0 ? null : new Date(Number(seconds) * 1000).toISOString();

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 400);
  return String(error).slice(0, 400);
}

/**
 * Replaces a guarantee row with the contract's current view of it.
 *
 * Deliberately does not write `next_check_at`: the column is absent from the payload, so it takes `now()` on
 * insert (a newly indexed guarantee becomes due immediately) and is left untouched on conflict, where the
 * monitor's lease bookkeeping owns it.
 */
async function syncGuarantee(supabase: SupabaseClient, client: ChainClient, id: bigint): Promise<void> {
  const g = await client.readContract({
    address: contractAddress(),
    abi: coreAbi,
    functionName: "getGuarantee",
    args: [id],
  });
  if (!g.provider || /^0x0{40}$/i.test(g.provider)) return;

  const { error } = await supabase.from("guarantees").upsert({
    id: Number(id),
    chain_id: CHAIN_ID,
    contract_address: contractAddress(),
    provider: g.provider.toLowerCase(),
    beneficiary: g.beneficiary.toLowerCase(),
    endpoint_url: g.endpointUrl,
    criteria_hash: g.criteriaHash,
    expected_status: Number(g.expectedStatus),
    expected_fragment: g.expectedFragment,
    max_latency_ms: Number(g.maxLatencyMs),
    check_interval_seconds: Number(g.checkIntervalSecs),
    failure_threshold: Number(g.failureThreshold),
    min_outage_seconds: Number(g.minOutageSecs),
    payout_per_incident: g.payoutPerIncident.toString(),
    max_payouts: Number(g.maxPayouts),
    paid_payouts: Number(g.paidPayouts),
    remaining_coverage: g.remainingCoverage.toString(),
    created_at: iso(g.createdAt),
    expires_at: iso(g.expiresAt),
    first_failure_at: iso(g.firstFailureAt),
    last_observed_at: iso(g.lastObservedAt),
    consecutive_failures: Number(g.consecutiveFailures),
    active: g.active,
    withdrawn: g.withdrawn,
  }, { onConflict: "id" });
  if (error) throw new Error(`GUARANTEE_UPSERT_FAILED:${id}:${error.message}`);
}

async function syncIncident(supabase: SupabaseClient, client: ChainClient, id: bigint): Promise<void> {
  const incident = await client.readContract({
    address: contractAddress(),
    abi: coreAbi,
    functionName: "getIncident",
    args: [id],
  });
  if (incident.guaranteeId === 0n) return;

  const { error } = await supabase.from("incidents").upsert({
    id: Number(id),
    guarantee_id: Number(incident.guaranteeId),
    started_at: iso(incident.startedAt),
    confirmed_at: iso(incident.confirmedAt),
    recovered_at: iso(incident.recoveredAt),
    payout_amount: incident.payoutAmount.toString(),
    confirm_evidence_hash: incident.confirmEvidenceHash,
    recovery_evidence_hash: /^0x0{64}$/i.test(incident.recoveryEvidenceHash) ? null : incident.recoveryEvidenceHash,
  }, { onConflict: "id" });
  if (error) throw new Error(`INCIDENT_UPSERT_FAILED:${id}:${error.message}`);
}

interface ObservationEvent {
  observationId: string;
  guaranteeId: number;
  observedAt: string | null;
  healthy: boolean;
  evidenceHash: string;
  txHash: string;
}

/**
 * Reconciles observations against their onchain records, in two deliberately separate steps.
 *
 * Insert-if-absent runs with `ignoreDuplicates`, so a row the monitor already wrote — the only row that carries
 * the real HTTP status, latency and body digest — is never replaced by the thinner event-derived version.
 *
 * Attaching the transaction hash is then a targeted update restricted to rows that do not have one. That is
 * what closes the monitor's crash window: a monitor that broadcast successfully and died before recording the
 * hash leaves its row 'pending', and this promotes it to 'indexed' once the log is final.
 */
async function reconcileObservations(supabase: SupabaseClient, events: ObservationEvent[]): Promise<void> {
  if (events.length === 0) return;

  const { error: insertError } = await supabase.from("observations").upsert(
    events.map((e) => ({
      observation_id: e.observationId,
      guarantee_id: e.guaranteeId,
      observed_at: e.observedAt,
      healthy: e.healthy,
      evidence_hash: e.evidenceHash,
      tx_hash: e.txHash,
      tx_status: "indexed",
    })),
    { onConflict: "observation_id", ignoreDuplicates: true },
  );
  if (insertError) throw new Error(`OBSERVATION_INSERT_FAILED:${insertError.message}`);

  for (const event of events) {
    const { error } = await supabase
      .from("observations")
      .update({ tx_hash: event.txHash, tx_status: "indexed", chain_error: null })
      .eq("observation_id", event.observationId)
      .is("tx_hash", null);
    if (error) throw new Error(`OBSERVATION_TXHASH_FAILED:${event.observationId}:${error.message}`);
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const auth = authorizeCron(req);
    if (!auth.ok) return cronRejection(auth);

    const started = performance.now();
    const deploy = deployBlock();
    if (deploy === null) return json({ error: "UPTIMESURE_DEPLOY_BLOCK is not configured" }, 503);

    let supabase: SupabaseClient;
    let address: `0x${string}`;
    try {
      supabase = adminClient();
      address = contractAddress();
    } catch (error) {
      return json({ error: describeError(error) }, 503);
    }

    const client = publicClient();

    // maybeSingle, not single: a missing state row is a condition to repair, not a reason for the indexer to
    // never start. The row is seeded by migration 0005 and re-seeded here for safety.
    const { data: state, error: stateError } = await supabase
      .from("chain_sync_state")
      .select("last_synced_block")
      .eq("id", 1)
      .maybeSingle();
    if (stateError) return json({ error: `SYNC_STATE_READ_FAILED:${stateError.message}` }, 500);
    if (!state) {
      const { error } = await supabase.from("chain_sync_state").upsert({ id: 1 }, { onConflict: "id" });
      if (error) return json({ error: `SYNC_STATE_SEED_FAILED:${error.message}` }, 500);
    }

    // Recorded for the public status page so an operator can see which contract and deployment this cursor
    // belongs to without querying the chain.
    await supabase
      .from("chain_sync_state")
      .update({ chain_id: CHAIN_ID, deploy_block: Number(deploy), contract_address: address })
      .eq("id", 1);

    const head = await client.getBlockNumber();
    const depth = confirmations();
    const safeHead = head > depth ? head - depth : 0n;
    if (safeHead < deploy) {
      await supabase.rpc("advance_chain_cursor", {
        p_last_synced_block: Number(deploy) - 1,
        p_safe_block: Number(safeHead),
        p_events: 0,
        p_error: null,
      });
      return json({ head: head.toString(), safeHead: safeHead.toString(), caughtUp: true, indexed: 0 });
    }

    const cursor = state?.last_synced_block == null ? null : BigInt(state.last_synced_block);
    // Re-scan an overlap window beneath the cursor to absorb a reorg shallower than the confirmation depth.
    let fromBlock = cursor === null
      ? deploy
      : (cursor + 1n > REORG_OVERLAP ? cursor + 1n - REORG_OVERLAP : 0n);
    if (fromBlock < deploy) fromBlock = deploy;

    if (fromBlock > safeHead) {
      await supabase.rpc("advance_chain_cursor", {
        p_last_synced_block: Number(safeHead),
        p_safe_block: Number(safeHead),
        p_events: 0,
        p_error: null,
      });
      return json({
        fromBlock: fromBlock.toString(),
        head: head.toString(),
        safeHead: safeHead.toString(),
        caughtUp: true,
        indexed: 0,
      });
    }

    const runCeiling = fromBlock + MAX_BLOCKS_PER_RUN - 1n;
    const targetBlock = runCeiling < safeHead ? runCeiling : safeHead;

    const touchedGuarantees = new Set<string>();
    const touchedIncidents = new Set<string>();
    const observationEvents: ObservationEvent[] = [];
    // Only advanced after a chunk is fully processed, so a failure re-reads the chunk rather than skipping it.
    let processedThrough = fromBlock - 1n;
    let scanError: string | null = null;
    let budgetExhausted = false;

    try {
      let chunkStart = fromBlock;
      while (chunkStart <= targetBlock) {
        if (performance.now() - started > RUN_BUDGET_MS) {
          budgetExhausted = true;
          break;
        }
        const chunkEnd = chunkStart + LOG_CHUNK - 1n > targetBlock ? targetBlock : chunkStart + LOG_CHUNK - 1n;
        const logs = await client.getLogs({ address, fromBlock: chunkStart, toBlock: chunkEnd });
        const parsed = parseEventLogs({ abi: eventAbi, logs, strict: false });

        for (const log of parsed) {
          const args = log.args as Record<string, unknown>;
          if (typeof args.guaranteeId === "bigint") touchedGuarantees.add(args.guaranteeId.toString());
          if (typeof args.incidentId === "bigint") touchedIncidents.add(args.incidentId.toString());
          if (log.eventName === "ObservationRecorded" && log.transactionHash) {
            observationEvents.push({
              observationId: String(args.observationId),
              guaranteeId: Number(args.guaranteeId),
              observedAt: iso(args.observedAt as bigint),
              healthy: Boolean(args.healthy),
              evidenceHash: String(args.evidenceHash),
              txHash: log.transactionHash,
            });
          }
        }
        processedThrough = chunkEnd;
        chunkStart = chunkEnd + 1n;
      }

      await reconcileObservations(supabase, observationEvents);
      // Contract reads resolve current state, so ordering between guarantees and incidents does not matter and
      // a repeated run cannot drift the row away from the chain.
      for (const id of touchedGuarantees) await syncGuarantee(supabase, client, BigInt(id));
      for (const id of touchedIncidents) await syncIncident(supabase, client, BigInt(id));
    } catch (error) {
      // Progress up to the last fully processed chunk is still committed, and the reason is persisted so a
      // stalled indexer is visible on the status page instead of failing silently.
      scanError = describeError(error);
    }

    const { data: newCursor, error: cursorError } = await supabase.rpc("advance_chain_cursor", {
      p_last_synced_block: Number(processedThrough),
      p_safe_block: Number(safeHead),
      p_events: observationEvents.length,
      p_error: scanError,
    });
    if (cursorError) return json({ error: `CURSOR_ADVANCE_FAILED:${cursorError.message}` }, 500);

    return json({
      fromBlock: fromBlock.toString(),
      toBlock: processedThrough.toString(),
      cursor: newCursor === null ? null : String(newCursor),
      head: head.toString(),
      safeHead: safeHead.toString(),
      confirmations: depth.toString(),
      caughtUp: scanError === null && !budgetExhausted && processedThrough >= safeHead,
      budgetExhausted,
      guarantees: touchedGuarantees.size,
      incidents: touchedIncidents.size,
      observations: observationEvents.length,
      error: scanError,
      durationMs: Math.round(performance.now() - started),
    }, scanError === null ? 200 : 500);
  },
};
