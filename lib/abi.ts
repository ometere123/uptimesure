import { parseAbi } from "viem";

/**
 * The subset of UptimeSureCore the browser needs.
 *
 * Read functions are included so pages can show contract state directly rather than only the indexed copy. The
 * indexed copy can lag or be wrong; the contract cannot. Anything financial — remaining coverage, paid payouts,
 * whether a guarantee is still active — is displayed from a live read where one is available.
 */
export const coreAbi = parseAbi([
  "function createGuarantee((address beneficiary,string endpointUrl,uint16 expectedStatus,string expectedFragment,uint32 maxLatencyMs,uint32 checkIntervalSecs,uint8 failureThreshold,uint32 minOutageSecs,uint96 payoutPerIncident,uint16 maxPayouts,uint64 expiresAt,uint256 coverageAmount) p) returns (uint256 guaranteeId)",
  "function topUp(uint256 guaranteeId,uint256 amount)",
  "function withdrawExpired(uint256 guaranteeId)",
  "function getGuarantee(uint256 guaranteeId) view returns ((address provider,address beneficiary,string endpointUrl,bytes32 criteriaHash,uint16 expectedStatus,string expectedFragment,uint32 maxLatencyMs,uint32 checkIntervalSecs,uint8 failureThreshold,uint32 minOutageSecs,uint96 payoutPerIncident,uint16 maxPayouts,uint16 paidPayouts,uint256 remainingCoverage,uint64 createdAt,uint64 expiresAt,uint64 firstFailureAt,uint64 lastObservedAt,uint8 consecutiveFailures,bool active,bool withdrawn,bool exhausted))",
  "function getIncident(uint256 incidentId) view returns ((uint256 guaranteeId,uint64 startedAt,uint64 confirmedAt,uint64 recoveredAt,uint96 payoutAmount,bytes32 confirmEvidenceHash,bytes32 recoveryEvidenceHash))",
  "function activeIncidentId(uint256 guaranteeId) view returns (uint256)",
  "function observationUsed(bytes32 replayKey) view returns (bool)",
  "function observationKey(uint256 guaranteeId,bytes32 observationId) pure returns (bytes32)",
  "function nextGuaranteeId() view returns (uint256)",
  "function nextIncidentId() view returns (uint256)",
  "function coverageToken() view returns (address)",
  "function paused() view returns (bool)",
  "function SETTLEMENT_WINDOW() view returns (uint64)",
  "event GuaranteeCreated(uint256 indexed guaranteeId,address indexed provider,address indexed beneficiary,string endpointUrl,bytes32 criteriaHash,uint256 coverageAmount)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
