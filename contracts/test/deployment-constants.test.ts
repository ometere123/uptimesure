import { expect } from "chai";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";

/**
 * Circle's published Base Sepolia USDC address, transcribed from
 * https://developers.circle.com/stablecoins/usdc-contract-addresses.
 */
const CIRCLE_BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA_CHAIN_ID = 84532;

function readSource(relative: string): string {
  return fs.readFileSync(path.resolve(__dirname, relative), "utf8");
}

/**
 * Guards the coverage-token constant the deploy and verify scripts compile in.
 *
 * These scripts already refuse a bad address at runtime — `ethers.isAddress` rejects a broken EIP-55 checksum
 * and `getCode` rejects an address with no contract — but both of those only fire when someone runs a deploy
 * against a live network. The constant itself is checked here so a mistyped address fails in CI instead.
 *
 * This is not hypothetical: the constant once read `…CF7c` rather than `…CF7e`. One wrong nibble is an address
 * with no code on Base Sepolia, and every SafeERC20 call against it would have reverted.
 */
describe("deployment constants", () => {
  it("Circle's address is itself strictly checksummed", () => {
    expect(ethers.isAddress(CIRCLE_BASE_SEPOLIA_USDC)).to.equal(true);
    expect(ethers.getAddress(CIRCLE_BASE_SEPOLIA_USDC.toLowerCase())).to.equal(CIRCLE_BASE_SEPOLIA_USDC);
  });

  // Asserted against the source text rather than by importing the scripts: both call `main()` on import and
  // would try to reach a network. The constant is what matters, and it is a single literal on one line.
  for (const script of ["deploy.ts", "verify-deployment.ts"]) {
    it(`${script} pins the correct Base Sepolia coverage token`, () => {
      const source = readSource(`../scripts/${script}`);
      const match = source.match(/BASE_SEPOLIA_USDC\s*=\s*"(0x[0-9a-fA-F]{40})"/);
      expect(match, `no BASE_SEPOLIA_USDC literal found in ${script}`).to.not.equal(null);
      expect(match![1]).to.equal(CIRCLE_BASE_SEPOLIA_USDC);
    });
  }

  // The committed deployment record is what the frontend and docs quote. Until a real deployment exists the
  // evidence fields must stay null rather than holding a placeholder that reads like a real transaction.
  describe("deployments/base-sepolia.json", () => {
    const record = JSON.parse(readSource("../../deployments/base-sepolia.json")) as Record<string, unknown>;

    it("records the correct coverage token", () => {
      expect(record.usdcAddress).to.equal(CIRCLE_BASE_SEPOLIA_USDC);
    });

    it("targets Base Sepolia", () => {
      expect(record.chainId).to.equal(BASE_SEPOLIA_CHAIN_ID);
      expect(record.network).to.equal("base-sepolia");
    });

    it("never claims a deployment without the evidence for one", () => {
      const claimsDeployed = record.status === "deployed";
      const evidence = ["contractAddress", "deploymentTransaction", "deploymentBlock", "deployer", "monitorAddress"];
      if (claimsDeployed) {
        for (const field of evidence) {
          expect(record[field], `status is "deployed" but ${field} is empty`).to.not.equal(null);
        }
        expect(ethers.isAddress(record.contractAddress as string)).to.equal(true);
        expect(record.deploymentTransaction as string).to.match(/^0x[0-9a-f]{64}$/i);
      } else {
        expect(record.status).to.equal("awaiting-deployment");
        for (const field of evidence) {
          expect(record[field], `status is not "deployed" so ${field} must be null`).to.equal(null);
        }
      }
    });
  });
});
