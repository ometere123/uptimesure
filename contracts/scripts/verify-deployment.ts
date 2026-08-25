import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA_CHAIN_ID = 84532n;

type DeploymentRecord = {
  network?: string;
  chainId?: number;
  contractAddress?: string | null;
  usdcAddress?: string | null;
  deployer?: string | null;
  deploymentTransaction?: string | null;
  deploymentBlock?: number | null;
  monitorAddress?: string | null;
  status?: string;
};

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

/// Reads the recorded deployment back off the public Base Sepolia RPC and asserts that every claim in
/// deployments/base-sepolia.json is true onchain. Nothing here trusts the JSON file except as a pointer.
async function main() {
  const target = path.resolve(__dirname, "../../deployments/base-sepolia.json");
  if (!fs.existsSync(target)) throw new Error(`Missing deployment record at ${target}`);
  const record = JSON.parse(fs.readFileSync(target, "utf8")) as DeploymentRecord;

  if (record.status !== "deployed" || !record.contractAddress) {
    throw new Error(
      `deployments/base-sepolia.json reports status="${record.status}" with contractAddress=${record.contractAddress}. ` +
        `There is nothing deployed to verify.`,
    );
  }

  const provider = ethers.provider;
  const chainId = (await provider.getNetwork()).chainId;
  check("connected to Base Sepolia", chainId === BASE_SEPOLIA_CHAIN_ID, `chainId=${chainId}`);

  const address = ethers.getAddress(record.contractAddress);
  const code = await provider.getCode(address);
  check("contract bytecode present", code !== "0x" && code.length > 2, `${(code.length - 2) / 2} bytes at ${address}`);

  const core = await ethers.getContractAt("UptimeSureCore", address);

  const coverageToken: string = await core.coverageToken();
  check(
    "coverageToken is Circle test USDC",
    coverageToken.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase(),
    coverageToken,
  );
  check(
    "recorded usdcAddress matches onchain coverageToken",
    (record.usdcAddress || "").toLowerCase() === coverageToken.toLowerCase(),
    `${record.usdcAddress} vs ${coverageToken}`,
  );

  const monitorRole: string = await core.MONITOR_ROLE();
  const adminRole: string = await core.DEFAULT_ADMIN_ROLE();

  if (record.monitorAddress) {
    const monitorHasRole: boolean = await core.hasRole(monitorRole, record.monitorAddress);
    check("monitor holds MONITOR_ROLE", monitorHasRole, `${record.monitorAddress}`);
  } else {
    check("monitor holds MONITOR_ROLE", false, "no monitorAddress recorded");
  }

  if (record.deployer) {
    const deployerIsAdmin: boolean = await core.hasRole(adminRole, record.deployer);
    const deployerIsMonitor: boolean = await core.hasRole(monitorRole, record.deployer);
    check("deployer holds DEFAULT_ADMIN_ROLE", deployerIsAdmin, `${record.deployer}`);
    check("deployer does NOT hold MONITOR_ROLE", !deployerIsMonitor, `${record.deployer}`);
  } else {
    check("deployer recorded", false, "no deployer recorded");
  }

  const nextGuaranteeId: bigint = await core.nextGuaranteeId();
  const nextIncidentId: bigint = await core.nextIncidentId();
  check("nextGuaranteeId initialised", nextGuaranteeId >= 1n, nextGuaranteeId.toString());
  check("nextIncidentId initialised", nextIncidentId >= 1n, nextIncidentId.toString());

  // Prove the declared interface is actually callable, not just that bytecode exists.
  const zeroGuarantee = await core.getGuarantee(0n);
  check(
    "getGuarantee() callable and empty at id 0",
    zeroGuarantee.provider === ethers.ZeroAddress,
    `provider=${zeroGuarantee.provider}`,
  );
  const paused: boolean = await core.paused();
  check("contract not paused", paused === false, `paused=${paused}`);

  if (record.deploymentTransaction) {
    const receipt = await provider.getTransactionReceipt(record.deploymentTransaction);
    check("deployment transaction found onchain", receipt !== null, record.deploymentTransaction);
    if (receipt) {
      check("deployment transaction succeeded", receipt.status === 1, `status=${receipt.status}`);
      check(
        "deployment transaction created this address",
        (receipt.contractAddress || "").toLowerCase() === address.toLowerCase(),
        `${receipt.contractAddress}`,
      );
      check(
        "recorded deploymentBlock matches receipt",
        record.deploymentBlock === receipt.blockNumber,
        `${record.deploymentBlock} vs ${receipt.blockNumber}`,
      );
    }
  } else {
    check("deployment transaction recorded", false, "none");
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} onchain verification check(s) failed: ${failed.map((f) => f.name).join(", ")}`);
  }
  console.log(`\nAll ${checks.length} onchain checks passed for ${address} on Base Sepolia.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
