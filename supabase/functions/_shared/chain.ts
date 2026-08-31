import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
} from "npm:viem@2.55.19";
import { privateKeyToAccount } from "npm:viem@2.55.19/accounts";
import { baseSepolia } from "npm:viem@2.55.19/chains";

export const coreAbi = parseAbi([
  "function submitObservation(uint256 guaranteeId, bytes32 observationId, bool healthy, bytes32 evidenceHash, uint64 observedAt)",
  "function getGuarantee(uint256 guaranteeId) view returns ((address provider,address beneficiary,string endpointUrl,bytes32 criteriaHash,uint16 expectedStatus,string expectedFragment,uint32 maxLatencyMs,uint32 checkIntervalSecs,uint8 failureThreshold,uint32 minOutageSecs,uint96 payoutPerIncident,uint16 maxPayouts,uint16 paidPayouts,uint256 remainingCoverage,uint64 createdAt,uint64 expiresAt,uint64 firstFailureAt,uint64 lastObservedAt,uint8 consecutiveFailures,bool active,bool withdrawn,bool exhausted))",
  "function getIncident(uint256 incidentId) view returns ((uint256 guaranteeId,uint64 startedAt,uint64 confirmedAt,uint64 recoveredAt,uint96 payoutAmount,bytes32 confirmEvidenceHash,bytes32 recoveryEvidenceHash))",
  // Read before submitting so a monitor that crashed after broadcasting does not resubmit and revert.
  "function observationUsed(bytes32 replayKey) view returns (bool)",
  "function activeIncidentId(uint256 guaranteeId) view returns (uint256)",
  "function nextGuaranteeId() view returns (uint256)",
  "function nextIncidentId() view returns (uint256)",
  "function coverageToken() view returns (address)",
  "function paused() view returns (bool)",
  "function MONITOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

export const eventAbi = parseAbi([
  "event GuaranteeCreated(uint256 indexed guaranteeId,address indexed provider,address indexed beneficiary,string endpointUrl,bytes32 criteriaHash,uint256 coverageAmount)",
  "event GuaranteeFunded(uint256 indexed guaranteeId,uint256 amount,uint256 remainingCoverage)",
  "event ObservationRecorded(uint256 indexed guaranteeId,bytes32 indexed observationId,bool healthy,bytes32 evidenceHash,uint64 observedAt,uint8 consecutiveFailures)",
  "event IncidentConfirmed(uint256 indexed incidentId,uint256 indexed guaranteeId,uint64 startedAt,uint64 confirmedAt,uint96 payoutAmount,bytes32 evidenceHash)",
  "event IncidentRecovered(uint256 indexed incidentId,uint256 indexed guaranteeId,uint64 recoveredAt,bytes32 evidenceHash)",
  "event GuaranteeExhausted(uint256 indexed guaranteeId)",
  "event CoverageWithdrawn(uint256 indexed guaranteeId,address indexed provider,uint256 amount)",
]);

export const guaranteeCreatedEvent = parseAbiItem(
  "event GuaranteeCreated(uint256 indexed guaranteeId,address indexed provider,address indexed beneficiary,string endpointUrl,bytes32 criteriaHash,uint256 coverageAmount)",
);

/**
 * Mirrors `UptimeSureCore._observationKey`: keccak256(abi.encode(guaranteeId, observationId)).
 *
 * Computed locally rather than by calling the contract's `observationKey` view, so checking whether an
 * observation has already settled costs one RPC read instead of two.
 */
export function observationReplayKey(guaranteeId: bigint, observationId: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }],
    [guaranteeId, observationId],
  ));
}

export function rpcUrl(): string {
  return Deno.env.get("BASE_SEPOLIA_RPC_URL") || "https://sepolia.base.org";
}

export function contractAddress(): `0x${string}` {
  const value = Deno.env.get("UPTIMESURE_CONTRACT_ADDRESS");
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("UPTIMESURE_CONTRACT_ADDRESS is not configured");
  return value.toLowerCase() as `0x${string}`;
}

/** Block containing the deployment transaction. The indexer never scans below it. */
export function deployBlock(): bigint | null {
  const value = Deno.env.get("UPTIMESURE_DEPLOY_BLOCK");
  if (!value || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

export function publicClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl(), { timeout: 15_000, retryCount: 2 }) });
}

export function monitorWallet() {
  const key = Deno.env.get("MONITOR_PRIVATE_KEY");
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("MONITOR_PRIVATE_KEY is not configured");
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl(), { timeout: 15_000, retryCount: 2 }) });
  return { account, wallet };
}
