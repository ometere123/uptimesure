import { createPublicClient, createWalletClient, custom, http, parseEventLogs } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_RPC, CORE_ADDRESS, hasDeployment, USDC_ADDRESS } from "./config";
import { coreAbi, erc20Abi } from "./abi";

export type WalletConnection = {
  address: `0x${string}`;
  wallet: ReturnType<typeof createWalletClient>;
};

/** Stages reported back to the UI so a multi-transaction flow can show which signature is being requested. */
export type FlowStage =
  | "checking-allowance"
  | "awaiting-approval-signature"
  | "confirming-approval"
  | "awaiting-signature"
  | "confirming"
  | "done";

export type StageReporter = (stage: FlowStage) => void;

const noop: StageReporter = () => {};

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
    };
  }
}

export const publicClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });

/** Base Sepolia's chain id as the hex string the wallet RPC methods expect. */
const CHAIN_ID_HEX = `0x${BASE_SEPOLIA_CHAIN_ID.toString(16)}` as const;

/** EIP-1193 error code for a chain the wallet has never been configured with. */
const CHAIN_NOT_ADDED = 4902;

function providerErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

/**
 * Moves the wallet onto Base Sepolia, adding the network first if the wallet has never seen it.
 *
 * A fresh MetaMask profile has no Base Sepolia entry, so `wallet_switchEthereumChain` fails with 4902 rather
 * than switching. Without the `wallet_addEthereumChain` fallback the connect button is a dead end for anyone who
 * has not manually added the network, which is most first-time users of a testnet product.
 */
async function ensureBaseSepolia(ethereum: NonNullable<Window["ethereum"]>): Promise<void> {
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    return;
  } catch (error) {
    if (providerErrorCode(error) !== CHAIN_NOT_ADDED) {
      throw new Error("Switch your wallet to Base Sepolia (chain 84532) to continue.");
    }
  }

  try {
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN_ID_HEX,
        chainName: "Base Sepolia",
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [BASE_SEPOLIA_RPC],
        blockExplorerUrls: ["https://sepolia.basescan.org"],
      }],
    });
  } catch {
    throw new Error("Add the Base Sepolia network (chain 84532) in your wallet, then reconnect.");
  }
}

export async function connectWallet(): Promise<WalletConnection> {
  if (typeof window === "undefined" || !window.ethereum) throw new Error("Install or enable an EVM wallet first.");
  const ethereum = window.ethereum;
  const wallet = createWalletClient({ chain: baseSepolia, transport: custom(ethereum) });
  const addresses = await wallet.requestAddresses();
  const address = addresses[0];
  if (!address) throw new Error("Wallet did not return an address.");

  await ensureBaseSepolia(ethereum);

  // Verified rather than assumed: a wallet can resolve the switch request without actually changing network,
  // and signing a guarantee on the wrong chain would send real value to an address that means nothing there.
  const chainId = await wallet.getChainId();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Wallet is on chain ${chainId}. Switch to Base Sepolia (84532) and reconnect.`);
  }

  return { address, wallet };
}

/**
 * Approves the settlement contract to move `amount` of test USDC, if it is not already allowed to.
 *
 * Returns undefined when the existing allowance already covers the amount, so a repeat provider is not asked
 * for a redundant signature.
 */
async function ensureAllowance(
  connection: WalletConnection,
  amount: bigint,
  onStage: StageReporter,
): Promise<`0x${string}` | undefined> {
  onStage("checking-allowance");
  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [connection.address, CORE_ADDRESS],
  });
  if (allowance >= amount) return undefined;

  onStage("awaiting-approval-signature");
  const approvalHash = await connection.wallet.writeContract({
    account: connection.address,
    chain: baseSepolia,
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CORE_ADDRESS, amount],
  });
  onStage("confirming-approval");
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
  },
  onStage: StageReporter = noop,
): Promise<{ approvalHash?: `0x${string}`; createHash: `0x${string}`; guaranteeId?: bigint }> {
  if (!hasDeployment()) throw new Error("UptimeSure contract has not been deployed yet.");
  const approvalHash = await ensureAllowance(connection, input.coverageAmount, onStage);

  onStage("awaiting-signature");
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
  onStage("confirming");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (receipt.status !== "success") throw new Error("Guarantee creation reverted.");

  // Only logs emitted by the settlement contract are trusted for the id. Filtering by address keeps another
  // contract touched by the same transaction from supplying a GuaranteeCreated-shaped log.
  const logs = parseEventLogs({
    abi: coreAbi,
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === CORE_ADDRESS.toLowerCase()),
    eventName: "GuaranteeCreated",
    strict: false,
  });
  onStage("done");
  return { approvalHash, createHash, guaranteeId: logs[0]?.args.guaranteeId };
}

export async function topUpGuarantee(
  connection: WalletConnection,
  guaranteeId: bigint,
  amount: bigint,
  onStage: StageReporter = noop,
): Promise<{ approvalHash?: `0x${string}`; topUpHash: `0x${string}` }> {
  if (!hasDeployment()) throw new Error("UptimeSure contract has not been deployed yet.");
  if (amount <= 0n) throw new Error("Top-up amount must be greater than zero.");
  const approvalHash = await ensureAllowance(connection, amount, onStage);

  onStage("awaiting-signature");
  const topUpHash = await connection.wallet.writeContract({
    account: connection.address,
    chain: baseSepolia,
    address: CORE_ADDRESS,
    abi: coreAbi,
    functionName: "topUp",
    args: [guaranteeId, amount],
  });
  onStage("confirming");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: topUpHash });
  if (receipt.status !== "success") throw new Error("Coverage top-up reverted.");
  onStage("done");
  return { approvalHash, topUpHash };
}

export async function withdrawExpiredGuarantee(
  connection: WalletConnection,
  guaranteeId: bigint,
  onStage: StageReporter = noop,
): Promise<`0x${string}`> {
  if (!hasDeployment()) throw new Error("UptimeSure contract has not been deployed yet.");
  onStage("awaiting-signature");
  const hash = await connection.wallet.writeContract({
    account: connection.address,
    chain: baseSepolia,
    address: CORE_ADDRESS,
    abi: coreAbi,
    functionName: "withdrawExpired",
    args: [guaranteeId],
  });
  onStage("confirming");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Expired coverage withdrawal reverted.");
  onStage("done");
  return hash;
}
