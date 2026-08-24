/**
 * Live contract reads, and the comparison between the contract and the indexed copy of it.
 *
 * The database is a convenience index, not an authority. It can lag behind the chain by a few blocks, and if the
 * indexer has a bug it can be wrong indefinitely. Any page that shows money reads the contract too and says so
 * when the two disagree, rather than presenting a stale row as the current position.
 */

import { coreAbi } from "./abi";
import { publicClient } from "./chain";
import { CORE_ADDRESS, hasDeployment } from "./config";
import type { GuaranteeRow } from "./types";

export interface OnchainGuarantee {
  provider: `0x${string}`;
  beneficiary: `0x${string}`;
  endpointUrl: string;
  criteriaHash: `0x${string}`;
  expectedStatus: number;
  expectedFragment: string;
  maxLatencyMs: number;
  checkIntervalSecs: number;
  failureThreshold: number;
  minOutageSecs: number;
  payoutPerIncident: bigint;
  maxPayouts: number;
  paidPayouts: number;
  remainingCoverage: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  firstFailureAt: bigint;
  lastObservedAt: bigint;
  consecutiveFailures: number;
  active: boolean;
  withdrawn: boolean;
}

export interface OnchainGuaranteeState {
  guarantee: OnchainGuarantee;
  activeIncidentId: bigint;
  settlementWindowSecs: bigint;
  paused: boolean;
}

/** A guarantee id that has never been issued reads back as an all-zero struct rather than reverting. */
function isUnset(guarantee: OnchainGuarantee): boolean {
  return guarantee.provider === "0x0000000000000000000000000000000000000000";
}

/**
 * Reads one guarantee's authoritative state.
 *
 * Returns null when no contract is configured or the id has never been issued. Throws only on an RPC failure,
 * which callers surface as "the chain could not be reached" rather than silently falling back to the index.
 */
export async function readGuaranteeState(id: bigint): Promise<OnchainGuaranteeState | null> {
  if (!hasDeployment()) return null;
  const [guarantee, activeIncidentId, settlementWindowSecs, paused] = await Promise.all([
    publicClient.readContract({ address: CORE_ADDRESS, abi: coreAbi, functionName: "getGuarantee", args: [id] }),
    publicClient.readContract({ address: CORE_ADDRESS, abi: coreAbi, functionName: "activeIncidentId", args: [id] }),
    publicClient.readContract({ address: CORE_ADDRESS, abi: coreAbi, functionName: "SETTLEMENT_WINDOW" }),
    publicClient.readContract({ address: CORE_ADDRESS, abi: coreAbi, functionName: "paused" }),
  ]);
  if (isUnset(guarantee)) return null;
  return { guarantee, activeIncidentId, settlementWindowSecs: BigInt(settlementWindowSecs), paused };
}

export interface OnchainIncident {
  guaranteeId: bigint;
  startedAt: bigint;
  confirmedAt: bigint;
  recoveredAt: bigint;
  payoutAmount: bigint;
  confirmEvidenceHash: `0x${string}`;
  recoveryEvidenceHash: `0x${string}`;
}

export async function readIncident(id: bigint): Promise<OnchainIncident | null> {
  if (!hasDeployment() || id === 0n) return null;
  const incident = await publicClient.readContract({
    address: CORE_ADDRESS,
    abi: coreAbi,
    functionName: "getIncident",
    args: [id],
  });
  return incident.guaranteeId === 0n ? null : incident;
}

/** Seconds since the epoch, as the contract sees time. */
function toSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * The moment `withdrawExpired` starts succeeding, in epoch seconds.
 *
 * The contract requires `block.timestamp > expiresAt + SETTLEMENT_WINDOW`, not merely `> expiresAt`: an outage in
 * the last minutes of the term still needs settling. Offering the button at expiry would guarantee a revert.
 */
export function withdrawableAt(expiresAtSeconds: number, settlementWindowSecs: number): number {
  return expiresAtSeconds + settlementWindowSecs + 1;
}

/**
 * Field-by-field disagreement between the contract and the indexed row.
 *
 * Kept pure so it is unit-tested rather than only observed in a browser. An empty array means the index is
 * faithful for every value that matters financially.
 */
export function divergences(chain: OnchainGuarantee, indexed: GuaranteeRow): string[] {
  const differences: string[] = [];
  const compare = (label: string, onchain: string, row: string) => {
    if (onchain !== row) differences.push(`${label}: contract ${onchain}, index ${row}`);
  };

  compare("remaining coverage", chain.remainingCoverage.toString(), indexed.remaining_coverage);
  compare("paid incidents", chain.paidPayouts.toString(), String(indexed.paid_payouts));
  compare("consecutive failures", chain.consecutiveFailures.toString(), String(indexed.consecutive_failures));
  compare("active", String(chain.active), String(indexed.active));
  compare("withdrawn", String(chain.withdrawn), String(indexed.withdrawn));
  compare("payout per incident", chain.payoutPerIncident.toString(), indexed.payout_per_incident);
  compare("provider", chain.provider.toLowerCase(), indexed.provider.toLowerCase());
  compare("beneficiary", chain.beneficiary.toLowerCase(), indexed.beneficiary.toLowerCase());
  compare("endpoint", chain.endpointUrl, indexed.endpoint_url);
  compare("expiry", chain.expiresAt.toString(), String(toSeconds(indexed.expires_at)));
  return differences;
}
