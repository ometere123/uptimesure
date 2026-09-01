/**
 * Durable, at-most-once transaction state machine used by monitor-due.
 *
 * This module deliberately knows nothing about Supabase or viem.  Its dependencies are the
 * exact chain operations and the durable row patch, which makes the failure boundaries testable
 * without pretending a mock HTTP response is an end-to-end monitor test.
 */
export type DurableTxStatus = "pending" | "submitted" | "confirmed" | "failed";

export interface SettlementEvidence {
  observationId: string;
  evidenceHash: string;
  observedAt: number;
  healthy: boolean;
  status: number;
  latencyMs: number;
  bodyDigest: string;
  reason: string;
}

export interface SettlementState {
  txStatus: DurableTxStatus;
  txHash: string | null;
}

export interface SettlementPatch {
  txStatus: DurableTxStatus;
  txHash: string | null;
  error?: string | null;
}

export interface SettlementOps {
  /** Reads the replay guard. This must happen before any new submission. */
  isObservationUsed: () => Promise<boolean>;
  /** Simulates the exact submitObservation call for this immutable evidence. */
  simulate: (evidence: SettlementEvidence) => Promise<unknown>;
  /** Broadcasts the exact simulated call. */
  broadcast: (evidence: SettlementEvidence, simulation: unknown) => Promise<string>;
  /** Looks up the already persisted transaction hash. */
  receipt: (txHash: string) => Promise<"success" | "reverted">;
  persist: (patch: SettlementPatch) => Promise<void>;
}

export async function settleEvidence(
  evidence: SettlementEvidence,
  state: SettlementState,
  ops: SettlementOps,
): Promise<SettlementPatch> {
  if (await ops.isObservationUsed()) {
    const patch = { txStatus: "confirmed" as const, txHash: state.txHash, error: null };
    await ops.persist(patch);
    return patch;
  }

  if (state.txStatus === "submitted" && state.txHash) {
    try {
      const outcome = await ops.receipt(state.txHash);
      const patch = outcome === "success"
        ? { txStatus: "confirmed" as const, txHash: state.txHash, error: null }
        : { txStatus: "failed" as const, txHash: state.txHash, error: "TRANSACTION_REVERTED" };
      await ops.persist(patch);
      return patch;
    } catch (error) {
      const patch = { txStatus: "submitted" as const, txHash: state.txHash, error: `RECEIPT_PENDING:${String(error)}` };
      await ops.persist(patch);
      return patch;
    }
  }

  let simulation: unknown;
  try {
    simulation = await ops.simulate(evidence);
  } catch (error) {
    const patch = { txStatus: "pending" as const, txHash: null, error: `SIMULATION_FAILED:${String(error)}` };
    await ops.persist(patch);
    return patch;
  }

  let txHash: string;
  try {
    txHash = await ops.broadcast(evidence, simulation);
  } catch (error) {
    const patch = { txStatus: "pending" as const, txHash: null, error: `BROADCAST_FAILED:${String(error)}` };
    await ops.persist(patch);
    return patch;
  }

  // This persistence boundary is intentional. A restart after this point reconciles the hash;
  // it never creates a replacement transaction until the replay guard/receipt has been checked.
  await ops.persist({ txStatus: "submitted", txHash, error: null });
  try {
    const outcome = await ops.receipt(txHash);
    const patch = outcome === "success"
      ? { txStatus: "confirmed" as const, txHash, error: null }
      : { txStatus: "failed" as const, txHash, error: "TRANSACTION_REVERTED" };
    await ops.persist(patch);
    return patch;
  } catch (error) {
    const patch = { txStatus: "submitted" as const, txHash, error: `RECEIPT_PENDING:${String(error)}` };
    await ops.persist(patch);
    return patch;
  }
}
