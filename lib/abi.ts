import { parseAbi } from "viem";

export const coreAbi = parseAbi([
  "function createGuarantee((address beneficiary,string endpointUrl,uint16 expectedStatus,string expectedFragment,uint32 maxLatencyMs,uint32 checkIntervalSecs,uint8 failureThreshold,uint32 minOutageSecs,uint96 payoutPerIncident,uint16 maxPayouts,uint64 expiresAt,uint256 coverageAmount) p) returns (uint256 guaranteeId)",
  "function topUp(uint256 guaranteeId,uint256 amount)",
  "function withdrawExpired(uint256 guaranteeId)",
  "function getGuarantee(uint256 guaranteeId) view returns ((address provider,address beneficiary,string endpointUrl,bytes32 criteriaHash,uint16 expectedStatus,string expectedFragment,uint32 maxLatencyMs,uint32 checkIntervalSecs,uint8 failureThreshold,uint32 minOutageSecs,uint96 payoutPerIncident,uint16 maxPayouts,uint16 paidPayouts,uint256 remainingCoverage,uint64 createdAt,uint64 expiresAt,uint64 firstFailureAt,uint64 lastObservedAt,uint8 consecutiveFailures,bool active,bool withdrawn))",
  "event GuaranteeCreated(uint256 indexed guaranteeId,address indexed provider,address indexed beneficiary,string endpointUrl,bytes32 criteriaHash,uint256 coverageAmount)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
