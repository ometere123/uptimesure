import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7c";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set DEPLOYER_PRIVATE_KEY.");

  const monitorAddress = process.env.MONITOR_ADDRESS;
  if (!monitorAddress || !ethers.isAddress(monitorAddress)) {
    throw new Error("MONITOR_ADDRESS must be a valid dedicated Base Sepolia monitor wallet.");
  }
  if (monitorAddress.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error("MONITOR_ADDRESS must be different from the deployer/admin wallet.");
  }

  const usdc = process.env.USDC_ADDRESS || BASE_SEPOLIA_USDC;
  if (!ethers.isAddress(usdc)) throw new Error("USDC_ADDRESS is invalid.");

  const Core = await ethers.getContractFactory("UptimeSureCore");
  const core = await Core.deploy(usdc);
  const deploymentTx = core.deploymentTransaction();
  if (!deploymentTx) throw new Error("Deployment transaction unavailable");
  await core.waitForDeployment();
  const receipt = await deploymentTx.wait();
  if (!receipt) throw new Error("Deployment receipt unavailable");

  const role = await core.MONITOR_ROLE();
  const grantTx = await core.grantRole(role, monitorAddress);
  await grantTx.wait();

  // The constructor grants MONITOR_ROLE to the deployer so local tests are
  // convenient. Production-like testnet deployment transfers that power to a
  // dedicated low-value monitor wallet and removes it from the admin wallet.
  const renounceTx = await core.renounceRole(role, deployer.address);
  await renounceTx.wait();

  const out = {
    network: "base-sepolia",
    chainId: 84532,
    contractAddress: await core.getAddress(),
    usdcAddress: usdc,
    deployer: deployer.address,
    deploymentTransaction: deploymentTx.hash,
    deploymentBlock: receipt.blockNumber,
    monitorAddress,
    monitorGrantTransaction: grantTx.hash,
    deployerMonitorRenounceTransaction: renounceTx.hash,
    deployedAt: new Date().toISOString(),
    status: "deployed"
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
