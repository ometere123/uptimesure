import { expect } from "chai";
import { ethers } from "hardhat";

const USDC = 1_000_000n;

async function now() {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block unavailable");
  return Number(block.timestamp);
}

async function advance(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("UptimeSureCore", function () {
  async function fixture(maxPayouts = 2) {
    const [admin, provider, beneficiary, stranger] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    const Core = await ethers.getContractFactory("UptimeSureCore");
    const core = await Core.deploy(await token.getAddress());

    await token.mint(provider.address, 1_000n * USDC);
    const payout = 25n * USDC;
    const coverage = payout * BigInt(maxPayouts);
    await token.connect(provider).approve(await core.getAddress(), coverage);

    const expiresAt = (await now()) + 3600;
    const params = {
      beneficiary: beneficiary.address,
      endpointUrl: "https://example.com/health",
      expectedStatus: 200,
      expectedFragment: "ok",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 3,
      minOutageSecs: 120,
      payoutPerIncident: payout,
      maxPayouts,
      expiresAt,
      coverageAmount: coverage,
    };
    await core.connect(provider).createGuarantee(params);
    return { admin, provider, beneficiary, stranger, token, core, payout, coverage, params };
  }

  it("escrows the full promised liability", async function () {
    const { provider, token, core, coverage } = await fixture();
    expect(await token.balanceOf(await core.getAddress())).to.equal(coverage);
    const g = await core.getGuarantee(1);
    expect(g.provider).to.equal(provider.address);
    expect(g.remainingCoverage).to.equal(coverage);
    expect(g.active).to.equal(true);
  });

  it("rejects underfunded guarantees and non-HTTPS endpoints", async function () {
    const [admin, provider, beneficiary] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    const Core = await ethers.getContractFactory("UptimeSureCore");
    const core = await Core.deploy(await token.getAddress());
    await token.mint(provider.address, 100n * USDC);
    await token.connect(provider).approve(await core.getAddress(), 100n * USDC);
    const expiresAt = (await now()) + 3600;

    const bad = {
      beneficiary: beneficiary.address,
      endpointUrl: "http://example.com",
      expectedStatus: 200,
      expectedFragment: "",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 2,
      minOutageSecs: 60,
      payoutPerIncident: 25n * USDC,
      maxPayouts: 2,
      expiresAt,
      coverageAmount: 50n * USDC,
    };
    await expect(core.connect(provider).createGuarantee(bad)).to.be.revertedWithCustomError(core, "InvalidEndpoint");

    await expect(
      core.connect(provider).createGuarantee({ ...bad, endpointUrl: "https://example.com", coverageAmount: 25n * USDC })
    ).to.be.revertedWithCustomError(core, "InvalidTerms");
    expect(admin.address).to.not.equal(provider.address);
  });

  it("pays the fixed beneficiary after a confirmed outage", async function () {
    const { admin, beneficiary, token, core, payout } = await fixture();
    const before = await token.balanceOf(beneficiary.address);

    const fail = async (salt: string) => {
      const observedAt = await now();
      return core.connect(admin).submitObservation(
        1,
        ethers.keccak256(ethers.toUtf8Bytes(`obs-${salt}`)),
        false,
        ethers.keccak256(ethers.toUtf8Bytes(`evidence-${salt}`)),
        observedAt
      );
    };

    await fail("1");
    await advance(60);
    await fail("2");
    await advance(60);
    await expect(fail("3")).to.emit(core, "IncidentConfirmed");

    expect(await token.balanceOf(beneficiary.address)).to.equal(before + payout);
    const g = await core.getGuarantee(1);
    expect(g.paidPayouts).to.equal(1);
    expect(await core.activeIncidentId(1)).to.equal(1);
  });

  it("does not double-pay an unresolved incident and records recovery", async function () {
    const { admin, beneficiary, token, core, payout } = await fixture();

    const submit = async (healthy: boolean, n: number) => {
      const t = await now();
      return core.connect(admin).submitObservation(
        1,
        ethers.keccak256(ethers.toUtf8Bytes(`obs-${n}`)),
        healthy,
        ethers.keccak256(ethers.toUtf8Bytes(`ev-${n}`)),
        t
      );
    };

    await submit(false, 1);
    await advance(60);
    await submit(false, 2);
    await advance(60);
    await submit(false, 3);
    const afterPayout = await token.balanceOf(beneficiary.address);
    await advance(60);
    await submit(false, 4);
    expect(await token.balanceOf(beneficiary.address)).to.equal(afterPayout);

    await advance(60);
    await expect(submit(true, 5)).to.emit(core, "IncidentRecovered");
    expect(await core.activeIncidentId(1)).to.equal(0);
    const incident = await core.getIncident(1);
    expect(incident.recoveredAt).to.be.greaterThan(0);
    expect(incident.payoutAmount).to.equal(payout);
  });

  it("rejects duplicate observations, rapid observations, and unauthorized monitors", async function () {
    const { admin, stranger, core } = await fixture();
    const observationId = ethers.keccak256(ethers.toUtf8Bytes("same"));
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
    const observedAt = await now();

    await core.connect(admin).submitObservation(1, observationId, true, evidence, observedAt);
    await expect(
      core.connect(admin).submitObservation(1, observationId, true, evidence, observedAt)
    ).to.be.revertedWithCustomError(core, "ObservationAlreadyUsed");

    await expect(
      core.connect(admin).submitObservation(
        1,
        ethers.keccak256(ethers.toUtf8Bytes("fast")),
        true,
        evidence,
        observedAt + 1
      )
    ).to.be.revertedWithCustomError(core, "ObservationTooSoon");

    await expect(
      core.connect(stranger).submitObservation(
        1,
        ethers.keccak256(ethers.toUtf8Bytes("unauthorized")),
        true,
        evidence,
        observedAt
      )
    ).to.be.reverted;
  });

  it("returns unused coverage to the provider only after expiry", async function () {
    const { provider, token, core, coverage } = await fixture();
    const providerBefore = await token.balanceOf(provider.address);
    await expect(core.connect(provider).withdrawExpired(1)).to.be.revertedWithCustomError(core, "GuaranteeNotExpired");
    await advance(3700);
    await core.connect(provider).withdrawExpired(1);
    expect(await token.balanceOf(provider.address)).to.equal(providerBefore + coverage);
    const g = await core.getGuarantee(1);
    expect(g.withdrawn).to.equal(true);
    expect(g.active).to.equal(false);
  });
});
