import { createPublicClient, createWalletClient, custom, http, parseEventLogs } from "viem";
import { baseSepolia } from "viem/chains";
import { CORE_ADDRESS, BASE_SEPOLIA_RPC, USDC_ADDRESS, hasDeployment } from "./config";
import { coreAbi, erc20Abi } from "./abi";

export type WalletConnection = {
  address: `0x${string}`;
  wallet: ReturnType<typeof createWalletClient>;
};

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
    };
  }
}

export const publicClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });

export async function connectWallet(): Promise<WalletConnection> {
  if (typeof window === "undefined" || !window.ethereum) throw new Error("Install or enable an EVM wallet first.");
  const wallet = createWalletClient({ chain: baseSepolia, transport: custom(window.ethereum) });
  const addresses = await wallet.requestAddresses();
  const address = addresses[0];
  if (!address) throw new Error("Wallet did not return an address.");
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
  } catch {
    throw new Error("Switch your wallet to Base Sepolia (chain 84532).");
  }
  return { address, wallet };
}

async function ensureAllowance(connection: WalletConnection, amount: bigint): Promise<`0x${string}` | undefined> {
  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [connection.address, CORE_ADDRESS],
  });
  if (allowance >= amount) return undefined;

  const approvalHash = await connection.wallet.writeContract({
    account: connection.address,
    chain: baseSepolia,
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CORE_ADDRESS, amount],
  });
  const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
  if (approvalReceipt.status !== "success") throw new Error("USDC approval failed.");
  return approvalHash;
}

export async function createGuarantee(
  connection: WalletConnection,
  input: {
    beneficiary: `0x${string}`;
    endpointUrl: string;
    expectedStatus: number;
    expectedFragment: string;
    maxLatencyMs: number;
    checkIntervalSecs: number;
    failureThreshold: number;
    minOutageSecs: number;
    payoutPerIncident: bigint;
    maxPayouts: number;
    expiresAt: bigint;
    coverageAmount: bigint;
  }
): Promise<{ approvalHash?: `0x${string}`; createHash: `0x${string}`; guaranteeId?: bigint }> {
  if (!hasDeployment()) throw new Error("UptimeSure contract has not been deployed yet.");
  const approvalHash = await ensureAllowance(connection, input.coverageAmount);

  const createHash = await connection.wallet.writeContract({
    account: connection.address,
    chain: baseSepolia,
    address: CORE_ADDRESS,
    abi: coreAbi,
    functionName: "createGuarantee",
    args: [{
      beneficiary: input.beneficiary,
      endpointUrl: input.endpointUrl,
      expectedStatus: input.expectedStatus,
      expectedFragment: input.expectedFragment,
      maxLatencyMs: input.maxLatencyMs,
      checkIntervalSecs: input.checkIntervalSecs,
      failureThreshold: input.failureThreshold,
      minOutageSecs: input.minOutageSecs,
      payoutPerIncident: input.payoutPerIncident,
      maxPayouts: input.maxPayouts,
      expiresAt: input.expiresAt,
      coverageAmount: input.coverageAmount,
    }],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (receipt.status !== "success") throw new Error("Guarantee creation reverted.");
  const logs = parseEventLogs({ abi: coreAbi, logs: receipt.logs, eventName: "GuaranteeCreated", strict: false });
  const guaranteeId = logs[0]?.args.guaranteeId;
  return { approvalHash, createHash, guaranteeId };
}

export async function topUpGuarantee(
  connection: WalletConnection,
  guaranteeId: bigint,
  amount: bigint,
): Promise<{ approvalHash?: `0x${string}`; topUpHash: `0x${string}` }> {
  if (!hasDeployment()) throw new Error("UptimeSure contract has not been deployed yet.");
  if (amount <= 0n) throw new Error("Top-up amount must be greater than zero.");
  const approvalHash = await ensureAllowance(connection, amount);
  const topUpHash = await connection.wallet.writeContract({
    account: connection.address,
    chain: baseSepolia,
    address: CORE_ADDRESS,
    abi: coreAbi,
    functionName: "topUp",
    args: [guaranteeId, amount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: topUpHash });
  if (receipt.status !== "success") throw new Error("Coverage top-up reverted.");
  return { approvalHash, topUpHash };
}

export async function withdrawExpiredGuarantee(
  connection: WalletConnection,
  guaranteeId: bigint,
): Promise<`0x${string}`> {
  if (!hasDeployment()) throw new Error("UptimeSure contract has not been deployed yet.");
  const hash = await connection.wallet.writeContract({
    account: connection.address,
    chain: baseSepolia,
    address: CORE_ADDRESS,
    abi: coreAbi,
    functionName: "withdrawExpired",
    args: [guaranteeId],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Expired coverage withdrawal reverted.");
  return hash;
}
