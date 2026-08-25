import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_EXPLORER, BASE_SEPOLIA_RPC, CORE_ADDRESS, USDC_ADDRESS, hasDeployment } from "./config";

/**
 * Circle's published Base Sepolia USDC address, transcribed from
 * https://developers.circle.com/stablecoins/usdc-contract-addresses.
 *
 * Duplicated here on purpose. `config.ts` holds the value the app ships; this holds the value the app is
 * *supposed* to ship, so a typo in one is a failing test rather than a silently wrong build.
 */
const CIRCLE_BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("chain configuration", () => {
  // This suite exists because of a real defect: the shipped constant once ended `…CF7c` instead of `…CF7e`.
  // A single wrong nibble is invisible on inspection, points at an address with no contract on Base Sepolia,
  // and would make every approve/transferFrom revert. Both assertions below independently catch it.
  it("uses Circle's published Base Sepolia USDC address", () => {
    expect(USDC_ADDRESS).toBe(CIRCLE_BASE_SEPOLIA_USDC);
  });

  // The cheap structural guard, and the reason the original typo was findable at all: EIP-55 encodes a keccak
  // checksum in the letter casing, so altering any nibble invalidates the whole address. This catches a
  // mistyped constant without needing to know the correct value or reach the network.
  it("ships a strict EIP-55 checksummed USDC address", () => {
    expect(isAddress(USDC_ADDRESS, { strict: true })).toBe(true);
    expect(getAddress(USDC_ADDRESS.toLowerCase())).toBe(USDC_ADDRESS);
  });

  it("targets Base Sepolia and its explorer", () => {
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(84532);
    expect(BASE_SEPOLIA_EXPLORER).toBe("https://sepolia.basescan.org");
    expect(BASE_SEPOLIA_RPC.startsWith("https://")).toBe(true);
  });

  // The contract address is empty until a real deployment exists, and `hasDeployment()` is what every page
  // uses to decide between showing contract state and saying it cannot. The two must never disagree, or the
  // UI would either read address 0x or hide a deployment that is actually there.
  //
  // Read through a `string` alias on purpose. `CORE_ADDRESS` is declared `0x${string}` because nine viem call
  // sites require that type, but the declared type is narrower than the runtime domain — the value is `""`
  // with no deployment configured. Comparing the declared type against `""` is an impossible comparison that
  // fails `tsc`, so the widening is made explicit here instead of being silently assumed.
  it("agrees with hasDeployment() about whether a contract is configured", () => {
    const configured: string = CORE_ADDRESS;
    expect(hasDeployment()).toBe(configured !== "" && isAddress(configured));
  });

  it("only reports a deployment for a well-formed address", () => {
    const configured: string = CORE_ADDRESS;
    if (hasDeployment()) {
      expect(isAddress(configured, { strict: true })).toBe(true);
    } else {
      expect(configured).toBe("");
    }
  });
});
