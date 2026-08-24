import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7c";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set DEPLOYER_PRIVATE_KEY.");

  const usdc = process.env.USDC_ADDRESS || BASE_SEPOLIA_USDC;
  const Core = await ethers.getContractFactory("UptimeSureCore");
  const core = await Core.deploy(usdc);
  const deploymentTx = core.deploymentTransaction();
  if (!deploymentTx) throw new Error("Deployment transaction unavailable");
  await core.waitForDeployment();
  const receipt = await deploymentTx.wait();
  if (!receipt) throw new Error("Deployment receipt unavailable");

  const monitorAddress = process.env.MONITOR_ADDRESS;
  let monitorGrantTx: string | null = null;
  if (monitorAddress) {
    const role = await core.MONITOR_ROLE();
    const tx = await core.grantRole(role, monitorAddress);
    await tx.wait();
    monitorGrantTx = tx.hash;
  }

  const out = {
    network: "base-sepolia",
    chainId: 84532,
    contractAddress: await core.getAddress(),
    usdcAddress: usdc,
    deployer: deployer.address,
    deploymentTransaction: deploymentTx.hash,
    deploymentBlock: receipt.blockNumber,
    monitorAddress: monitorAddress || deployer.address,
    monitorGrantTransaction: monitorGrantTx,
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
