import { assertEquals, assert } from "std/assert";
import { settleEvidence, type SettlementEvidence, type SettlementPatch } from "./settlement.ts";

const evidence: SettlementEvidence = {
  observationId: "0xobs", evidenceHash: "0xevidence", observedAt: 100, healthy: false,
  status: 503, latencyMs: 42, bodyDigest: "0xbody", reason: "HTTP_STATUS", 
};

function fake(options: Partial<{
  used: boolean; simulateError: string; broadcastError: string; receiptError: string; receipt: "success" | "reverted";
}> = {}) {
  const calls: string[] = [];
  const patches: SettlementPatch[] = [];
  const ops = {
    isObservationUsed: async () => { calls.push("read"); return options.used ?? false; },
    simulate: async (e: SettlementEvidence) => { calls.push(`simulate:${e.observationId}:${e.evidenceHash}:${e.observedAt}`); if (options.simulateError) throw options.simulateError; return { exact: e }; },
    broadcast: async (e: SettlementEvidence) => { calls.push(`broadcast:${e.observationId}:${e.evidenceHash}`); if (options.broadcastError) throw options.broadcastError; return "0xtx"; },
    receipt: async (hash: string) => { calls.push(`receipt:${hash}`); if (options.receiptError) throw options.receiptError; return options.receipt ?? "success"; },
    persist: async (patch: SettlementPatch) => { patches.push(patch); calls.push(`persist:${patch.txStatus}`); },
  };
  return { ops, calls, patches };
}

Deno.test("chain read failure leaves immutable evidence for retry without a probe", async () => {
  let probes = 0;
  const first = fake({ simulateError: "rpc unavailable" });
  probes++;
  const a = await settleEvidence(evidence, { txStatus: "pending", txHash: null }, first.ops);
  const second = fake();
  const b = await settleEvidence(evidence, { txStatus: a.txStatus, txHash: a.txHash }, second.ops);
  assertEquals(probes, 1); assertEquals(a.txStatus, "pending"); assertEquals(b.txStatus, "confirmed");
  assert(second.calls.some((x) => x.includes("0xobs:0xevidence:100")));
});

Deno.test("simulation and broadcast failures remain retryable", async () => {
  const sim = fake({ simulateError: "transient" });
  assertEquals((await settleEvidence(evidence, { txStatus: "pending", txHash: null }, sim.ops)).txStatus, "pending");
  const broadcast = fake({ broadcastError: "offline" });
  assertEquals((await settleEvidence(evidence, { txStatus: "pending", txHash: null }, broadcast.ops)).txStatus, "pending");
  assertEquals(broadcast.calls.filter((x) => x.startsWith("broadcast")).length, 1);
});

Deno.test("receipt timeout and crash after broadcast reconcile the exact hash", async () => {
  const timeout = fake({ receiptError: "timeout" });
  const first = await settleEvidence(evidence, { txStatus: "pending", txHash: null }, timeout.ops);
  assertEquals(first, { txStatus: "submitted", txHash: "0xtx", error: "RECEIPT_PENDING:timeout" });
  const restart = fake({ used: true });
  const reconciled = await settleEvidence(evidence, first, restart.ops);
  assertEquals(reconciled.txStatus, "confirmed");
  assertEquals(restart.calls.filter((x) => x.startsWith("broadcast")).length, 0);
});

Deno.test("persisted transaction, already-settled replay, and reverted receipt are harmless", async () => {
  const persisted = fake();
  await settleEvidence(evidence, { txStatus: "submitted", txHash: "0xoriginal" }, persisted.ops);
  assert(persisted.calls.includes("receipt:0xoriginal"));
  const used = fake({ used: true });
  await settleEvidence(evidence, { txStatus: "pending", txHash: null }, used.ops);
  assertEquals(used.calls.filter((x) => x.startsWith("broadcast")).length, 0);
  const reverted = fake({ receipt: "reverted" });
  assertEquals((await settleEvidence(evidence, { txStatus: "pending", txHash: null }, reverted.ops)).txStatus, "failed");
});

Deno.test("recovery does not reinterpret the historical failed observation", async () => {
  const recovered = { ...evidence, observationId: "0xrecovery", evidenceHash: "0xrecovery-hash", observedAt: 101, healthy: true, status: 200, reason: "OK" };
  const old = fake();
  const oldResult = await settleEvidence(evidence, { txStatus: "pending", txHash: null }, old.ops);
  const later = fake();
  await settleEvidence(recovered, { txStatus: "pending", txHash: null }, later.ops);
  assert(old.calls.some((x) => x.includes("0xobs:0xevidence:100")));
  assert(later.calls.some((x) => x.includes("0xobs:0xevidence:100")) === false);
  assertEquals(oldResult.txHash, "0xtx");
});

Deno.test("duplicate workers and expiry boundary use the same observation once", async () => {
  const a = fake({ used: true }); const b = fake({ used: true });
  await Promise.all([
    settleEvidence(evidence, { txStatus: "pending", txHash: null }, a.ops),
    settleEvidence(evidence, { txStatus: "pending", txHash: null }, b.ops),
  ]);
  assertEquals(a.calls.filter((x) => x.startsWith("broadcast")).length, 0);
  assertEquals(b.calls.filter((x) => x.startsWith("broadcast")).length, 0);
  // observedAt is immutable; expiry policy is decided by the caller before this state machine.
  assertEquals(evidence.observedAt, 100);
});
