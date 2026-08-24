import { ethers, network } from "hardhat";
import fs from "node:fs";
import path from "node:path";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7c";
const BASE_SEPOLIA_CHAIN_ID = 84532n;

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set DEPLOYER_PRIVATE_KEY.");

  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Refusing to deploy: connected chainId ${chainId} is not Base Sepolia (84532).`);
  }

  const monitorAddress = process.env.MONITOR_ADDRESS;
  if (!monitorAddress || !ethers.isAddress(monitorAddress)) {
    throw new Error("MONITOR_ADDRESS must be a valid dedicated Base Sepolia monitor wallet.");
  }
  if (monitorAddress.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error("MONITOR_ADDRESS must be different from the deployer/admin wallet.");
  }

  const usdc = process.env.USDC_ADDRESS || BASE_SEPOLIA_USDC;
  if (!ethers.isAddress(usdc)) throw new Error("USDC_ADDRESS is invalid.");
  if (usdc.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) {
    // A different coverage asset is a deliberate act, not a typo: refuse unless explicitly acknowledged.
    if (process.env.ALLOW_NON_CIRCLE_USDC !== "yes") {
      throw new Error(
        `Refusing to deploy against ${usdc}. The supported Base Sepolia coverage asset is Circle test USDC ` +
          `${BASE_SEPOLIA_USDC}. Set ALLOW_NON_CIRCLE_USDC=yes to override deliberately.`,
      );
    }
  }

  const code = await ethers.provider.getCode(usdc);
  if (code === "0x") throw new Error(`No contract deployed at coverage token ${usdc} on chain ${chainId}.`);

  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance === 0n) {
    throw new Error(`Deployer ${deployer.address} holds 0 ETH on Base Sepolia. Fund it from a testnet faucet.`);
  }

  const Core = await ethers.getContractFactory("UptimeSureCore");
  const core = await Core.deploy(usdc, monitorAddress);
  const deploymentTx = core.deploymentTransaction();
  if (!deploymentTx) throw new Error("Deployment transaction unavailable");
  await core.waitForDeployment();
  const receipt = await deploymentTx.wait();
  if (!receipt) throw new Error("Deployment receipt unavailable");

  const contractAddress = await core.getAddress();
  const monitorRole = await core.MONITOR_ROLE();
  const adminRole = await core.DEFAULT_ADMIN_ROLE();

  // The constructor is the single source of the monitor grant, so there is no window in which one key holds
  // both admin and monitor power. Assert the resulting role layout before writing any evidence to disk.
  const monitorHasRole = await core.hasRole(monitorRole, monitorAddress);
  const deployerHasMonitor = await core.hasRole(monitorRole, deployer.address);
  const deployerIsAdmin = await core.hasRole(adminRole, deployer.address);
  if (!monitorHasRole) throw new Error("Monitor address did not receive MONITOR_ROLE.");
  if (deployerHasMonitor) throw new Error("Deployer unexpectedly holds MONITOR_ROLE.");
  if (!deployerIsAdmin) throw new Error("Deployer did not receive DEFAULT_ADMIN_ROLE.");

  const out = {
    network: network.name === "baseSepolia" ? "base-sepolia" : network.name,
    chainId: Number(chainId),
    contractAddress,
    usdcAddress: ethers.getAddress(usdc),
    deployer: deployer.address,
    deploymentTransaction: deploymentTx.hash,
    deploymentBlock: receipt.blockNumber,
    monitorAddress: ethers.getAddress(monitorAddress),
    monitorRole,
    sourceCommit: process.env.GITHUB_SHA || null,
    deployedAt: new Date().toISOString(),
    status: "deployed",
  };

  const target = path.resolve(__dirname, "../../deployments/base-sepolia.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
