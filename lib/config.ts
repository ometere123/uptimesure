export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org";
export const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7c") as `0x${string}`;
export const CORE_ADDRESS = (process.env.NEXT_PUBLIC_UPTIMESURE_CONTRACT || "") as `0x${string}`;

export function hasDeployment(): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(CORE_ADDRESS);
}
