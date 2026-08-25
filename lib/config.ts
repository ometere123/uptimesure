export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org";
export const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;

/**
 * The settlement contract, or `""` when no deployment is configured.
 *
 * Declared `0x${string}` because every read/write site passes it straight to viem, which requires that type.
 * The cast is therefore wider than the value: with no deployment this is the empty string, which is not a
 * valid address. That is safe only because `hasDeployment()` guards every one of those call sites — check it
 * before using this, and never assume the type alone makes the value usable.
 */
export const CORE_ADDRESS = (process.env.NEXT_PUBLIC_UPTIMESURE_CONTRACT || "") as `0x${string}`;

export function hasDeployment(): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(CORE_ADDRESS);
}
