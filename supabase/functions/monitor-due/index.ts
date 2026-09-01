/**
 * monitor-due — probes every guarantee whose scheduled check has come due, and settles the result onchain.
 *
 * Invoked by Supabase Cron over pg_net with a shared secret. Four properties matter more than anything else in
 * this function, because it is the only component that can cause money to move:
 *
 *   1. A slot is monitored at most once. Claiming is an atomic lease in Postgres (`claim_due_guarantees`), not
 *      a `select ... where next_check_at <= now()`. Two invocations firing on the same cron tick, or one slow
 *      run overlapping the next tick, cannot both probe and both submit the same slot — which onchain would
 *      count two consecutive failures for one real outage and pull a payout forward.
 *
 *   2. A target refused by policy is never an outage. SSRF validation happens *outside* the probe's try/catch,
 *      and a refusal is recorded with tx_status 'unmonitorable': never healthy, never unhealthy, never
 *      submitted onchain. Conflating the two would let a guarantee written against a private or unresolvable
 *      endpoint mint incidents and drain the provider's coverage without any service having failed.
 *
 *   3. Stored evidence never contradicts the chain. A slot already settled onchain is not re-probed and its
 *      evidence columns are never rewritten, so the `evidence_hash` in the database always matches the one the
 *      contract recorded.
 *
 *   4. Evidence and settlement are separate durable phases. A chain failure leaves the same slot queued with
 *      its original evidence; only a completed settlement (or an explicit non-chain outcome) advances time.
 *
 * Gas policy: every failure is submitted onchain, and so is any healthy observation that has onchain work to do
 * (resetting a failure streak or recovering an open incident). A healthy observation against a guarantee that
 * is already healthy onchain changes nothing but `lastObservedAt`, so it stays in the evidence store and is
 * marked 'not_required' rather than burning testnet gas.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.56.1";
import { authorizeCron, cronRejection, json } from "../_shared/auth.ts";
import { contractAddress, coreAbi, monitorWallet, observationReplayKey, publicClient } from "../_shared/chain.ts";
import { evidenceHash, hashBytes, observationId as deriveObservationId } from "../_shared/evidence.ts";
import { assertSafeTarget, TargetRejected } from "../_shared/ssrf.ts";
import { settleEvidence } from "../_shared/settlement.ts";

/** One row returned by `claim_due_guarantees`: the policy plus the lease that authorises acting on it. */
interface Claim {
  guarantee_id: number;
  scheduled_for: string;
  claim_token: string;
  attempts: number;
  endpoint_url: string;
  expected_status: number;
  expected_fragment: string;
  max_latency_ms: number;
  check_interval_seconds: number;
  failure_threshold: number;
  expires_at: string;
  last_observed_at: string | null;
  consecutive_failures: number;
}

type ChainStatus =
  | "confirmed"
  | "failed"
  | "not_required"
  | "unmonitorable"
  | "pending"
  | "submitted"
  | "indexed";

interface Outcome {
  guaranteeId: number;
  scheduledFor: string;
  attempt: number;
  /** null when the target was refused by policy, or when the slot was already settled: neither healthy nor not. */
  healthy: boolean | null;
  status: number | null;
  latencyMs: number | null;
  reason: string;
  chain: ChainStatus;
  txHash: string | null;
}

interface ProbeResult {
  healthy: boolean;
  status: number;
  latencyMs: number;
  bodyDigest: `0x${string}`;
  reason: string;
  /** Unix seconds at completion of the bounded response measurement. */
  observedAt: number;
}

interface StoredObservation {
  observation_id: `0x${string}`;
  observed_at: string;
  healthy: boolean;
  http_status: number | null;
  latency_ms: number | null;
  body_keccak256: `0x${string}` | null;
  evidence_hash: `0x${string}`;
  error_code: string | null;
  tx_hash: `0x${string}` | null;
  tx_status: ChainStatus;
}

/** Contract state read once per slot, before probing. `null` when the RPC endpoint could not be reached. */
interface ChainState {
  active: boolean;
  withdrawn: boolean;
  expiresAt: bigint;
  lastObservedAt: bigint;
  checkIntervalSecs: number;
  consecutiveFailures: number;
  activeIncidentId: bigint;
  alreadySettled: boolean;
}

const MAX_BODY_BYTES = 65_536;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_DUE_PER_RUN = 10;
const PARALLELISM = 5;
const LEASE_SECONDS = 120;
/** Stop claiming new work past this point so the invocation finishes inside the Edge runtime's wall clock. */
const RUN_BUDGET_MS = 50_000;
const RECEIPT_TIMEOUT_MS = 60_000;
/** keccak256 of the empty byte string, used as the body digest when no body was read. */
const EMPTY_BODY_DIGEST = hashBytes(new Uint8Array());

function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_SERVICE_CREDENTIALS_MISSING");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Reads at most MAX_BODY_BYTES and then cancels the stream.
 *
 * An unbounded read is a denial-of-service vector against the monitor itself: a guarantee could name an
 * endpoint that streams indefinitely and exhaust the invocation's memory and time budget.
 */
async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = MAX_BODY_BYTES - total;
      const slice = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.length;
      if (value.length > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Performs the HTTP check against an already-validated URL and judges it against the guarantee policy.
 *
 * Only network and response errors are caught here. Target-policy rejection is the caller's concern and must
 * never reach this function, because everything this function returns is treated as evidence about the
 * endpoint's health.
 */
async function probe(url: URL, claim: Claim): Promise<ProbeResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      // A redirect is followed by no one: the destination has not been through target validation, so following
      // it would hand an attacker a way past every check above.
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "*/*", "user-agent": "UptimeSure-Monitor/1.0 (+https://github.com/ometere123/uptimesure)" },
    });
    const body = await readBoundedBody(response);
    const latencyMs = Math.round(performance.now() - started);
    const observedAt = Math.floor(Date.now() / 1000);
    const statusOk = response.status === claim.expected_status;
    const latencyOk = latencyMs <= claim.max_latency_ms;
    const fragmentOk = claim.expected_fragment === "" ||
      new TextDecoder().decode(body).includes(claim.expected_fragment);
    const healthy = statusOk && latencyOk && fragmentOk;

    return {
      healthy,
      status: response.status,
      latencyMs,
      bodyDigest: hashBytes(body),
      reason: healthy ? "OK" : !statusOk ? "STATUS_MISMATCH" : !fragmentOk ? "BODY_MISMATCH" : "LATENCY_BREACH",
      observedAt,
    };
  } catch (error) {
    return {
      healthy: false,
      status: 0,
      latencyMs: Math.round(performance.now() - started),
      bodyDigest: EMPTY_BODY_DIGEST,
      reason: classifyFetchError(error),
      observedAt: Math.floor(Date.now() / 1000),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Stable machine codes, so `reason` is aggregatable and the evidence hash is reproducible. */
function classifyFetchError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "TIMEOUT";
  if (!(error instanceof Error)) return "FETCH_ERROR";
  const message = error.message.toLowerCase();
  if (message.includes("dns") || message.includes("name not resolved")) return "DNS_FAILURE";
  if (message.includes("certificate") || message.includes("tls") || message.includes("ssl")) return "TLS_FAILURE";
  if (message.includes("refused")) return "CONNECTION_REFUSED";
  if (message.includes("reset")) return "CONNECTION_RESET";
  return "FETCH_ERROR";
}

/** Truncated, non-secret error text for `monitor_runs.last_error`. Never includes a key or a header value. */
function describeError(error: unknown): string {
  if (error instanceof TargetRejected) return error.message.slice(0, 200);
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 200);
  return String(error).slice(0, 200);
}

/** Reads everything the submission decision depends on, in one round of parallel calls. */
async function readChainState(guaranteeId: number, observationId: `0x${string}`): Promise<ChainState> {
  const client = publicClient();
  const address = contractAddress();
  const id = BigInt(guaranteeId);

  const [guarantee, alreadySettled, activeIncident] = await Promise.all([
    client.readContract({ address, abi: coreAbi, functionName: "getGuarantee", args: [id] }),
    client.readContract({
      address,
      abi: coreAbi,
      functionName: "observationUsed",
      args: [observationReplayKey(id, observationId)],
    }),
    client.readContract({ address, abi: coreAbi, functionName: "activeIncidentId", args: [id] }),
  ]);

  return {
    active: guarantee.active,
    withdrawn: guarantee.withdrawn,
    expiresAt: guarantee.expiresAt,
    lastObservedAt: guarantee.lastObservedAt,
    checkIntervalSecs: guarantee.checkIntervalSecs,
    consecutiveFailures: guarantee.consecutiveFailures,
    activeIncidentId: activeIncident,
    alreadySettled,
  };
}

async function patchObservation(
  supabase: SupabaseClient,
  observationId: `0x${string}`,
  patch: Record<string, string | null>,
): Promise<void> {
  const { error } = await supabase.from("observations").update(patch).eq("observation_id", observationId);
  // A failed status write is not worth abandoning the run over: the chain is the source of truth and the
  // indexer reconciles the row. Surfaced through the run's last_error instead.
  if (error) console.error(`chain_status_write_failed observation=${observationId} reason=${error.message}`);
}

async function loadObservation(
  supabase: SupabaseClient,
  observationId: `0x${string}`,
): Promise<StoredObservation | null> {
  const { data, error } = await supabase.from("observations")
    .select("observation_id,observed_at,healthy,http_status,latency_ms,body_keccak256,evidence_hash,error_code,tx_hash,tx_status")
    .eq("observation_id", observationId)
    .maybeSingle();
  if (error) throw new Error(`OBSERVATION_READ_FAILED:${error.message}`);
  return data as StoredObservation | null;
}

/**
 * Reconciles a slot whose observation the contract has already accepted.
 *
 * Reached when a previous attempt for this slot broadcast successfully and died before recording the outcome.
 * The endpoint is deliberately not re-probed: the evidence hash the contract holds was computed from the
 * earlier probe, and replacing the stored row would make the database contradict the chain.
 */
async function reconcileSettled(
  supabase: SupabaseClient,
  observationId: `0x${string}`,
): Promise<{ chain: ChainStatus; txHash: string | null }> {
  const { data } = await supabase
    .from("observations")
    .select("tx_hash")
    .eq("observation_id", observationId)
    .maybeSingle();

  const txHash = (data?.tx_hash ?? null) as string | null;
  if (txHash) {
    await patchObservation(supabase, observationId, { tx_status: "confirmed", chain_error: null });
    return { chain: "confirmed", txHash };
  }

  // Settled onchain but the hash was lost in the crash window between broadcast and the status write. Left
  // 'pending' with an explicit note; sync-chain attaches the hash when it indexes the ObservationRecorded log.
  await patchObservation(supabase, observationId, {
    tx_status: "pending",
    chain_error: "SETTLED_ONCHAIN_HASH_PENDING_INDEX",
  });
  return { chain: "pending", txHash: null };
}

/**
 * Decides whether an observation needs to go onchain, and submits it if so.
 *
 * Every skip decision is derived from state read out of the contract, using the contract's own comparison, so
 * this function and the contract cannot disagree about whether a submission would have been accepted.
 */
async function settleOnchain(
  supabase: SupabaseClient,
  claim: Claim,
  chain: ChainState,
  observationId: `0x${string}`,
  digest: `0x${string}`,
  result: ProbeResult,
  observedAt: number,
): Promise<{ chain: ChainStatus; txHash: string | null }> {
  // submitObservation reverts on `observedAt > expiresAt`: the moment falls outside the covered term.
  if (BigInt(observedAt) > chain.expiresAt) {
    await patchObservation(supabase, observationId, {
      tx_status: "not_required",
      chain_error: "OUTSIDE_COVERED_TERM",
    });
    return { chain: "not_required", txHash: null };
  }

  // submitObservation reverts on `observedAt < lastObservedAt + checkIntervalSecs - 5`. Same expression, same
  // inputs, so this skips exactly the submissions the contract would have rejected — no wasted gas on a revert.
  if (
    chain.lastObservedAt !== 0n &&
    BigInt(observedAt) < chain.lastObservedAt + BigInt(chain.checkIntervalSecs) - 5n
  ) {
    await patchObservation(supabase, observationId, {
      tx_status: "not_required",
      chain_error: "OBSERVATION_TOO_SOON",
    });
    return { chain: "not_required", txHash: null };
  }

  // A healthy probe against a guarantee that is already healthy onchain has nothing to change but
  // lastObservedAt. Keep the evidence, skip the gas. Failures and recoveries always go onchain.
  if (result.healthy && chain.consecutiveFailures === 0 && chain.activeIncidentId === 0n) {
    await patchObservation(supabase, observationId, { tx_status: "not_required", chain_error: null });
    return { chain: "not_required", txHash: null };
  }

  const client = publicClient();
  const address = contractAddress();
  const { wallet, account } = monitorWallet();
  const settled = await settleEvidence({
    observationId, evidenceHash: digest, observedAt, healthy: result.healthy,
    status: result.status, latencyMs: result.latencyMs, bodyDigest: result.bodyDigest, reason: result.reason,
  }, { txStatus: "pending", txHash: null }, {
    isObservationUsed: async () => false, // readChainState already performed this replay-guard read above
    simulate: async () => {
      const { request } = await client.simulateContract({
        address, abi: coreAbi, functionName: "submitObservation",
        args: [BigInt(claim.guarantee_id), observationId, result.healthy, digest, BigInt(observedAt)], account,
      });
      return request;
    },
    broadcast: async (_evidence, simulation) => wallet.writeContract(simulation as Parameters<typeof wallet.writeContract>[0]),
    receipt: async (hash) => {
      const receipt = await client.waitForTransactionReceipt({ hash: hash as `0x${string}`, confirmations: 1, timeout: RECEIPT_TIMEOUT_MS });
      return receipt.status === "success" ? "success" : "reverted";
    },
    persist: async (patch) => patchObservation(supabase, observationId, {
      tx_hash: patch.txHash,
      tx_status: patch.txStatus === "pending" ? "failed" : patch.txStatus,
      chain_error: patch.error?.slice(0, 240) ?? null,
    }),
  });
  return { chain: settled.txStatus === "confirmed" ? "confirmed" : settled.txStatus === "submitted" ? "submitted" : "failed", txHash: settled.txHash ?? null };
}

/**
 * Records a target refused by policy.
 *
 * Written with `healthy: false` because the column is not nullable, paired with tx_status 'unmonitorable',
 * which a database check constraint ties to `healthy = false`. Nothing downstream — not the chain submission
 * path, not the incident logic — treats an 'unmonitorable' row as a service failure.
 *
 * Inserted without overwriting: if an earlier attempt at this slot produced a real probe result, that result
 * stands. A refusal is only ever the *first* thing recorded for a slot.
 */
async function recordUnmonitorable(
  supabase: SupabaseClient,
  claim: Claim,
  observationId: `0x${string}`,
  code: string,
  observedAt: number,
): Promise<void> {
  const digest = evidenceHash({
    guaranteeId: BigInt(claim.guarantee_id),
    observationId,
    url: claim.endpoint_url,
    observedAt,
    status: 0,
    latencyMs: 0,
    healthy: false,
    reason: code,
    bodyDigest: EMPTY_BODY_DIGEST,
  });

  const { error } = await supabase.from("observations").upsert({
    observation_id: observationId,
    guarantee_id: claim.guarantee_id,
    scheduled_for: claim.scheduled_for,
    observed_at: new Date(observedAt * 1000).toISOString(),
    healthy: false,
    evidence_hash: digest,
    error_code: code,
    tx_status: "unmonitorable",
  }, { onConflict: "observation_id", ignoreDuplicates: true });

  if (error) throw new Error(`OBSERVATION_STORE_FAILED:${error.message}`);
}

/**
 * Runs one claimed slot to completion and releases the lease.
 *
 * Never throws: a failure is reported through the returned outcome and through `monitor_runs.last_error`, so
 * one broken guarantee cannot abort the batch or leave the others' leases held until they expire.
 */
async function processClaim(supabase: SupabaseClient, claim: Claim): Promise<Outcome> {
  let settlementPending = false;
  const outcome: Outcome = {
    guaranteeId: claim.guarantee_id,
    scheduledFor: claim.scheduled_for,
    attempt: claim.attempts,
    healthy: null,
    status: null,
    latencyMs: null,
    reason: "PENDING",
    chain: "pending",
    txHash: null,
  };
  let runError: string | null = null;

  try {
    const observationId = deriveObservationId(BigInt(claim.guarantee_id), claim.scheduled_for);

    // A row for this slot is the durable handoff between probing and settlement. Once present, its evidence
    // is immutable: retries reconstruct the exact chain arguments and never call the endpoint again.
    const stored = await loadObservation(supabase, observationId);
    if (stored) {
      outcome.healthy = stored.healthy;
      outcome.status = stored.http_status;
      outcome.latencyMs = stored.latency_ms;
      outcome.reason = stored.error_code ?? "STORED_EVIDENCE";
      if (stored.tx_status === "unmonitorable" || stored.tx_status === "not_required" || stored.tx_status === "confirmed" || stored.tx_status === "indexed") {
        outcome.chain = stored.tx_status;
        outcome.txHash = stored.tx_hash;
        return outcome;
      }
      if (stored.tx_status === "submitted" && stored.tx_hash) {
        try {
          const receipt = await publicClient().waitForTransactionReceipt({ hash: stored.tx_hash, confirmations: 1, timeout: RECEIPT_TIMEOUT_MS });
          const ok = receipt.status === "success";
          await patchObservation(supabase, observationId, { tx_status: ok ? "confirmed" : "failed", chain_error: ok ? null : "TRANSACTION_REVERTED" });
          outcome.chain = ok ? "confirmed" : "failed";
          outcome.txHash = stored.tx_hash;
          return outcome;
        } catch (error) {
          settlementPending = true;
          outcome.chain = "submitted";
          outcome.txHash = stored.tx_hash;
          await patchObservation(supabase, observationId, { chain_error: `RECEIPT_PENDING:${describeError(error)}`.slice(0, 240) });
          return outcome;
        }
      }
    }

    // Target policy first, and outside the probe's error handling. A rejection here is a statement about the
    // guarantee's configuration, not about the endpoint's availability.
    let url: URL;
    if (stored) {
      // The stored row is already the result of a completed probe. Do not re-run DNS policy during a
      // settlement retry; a later DNS answer must not change the observation being settled.
      url = new URL(claim.endpoint_url);
    } else {
      try {
        ({ url } = await assertSafeTarget(claim.endpoint_url));
      } catch (error) {
        if (!(error instanceof TargetRejected)) throw error;
        await recordUnmonitorable(supabase, claim, observationId, error.code, Math.floor(Date.now() / 1000));
        outcome.reason = error.code;
        outcome.chain = "unmonitorable";
        runError = describeError(error);
        return outcome;
      }
    }

    // Chain state before probing, so an already-settled slot is neither re-probed nor rewritten, and a
    // guarantee the contract has closed costs no HTTP request.
    let chain: ChainState | null = null;
    try {
      chain = await readChainState(claim.guarantee_id, observationId);
    } catch (error) {
      runError = `CHAIN_READ_FAILED:${describeError(error)}`.slice(0, 200);
    }

    if (chain?.alreadySettled) {
      const settled = await reconcileSettled(supabase, observationId);
      outcome.chain = settled.chain;
      outcome.txHash = settled.txHash;
      outcome.reason = "ALREADY_SETTLED_ONCHAIN";
      return outcome;
    }

    if (chain && (!chain.active || chain.withdrawn)) {
      // The read model lags the contract. The contract is authoritative: reconcile and stop monitoring.
      await supabase.from("guarantees")
        .update({ active: chain.active, withdrawn: chain.withdrawn })
        .eq("id", claim.guarantee_id);
      outcome.chain = "not_required";
      outcome.reason = "GUARANTEE_INACTIVE_ONCHAIN";
      return outcome;
    }

    const result = stored
      ? {
        healthy: stored.healthy,
        status: stored.http_status ?? 0,
        latencyMs: stored.latency_ms ?? 0,
        bodyDigest: stored.body_keccak256 ?? EMPTY_BODY_DIGEST,
        reason: stored.error_code ?? "STORED_EVIDENCE",
        observedAt: Math.floor(new Date(stored.observed_at).getTime() / 1000),
      }
      : await probe(url, claim);
    outcome.healthy = result.healthy;
    outcome.status = result.status;
    outcome.latencyMs = result.latencyMs;
    outcome.reason = result.reason;

    const digest = stored?.evidence_hash ?? evidenceHash({
      guaranteeId: BigInt(claim.guarantee_id), observationId, url: url.toString(), observedAt: result.observedAt,
      status: result.status, latencyMs: result.latencyMs, healthy: result.healthy, reason: result.reason,
      bodyDigest: result.bodyDigest,
    });

    // Evidence is stored before any chain interaction, so a crash mid-submission still leaves a record of what
    // was seen. Upsert keyed on observation_id: a retry of this slot rewrites its own row rather than adding a
    // second observation for one scheduled check. The chain columns are deliberately absent from the payload —
    // on insert they take their defaults, and on retry an earlier attempt's tx_hash is preserved.
    const { error: storeError } = await supabase.from("observations").upsert({
      observation_id: observationId,
      guarantee_id: claim.guarantee_id,
      scheduled_for: claim.scheduled_for,
      observed_at: new Date(result.observedAt * 1000).toISOString(),
      healthy: result.healthy,
      http_status: result.status,
      latency_ms: result.latencyMs,
      body_keccak256: result.bodyDigest,
      evidence_hash: digest,
      error_code: result.reason,
    }, { onConflict: "observation_id", ignoreDuplicates: true });
    if (storeError) throw new Error(`OBSERVATION_STORE_FAILED:${storeError.message}`);

    if (!chain) {
      // Evidence is kept; the submission could not even be evaluated. The next slot tries again.
      outcome.chain = "failed";
      settlementPending = true;
      await patchObservation(supabase, observationId, {
        tx_status: "failed",
        chain_error: (runError ?? "CHAIN_READ_FAILED").slice(0, 240),
      });
      return outcome;
    }

    try {
      const settled = await settleOnchain(supabase, claim, chain, observationId, digest, result, result.observedAt);
      outcome.chain = settled.chain;
      outcome.txHash = settled.txHash;
      settlementPending = settled.chain === "submitted";
    } catch (error) {
      // A chain failure must not discard the probe evidence, and must not be mistaken for a service failure.
      runError = describeError(error);
      outcome.chain = "failed";
      await patchObservation(supabase, observationId, {
        tx_status: "failed",
        chain_error: describeError(error).slice(0, 240),
      });
      settlementPending = true;
    }
    return outcome;
  } catch (error) {
    runError = describeError(error);
    if (outcome.reason === "PENDING") outcome.reason = "MONITOR_ERROR";
    // An unexpected failure is not proof that the slot completed. Leave it due so a later invocation can
    // recover the same evidence if it was already persisted, or retry the probe if no evidence was committed.
    settlementPending = true;
    return outcome;
  } finally {
    // A chain failure leaves this exact slot claimable. Successful or explicitly non-chain outcomes advance it.
    const { error } = await supabase.rpc("complete_monitor_run", {
      p_guarantee_id: claim.guarantee_id,
      p_scheduled_for: claim.scheduled_for,
      p_claim_token: claim.claim_token,
      p_last_error: runError,
      p_settlement_pending: settlementPending,
    });
    if (error) console.error(`lease_release_failed guarantee=${claim.guarantee_id} reason=${error.message}`);
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const auth = authorizeCron(req);
    if (!auth.ok) return cronRejection(auth);

    const started = performance.now();
    const body = await req.json().catch(() => ({})) as { limit?: number };
    const requested = Number(body.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_DUE_PER_RUN)
      : MAX_DUE_PER_RUN;

    let supabase: SupabaseClient;
    try {
      supabase = adminClient();
    } catch (error) {
      return json({ error: describeError(error) }, 500);
    }

    // Atomic lease. Concurrent invocations receive disjoint sets, so no slot is ever probed twice.
    const { data, error } = await supabase.rpc("claim_due_guarantees", {
      p_limit: limit,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) return json({ error: `CLAIM_FAILED:${error.message}` }, 500);

    const claims = (data ?? []) as Claim[];
    const outcomes: Outcome[] = [];
    let abandoned = 0;

    for (let i = 0; i < claims.length; i += PARALLELISM) {
      if (performance.now() - started > RUN_BUDGET_MS) {
        // Out of wall clock. The remaining leases simply expire and the next tick reclaims those slots.
        abandoned = claims.length - i;
        break;
      }
      outcomes.push(...await Promise.all(claims.slice(i, i + PARALLELISM).map((c) => processClaim(supabase, c))));
    }

    return json({
      claimed: claims.length,
      processed: outcomes.length,
      abandoned,
      durationMs: Math.round(performance.now() - started),
      results: outcomes,
    });
  },
};
