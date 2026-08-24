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

  async function submit(
    core: Awaited<ReturnType<typeof ethers.getContractFactory>> extends never ? never : any,
    signer: any,
    healthy: boolean,
    label: string,
    observedAt?: number
  ) {
    const timestamp = observedAt ?? await now();
    return core.connect(signer).submitObservation(
      1,
      ethers.keccak256(ethers.toUtf8Bytes(`obs-${label}`)),
      healthy,
      ethers.keccak256(ethers.toUtf8Bytes(`evidence-${label}`)),
      timestamp
    );
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

    await submit(core, admin, false, "pay-1");
    await advance(60);
    await submit(core, admin, false, "pay-2");
    await advance(60);
    await expect(submit(core, admin, false, "pay-3")).to.emit(core, "IncidentConfirmed");

    expect(await token.balanceOf(beneficiary.address)).to.equal(before + payout);
    const g = await core.getGuarantee(1);
    expect(g.paidPayouts).to.equal(1);
    expect(await core.activeIncidentId(1)).to.equal(1);
  });

  it("does not double-pay an unresolved incident and records recovery", async function () {
    const { admin, beneficiary, token, core, payout } = await fixture();

    await submit(core, admin, false, "incident-1");
    await advance(60);
    await submit(core, admin, false, "incident-2");
    await advance(60);
    await submit(core, admin, false, "incident-3");
    const afterPayout = await token.balanceOf(beneficiary.address);
    await advance(60);
    await submit(core, admin, false, "incident-4");
    expect(await token.balanceOf(beneficiary.address)).to.equal(afterPayout);

    await advance(60);
    await expect(submit(core, admin, true, "incident-5")).to.emit(core, "IncidentRecovered");
    expect(await core.activeIncidentId(1)).to.equal(0);
    const incident = await core.getIncident(1);
    expect(incident.recoveredAt).to.be.greaterThan(0);
    expect(incident.payoutAmount).to.equal(payout);
  });

  it("resets the consecutive-failure sequence after a healthy observation", async function () {
    const { admin, core } = await fixture();
    await submit(core, admin, false, "reset-1");
    expect((await core.getGuarantee(1)).consecutiveFailures).to.equal(1);

    await advance(60);
    await submit(core, admin, true, "reset-2");
    expect((await core.getGuarantee(1)).consecutiveFailures).to.equal(0);

    await advance(60);
    await submit(core, admin, false, "reset-3");
    const g = await core.getGuarantee(1);
    expect(g.consecutiveFailures).to.equal(1);
    expect(await core.activeIncidentId(1)).to.equal(0);
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

  it("rejects stale and excessively future-dated observations", async function () {
    const { admin, core } = await fixture();
    const current = await now();
    await expect(submit(core, admin, false, "stale", current - 601)).to.be.revertedWithCustomError(core, "ObservationOutOfWindow");
    await expect(submit(core, admin, false, "future", current + 31)).to.be.revertedWithCustomError(core, "ObservationOutOfWindow");
  });

  it("halts observation processing while the protocol is paused", async function () {
    const { admin, core } = await fixture();
    await core.connect(admin).pause();
    await expect(submit(core, admin, false, "paused")).to.be.reverted;
    await core.connect(admin).unpause();
    await expect(submit(core, admin, true, "unpaused")).to.emit(core, "ObservationRecorded");
  });

  it("exhausts a one-payout guarantee and rejects further observations", async function () {
    const { admin, beneficiary, token, core, payout } = await fixture(1);
    const before = await token.balanceOf(beneficiary.address);
    await submit(core, admin, false, "exhaust-1");
    await advance(60);
    await submit(core, admin, false, "exhaust-2");
    await advance(60);
    await expect(submit(core, admin, false, "exhaust-3")).to.emit(core, "GuaranteeExhausted");

    const g = await core.getGuarantee(1);
    expect(g.active).to.equal(false);
    expect(g.remainingCoverage).to.equal(0);
    expect(await token.balanceOf(beneficiary.address)).to.equal(before + payout);

    await advance(60);
    await expect(submit(core, admin, true, "exhaust-4")).to.be.revertedWithCustomError(core, "GuaranteeNotActive");
  });

  it("does not accept coverage top-ups after expiry", async function () {
    const { provider, token, core } = await fixture();
    await token.connect(provider).approve(await core.getAddress(), 10n * USDC);
    await advance(3700);
    await expect(core.connect(provider).topUp(1, 10n * USDC)).to.be.revertedWithCustomError(core, "GuaranteeNotActive");
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
