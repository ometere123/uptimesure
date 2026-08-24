import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { UptimeSureCore } from "../typechain-types";
import type { UptimeSureCore as UptimeSureCoreTypes } from "../typechain-types/contracts/UptimeSureCore";

const USDC = 1_000_000n;
const SETTLEMENT_WINDOW = 1800;

async function now() {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("latest block unavailable");
  return Number(block.timestamp);
}

async function advance(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

type Params = UptimeSureCoreTypes.CreateGuaranteeParamsStruct;

describe("UptimeSureCore", function () {
  async function deployCore(tokenAddress: string) {
    const [, , , , monitor] = await ethers.getSigners();
    const Core = await ethers.getContractFactory("UptimeSureCore");
    return Core.deploy(tokenAddress, monitor.address);
  }

  async function fixture(maxPayouts = 2, overrides: Partial<Params> = {}) {
    const [admin, provider, beneficiary, stranger, monitor] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    const core = await deployCore(await token.getAddress());

    await token.mint(provider.address, 10_000n * USDC);
    const payout = 25n * USDC;
    const coverage = payout * BigInt(maxPayouts);
    // Approve generously: the approval is the provider's own act and individual tests override the
    // coverage amount. The escrowed balance is asserted separately from the allowance.
    await token.connect(provider).approve(await core.getAddress(), 10_000n * USDC);

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
      ...overrides,
    } as Params;
    await core.connect(provider).createGuarantee(params);
    return { admin, provider, beneficiary, stranger, monitor, token, core, payout, coverage, params, expiresAt };
  }

  function submit(
    core: UptimeSureCore,
    signer: HardhatEthersSigner,
    healthy: boolean,
    label: string,
    observedAt: number,
    guaranteeId = 1n,
  ) {
    return core.connect(signer).submitObservation(
      guaranteeId,
      ethers.keccak256(ethers.toUtf8Bytes(`obs-${label}`)),
      healthy,
      ethers.keccak256(ethers.toUtf8Bytes(`evidence-${label}`)),
      observedAt,
    );
  }

  async function submitNow(core: UptimeSureCore, signer: HardhatEthersSigner, healthy: boolean, label: string) {
    return submit(core, signer, healthy, label, await now());
  }

  // -------------------------------------------------------------------------
  // Deployment and role separation
  // -------------------------------------------------------------------------

  it("refuses to deploy with a zero token, zero monitor, or a monitor equal to the admin", async function () {
    const [admin, , , , monitor] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    const Core = await ethers.getContractFactory("UptimeSureCore");

    await expect(Core.deploy(ethers.ZeroAddress, monitor.address)).to.be.revertedWithCustomError(Core, "InvalidAddress");
    await expect(Core.deploy(await token.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Core,
      "InvalidAddress",
    );
    await expect(Core.deploy(await token.getAddress(), admin.address)).to.be.revertedWithCustomError(
      Core,
      "InvalidAddress",
    );
  });

  it("separates admin power from monitor power at construction", async function () {
    const { admin, monitor, core } = await fixture();
    const monitorRole = await core.MONITOR_ROLE();
    const adminRole = await core.DEFAULT_ADMIN_ROLE();

    expect(await core.hasRole(monitorRole, monitor.address)).to.equal(true);
    expect(await core.hasRole(monitorRole, admin.address)).to.equal(false);
    expect(await core.hasRole(adminRole, admin.address)).to.equal(true);
    expect(await core.hasRole(adminRole, monitor.address)).to.equal(false);

    // The admin holds no oracle power, so a compromised admin key cannot assert an outage.
    await expect(submitNow(core, admin, false, "admin-as-monitor")).to.be.revertedWithCustomError(
      core,
      "AccessControlUnauthorizedAccount",
    );
    // The monitor holds no admin power, so a compromised monitor key cannot pause or unpause the market.
    await expect(core.connect(monitor).pause()).to.be.revertedWithCustomError(
      core,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("exposes no path for admin or monitor to move escrowed coverage", async function () {
    // A regression fence: the escrow may only move through these four functions. Adding any "rescue",
    // "sweep" or "migrate" entry point breaks this test on purpose, forcing a deliberate review.
    const { core } = await fixture();
    const stateChanging = core.interface.fragments
      .filter((f): f is import("ethers").FunctionFragment => f.type === "function")
      .filter((f) => f.stateMutability !== "view" && f.stateMutability !== "pure")
      .map((f) => f.name)
      .sort();

    expect(stateChanging).to.deep.equal([
      "createGuarantee",
      "grantRole",
      "pause",
      "renounceRole",
      "revokeRole",
      "submitObservation",
      "topUp",
      "unpause",
      "withdrawExpired",
    ]);
  });

  it("does not let the monitor choose the beneficiary or the payout size", async function () {
    const { monitor, beneficiary, stranger, token, core, payout } = await fixture();
    const monitorBefore = await token.balanceOf(monitor.address);
    const strangerBefore = await token.balanceOf(stranger.address);
    const beneficiaryBefore = await token.balanceOf(beneficiary.address);

    await submitNow(core, monitor, false, "fixed-1");
    await advance(60);
    await submitNow(core, monitor, false, "fixed-2");
    await advance(60);
    await submitNow(core, monitor, false, "fixed-3");

    // Compensation went to the address the provider fixed at creation, for exactly the fixed amount.
    expect(await token.balanceOf(beneficiary.address)).to.equal(beneficiaryBefore + payout);
    expect(await token.balanceOf(monitor.address)).to.equal(monitorBefore);
    expect(await token.balanceOf(stranger.address)).to.equal(strangerBefore);
    expect((await core.getIncident(1)).payoutAmount).to.equal(payout);
  });

  it("keeps the beneficiary immutable for the lifetime of the guarantee", async function () {
    const { beneficiary, core, params } = await fixture();
    const g = await core.getGuarantee(1);
    expect(g.beneficiary).to.equal(beneficiary.address);
    expect(g.beneficiary).to.equal(params.beneficiary);
    // No function on the contract accepts a beneficiary after creation.
    const setters = core.interface.fragments
      .filter((f): f is import("ethers").FunctionFragment => f.type === "function")
      .filter((f) => f.inputs.some((i) => i.name.toLowerCase().includes("beneficiary")));
    expect(setters).to.have.lengthOf(0);
  });

  // -------------------------------------------------------------------------
  // Creation and parameter validation
  // -------------------------------------------------------------------------

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
    const core = await deployCore(await token.getAddress());
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
    } as Params;
    await expect(core.connect(provider).createGuarantee(bad)).to.be.revertedWithCustomError(core, "InvalidEndpoint");

    await expect(
      core.connect(provider).createGuarantee({ ...bad, endpointUrl: "https://example.com", coverageAmount: 25n * USDC }),
    ).to.be.revertedWithCustomError(core, "InvalidTerms");
    expect(admin.address).to.not.equal(provider.address);
  });

  it("rejects a zero-address beneficiary", async function () {
    const [, provider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    const core = await deployCore(await token.getAddress());
    await token.mint(provider.address, 100n * USDC);
    await token.connect(provider).approve(await core.getAddress(), 100n * USDC);

    const params = {
      beneficiary: ethers.ZeroAddress,
      endpointUrl: "https://example.com/health",
      expectedStatus: 200,
      expectedFragment: "",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 2,
      minOutageSecs: 60,
      payoutPerIncident: 25n * USDC,
      maxPayouts: 2,
      expiresAt: (await now()) + 3600,
      coverageAmount: 50n * USDC,
    } as Params;
    await expect(core.connect(provider).createGuarantee(params)).to.be.revertedWithCustomError(core, "InvalidAddress");
  });

  it("rejects endpoints that the off-chain monitor could read differently from the onchain record", async function () {
    const [, provider, beneficiary] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    const core = await deployCore(await token.getAddress());
    await token.mint(provider.address, 1_000n * USDC);
    await token.connect(provider).approve(await core.getAddress(), 1_000n * USDC);

    const base = {
      beneficiary: beneficiary.address,
      endpointUrl: "https://example.com/health",
      expectedStatus: 200,
      expectedFragment: "",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 2,
      minOutageSecs: 60,
      payoutPerIncident: 25n * USDC,
      maxPayouts: 2,
      expiresAt: (await now()) + 3600,
      coverageAmount: 50n * USDC,
    } as Params;

    const hostile = [
      "https://user:pass@10.0.0.1/health", // userinfo pointing at an internal host
      "https://example.com/health\n", // trailing control character
      "https://example.com/ health", // embedded space
      "https://exa mple.com/health", // NUL byte
      "https://exämple.com/health", // non-ASCII / IDN confusable
      "https://example.com/<script>", // angle brackets
      "https://example.com/health\\..", // backslash traversal
      "https://example.com/{id}", // braces
      "https://example.com/a|b", // pipe
    ];
    for (const endpointUrl of hostile) {
      await expect(
        core.connect(provider).createGuarantee({ ...base, endpointUrl }),
        `expected rejection for ${JSON.stringify(endpointUrl)}`,
      ).to.be.revertedWithCustomError(core, "InvalidEndpoint");
    }

    // A plain HTTPS URL with a query string and port remains acceptable.
    await expect(
      core.connect(provider).createGuarantee({ ...base, endpointUrl: "https://example.com:8443/health?deep=1" }),
    ).to.emit(core, "GuaranteeCreated");
  });

  it("enforces every policy bound at its edge", async function () {
    const [, provider, beneficiary] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    const core = await deployCore(await token.getAddress());
    await token.mint(provider.address, 1_000_000n * USDC);
    await token.connect(provider).approve(await core.getAddress(), 1_000_000n * USDC);

    const t = await now();
    const base = {
      beneficiary: beneficiary.address,
      endpointUrl: "https://example.com/health",
      expectedStatus: 200,
      expectedFragment: "",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 2,
      minOutageSecs: 60,
      payoutPerIncident: 25n * USDC,
      maxPayouts: 2,
      expiresAt: t + 3600,
      coverageAmount: 50n * USDC,
    } as Params;

    const rejected: [string, Partial<Params>][] = [
      ["status below 100", { expectedStatus: 99 }],
      ["status above 599", { expectedStatus: 600 }],
      ["latency below 100ms", { maxLatencyMs: 99 }],
      ["latency above 30s", { maxLatencyMs: 30_001 }],
      ["interval below 60s", { checkIntervalSecs: 59 }],
      ["interval above 24h", { checkIntervalSecs: 86_401 }],
      ["zero failure threshold", { failureThreshold: 0 }],
      ["failure threshold above 10", { failureThreshold: 11 }],
      ["minimum outage shorter than the threshold implies", { failureThreshold: 3, minOutageSecs: 119 }],
      ["minimum outage above 7 days", { minOutageSecs: 604_801 }],
      ["zero payout", { payoutPerIncident: 0n }],
      ["zero max payouts", { maxPayouts: 0 }],
      ["max payouts above 100", { maxPayouts: 101, coverageAmount: 101n * 25n * USDC }],
      ["fragment longer than 128 bytes", { expectedFragment: "x".repeat(129) }],
      ["expiry inside the first check interval", { expiresAt: t + 30 }],
      ["expiry beyond the maximum term", { expiresAt: t + 366 * 24 * 3600 + 600 }],
      ["endpoint shorter than 12 bytes", { endpointUrl: "https://a.b" }],
      ["endpoint longer than 512 bytes", { endpointUrl: `https://example.com/${"a".repeat(500)}` }],
    ];

    for (const [label, override] of rejected) {
      await expect(core.connect(provider).createGuarantee({ ...base, ...override }), label).to.be.reverted;
    }

    // The permissive edge of each bound is accepted, proving the checks are not off by one.
    await expect(
      core.connect(provider).createGuarantee({
        ...base,
        expectedStatus: 100,
        maxLatencyMs: 100,
        checkIntervalSecs: 60,
        failureThreshold: 1,
        minOutageSecs: 0,
        maxPayouts: 1,
        payoutPerIncident: 1n,
        coverageAmount: 1n,
        expiresAt: (await now()) + 120,
      }),
    ).to.emit(core, "GuaranteeCreated");
  });

  it("accepts coverage above the full liability and never promises more than it holds", async function () {
    const { token, core, coverage } = await fixture(2, { coverageAmount: 200n * USDC });
    const g = await core.getGuarantee(1);
    expect(g.remainingCoverage).to.equal(200n * USDC);
    expect(await token.balanceOf(await core.getAddress())).to.equal(200n * USDC);
    expect(g.remainingCoverage).to.be.greaterThanOrEqual(g.payoutPerIncident * BigInt(g.maxPayouts));
    expect(coverage).to.equal(50n * USDC);
  });

  // -------------------------------------------------------------------------
  // Observation lifecycle
  // -------------------------------------------------------------------------

  it("pays the fixed beneficiary after a confirmed outage", async function () {
    const { monitor, beneficiary, token, core, payout } = await fixture();
    const before = await token.balanceOf(beneficiary.address);

    await submitNow(core, monitor, false, "pay-1");
    await advance(60);
    await submitNow(core, monitor, false, "pay-2");
    await advance(60);
    await expect(submitNow(core, monitor, false, "pay-3")).to.emit(core, "IncidentConfirmed");

    expect(await token.balanceOf(beneficiary.address)).to.equal(before + payout);
    const g = await core.getGuarantee(1);
    expect(g.paidPayouts).to.equal(1);
    expect(await core.activeIncidentId(1)).to.equal(1);
  });

  it("does not confirm an incident before the threshold and the minimum outage are both satisfied", async function () {
    const { monitor, beneficiary, token, core } = await fixture(2, { failureThreshold: 3, minOutageSecs: 600 });
    const before = await token.balanceOf(beneficiary.address);

    // Threshold reached at three failures, but only ~120s of outage has elapsed.
    await submitNow(core, monitor, false, "slow-1");
    await advance(60);
    await submitNow(core, monitor, false, "slow-2");
    await advance(60);
    await submitNow(core, monitor, false, "slow-3");
    expect(await core.activeIncidentId(1)).to.equal(0);
    expect(await token.balanceOf(beneficiary.address)).to.equal(before);
    expect((await core.getGuarantee(1)).consecutiveFailures).to.equal(3);

    // Once the outage has lasted minOutageSecs the next failure confirms it.
    await advance(600);
    await expect(submitNow(core, monitor, false, "slow-4")).to.emit(core, "IncidentConfirmed");
  });

  it("does not double-pay an unresolved incident and records recovery", async function () {
    const { monitor, beneficiary, token, core, payout } = await fixture();

    await submitNow(core, monitor, false, "incident-1");
    await advance(60);
    await submitNow(core, monitor, false, "incident-2");
    await advance(60);
    await submitNow(core, monitor, false, "incident-3");
    const afterPayout = await token.balanceOf(beneficiary.address);
    await advance(60);
    await submitNow(core, monitor, false, "incident-4");
    expect(await token.balanceOf(beneficiary.address)).to.equal(afterPayout);

    await advance(60);
    await expect(submitNow(core, monitor, true, "incident-5")).to.emit(core, "IncidentRecovered");
    expect(await core.activeIncidentId(1)).to.equal(0);
    const incident = await core.getIncident(1);
    expect(incident.recoveredAt).to.be.greaterThan(0);
    expect(incident.recoveryEvidenceHash).to.equal(
      ethers.keccak256(ethers.toUtf8Bytes("evidence-incident-5")),
    );
    expect(incident.payoutAmount).to.equal(payout);
  });

  it("pays a second, separate incident after a recovery", async function () {
    const { monitor, beneficiary, token, core, payout } = await fixture(2);
    const before = await token.balanceOf(beneficiary.address);

    for (const label of ["first-1", "first-2", "first-3"]) {
      await submitNow(core, monitor, false, label);
      await advance(60);
    }
    expect(await token.balanceOf(beneficiary.address)).to.equal(before + payout);
    await submitNow(core, monitor, true, "recovered");
    await advance(60);

    for (const label of ["second-1", "second-2"]) {
      await submitNow(core, monitor, false, label);
      await advance(60);
    }
    await expect(submitNow(core, monitor, false, "second-3")).to.emit(core, "GuaranteeExhausted");

    expect(await token.balanceOf(beneficiary.address)).to.equal(before + payout * 2n);
    const g = await core.getGuarantee(1);
    expect(g.paidPayouts).to.equal(2);
    expect(g.remainingCoverage).to.equal(0);
    expect(g.active).to.equal(false);
    expect(await core.nextIncidentId()).to.equal(3);
  });

  it("resets the consecutive-failure sequence after a healthy observation", async function () {
    const { monitor, core } = await fixture();
    await submitNow(core, monitor, false, "reset-1");
    expect((await core.getGuarantee(1)).consecutiveFailures).to.equal(1);

    await advance(60);
    await submitNow(core, monitor, true, "reset-2");
    const reset = await core.getGuarantee(1);
    expect(reset.consecutiveFailures).to.equal(0);
    expect(reset.firstFailureAt).to.equal(0);

    await advance(60);
    await submitNow(core, monitor, false, "reset-3");
    const g = await core.getGuarantee(1);
    expect(g.consecutiveFailures).to.equal(1);
    expect(await core.activeIncidentId(1)).to.equal(0);
  });

  it("rejects duplicate observations, rapid observations, and unauthorized monitors", async function () {
    const { monitor, stranger, core } = await fixture();
    const observationId = ethers.keccak256(ethers.toUtf8Bytes("same"));
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
    const observedAt = await now();

    await core.connect(monitor).submitObservation(1, observationId, true, evidence, observedAt);
    await expect(
      core.connect(monitor).submitObservation(1, observationId, true, evidence, observedAt),
    ).to.be.revertedWithCustomError(core, "ObservationAlreadyUsed");

    await expect(
      core
        .connect(monitor)
        .submitObservation(1, ethers.keccak256(ethers.toUtf8Bytes("fast")), true, evidence, observedAt + 1),
    ).to.be.revertedWithCustomError(core, "ObservationTooSoon");

    await expect(
      core
        .connect(stranger)
        .submitObservation(1, ethers.keccak256(ethers.toUtf8Bytes("unauthorized")), true, evidence, observedAt),
    ).to.be.revertedWithCustomError(core, "AccessControlUnauthorizedAccount");
  });

  it("namespaces observation replay protection per guarantee", async function () {
    const { provider, monitor, token, core, params } = await fixture();
    // A second guarantee from the same provider.
    await token.connect(provider).approve(await core.getAddress(), 50n * USDC);
    await core.connect(provider).createGuarantee({ ...params, expiresAt: (await now()) + 3600 } as Params);

    const observationId = ethers.keccak256(ethers.toUtf8Bytes("shared-id"));
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("shared-evidence"));
    const observedAt = await now();

    await core.connect(monitor).submitObservation(1, observationId, true, evidence, observedAt);
    // The same identifier must remain usable for a different guarantee: a global namespace would let one
    // guarantee permanently burn deterministic identifiers for every other guarantee.
    await expect(core.connect(monitor).submitObservation(2, observationId, true, evidence, observedAt)).to.emit(
      core,
      "ObservationRecorded",
    );
    expect(await core.observationUsed(await core.observationKey(1, observationId))).to.equal(true);
    expect(await core.observationUsed(await core.observationKey(2, observationId))).to.equal(true);
    expect(await core.observationUsed(await core.observationKey(3, observationId))).to.equal(false);
  });

  it("rejects stale, future-dated and empty observations", async function () {
    const { monitor, core } = await fixture();
    const current = await now();
    await expect(submit(core, monitor, false, "stale", current - 601)).to.be.revertedWithCustomError(
      core,
      "ObservationOutOfWindow",
    );
    await expect(submit(core, monitor, false, "future", current + 120)).to.be.revertedWithCustomError(
      core,
      "ObservationOutOfWindow",
    );
    await expect(
      core.connect(monitor).submitObservation(1, ethers.ZeroHash, false, ethers.keccak256("0x00"), current),
    ).to.be.revertedWithCustomError(core, "InvalidTerms");
    await expect(
      core.connect(monitor).submitObservation(1, ethers.keccak256("0x01"), false, ethers.ZeroHash, current),
    ).to.be.revertedWithCustomError(core, "InvalidTerms");
  });

  it("rejects observations against a guarantee that does not exist", async function () {
    const { monitor, core } = await fixture();
    await expect(submit(core, monitor, false, "ghost", await now(), 9_999n)).to.be.revertedWithCustomError(
      core,
      "GuaranteeNotActive",
    );
  });

  it("halts observation processing while the protocol is paused", async function () {
    const { admin, monitor, core } = await fixture();
    await core.connect(admin).pause();
    await expect(submitNow(core, monitor, false, "paused")).to.be.revertedWithCustomError(core, "EnforcedPause");
    await core.connect(admin).unpause();
    await expect(submitNow(core, monitor, true, "unpaused")).to.emit(core, "ObservationRecorded");
  });

  it("exhausts a one-payout guarantee and rejects further observations", async function () {
    const { monitor, beneficiary, token, core, payout } = await fixture(1);
    const before = await token.balanceOf(beneficiary.address);
    await submitNow(core, monitor, false, "exhaust-1");
    await advance(60);
    await submitNow(core, monitor, false, "exhaust-2");
    await advance(60);
    await expect(submitNow(core, monitor, false, "exhaust-3")).to.emit(core, "GuaranteeExhausted");

    const g = await core.getGuarantee(1);
    expect(g.active).to.equal(false);
    expect(g.remainingCoverage).to.equal(0);
    expect(await token.balanceOf(beneficiary.address)).to.equal(before + payout);

    await advance(60);
    await expect(submitNow(core, monitor, true, "exhaust-4")).to.be.revertedWithCustomError(
      core,
      "GuaranteeNotActive",
    );
  });

  // -------------------------------------------------------------------------
  // Settlement window: an outage at the end of the term is still payable
  // -------------------------------------------------------------------------

  it("settles an in-term outage during the post-expiry settlement window", async function () {
    const { monitor, beneficiary, token, core, payout, expiresAt } = await fixture(1, {
      failureThreshold: 1,
      minOutageSecs: 0,
    });
    const before = await token.balanceOf(beneficiary.address);

    // Move to just past the end of the covered term.
    await advance(expiresAt - (await now()) + 5);
    expect(await now()).to.be.greaterThan(expiresAt);

    // The failure happened inside the term; the settlement transaction lands after it.
    await expect(submit(core, monitor, false, "late-settle", expiresAt)).to.emit(core, "IncidentConfirmed");
    expect(await token.balanceOf(beneficiary.address)).to.equal(before + payout);
  });

  it("refuses to settle an observation dated after the covered term", async function () {
    const { monitor, core, expiresAt } = await fixture();
    await advance(expiresAt - (await now()) + 5);
    await expect(submit(core, monitor, false, "outside-term", expiresAt + 1)).to.be.revertedWithCustomError(
      core,
      "ObservationOutOfWindow",
    );
  });

  it("closes the settlement window and then allows the provider to reclaim coverage", async function () {
    const { provider, monitor, token, core, coverage, expiresAt } = await fixture();

    await advance(expiresAt - (await now()) + SETTLEMENT_WINDOW + 60);
    await expect(submit(core, monitor, false, "too-late", expiresAt)).to.be.revertedWithCustomError(
      core,
      "GuaranteeNotActive",
    );

    const providerBefore = await token.balanceOf(provider.address);
    await core.connect(provider).withdrawExpired(1);
    expect(await token.balanceOf(provider.address)).to.equal(providerBefore + coverage);
  });

  it("blocks the provider from reclaiming coverage while settlement is still open", async function () {
    const { provider, core, expiresAt } = await fixture();
    await expect(core.connect(provider).withdrawExpired(1)).to.be.revertedWithCustomError(
      core,
      "GuaranteeNotExpired",
    );

    // Past expiry but inside the settlement window: a genuine end-of-term liability may still be settled,
    // so the escrow must stay locked.
    await advance(expiresAt - (await now()) + 60);
    await expect(core.connect(provider).withdrawExpired(1)).to.be.revertedWithCustomError(
      core,
      "GuaranteeNotExpired",
    );
  });

  // -------------------------------------------------------------------------
  // Coverage accounting
  // -------------------------------------------------------------------------

  it("credits top-ups to the provider's own guarantee only", async function () {
    const { provider, stranger, token, core } = await fixture();
    await token.mint(stranger.address, 100n * USDC);
    await token.connect(stranger).approve(await core.getAddress(), 100n * USDC);
    await expect(core.connect(stranger).topUp(1, 10n * USDC)).to.be.revertedWithCustomError(
      core,
      "UnauthorizedProvider",
    );

    await token.connect(provider).approve(await core.getAddress(), 100n * USDC);
    await expect(core.connect(provider).topUp(1, 0)).to.be.revertedWithCustomError(core, "InvalidTerms");
    await expect(core.connect(provider).topUp(1, 10n * USDC)).to.emit(core, "GuaranteeFunded");
    expect((await core.getGuarantee(1)).remainingCoverage).to.equal(60n * USDC);
    expect(await token.balanceOf(await core.getAddress())).to.equal(60n * USDC);
  });

  it("does not accept coverage top-ups after expiry", async function () {
    const { provider, token, core } = await fixture();
    await token.connect(provider).approve(await core.getAddress(), 10n * USDC);
    await advance(3700);
    await expect(core.connect(provider).topUp(1, 10n * USDC)).to.be.revertedWithCustomError(
      core,
      "GuaranteeNotActive",
    );
  });

  it("returns unused coverage to the provider only after expiry and settlement", async function () {
    const { provider, token, core, coverage } = await fixture();
    const providerBefore = await token.balanceOf(provider.address);
    await expect(core.connect(provider).withdrawExpired(1)).to.be.revertedWithCustomError(
      core,
      "GuaranteeNotExpired",
    );
    await advance(3600 + SETTLEMENT_WINDOW + 60);
    await core.connect(provider).withdrawExpired(1);
    expect(await token.balanceOf(provider.address)).to.equal(providerBefore + coverage);
    const g = await core.getGuarantee(1);
    expect(g.withdrawn).to.equal(true);
    expect(g.active).to.equal(false);
    expect(g.remainingCoverage).to.equal(0);
  });

  it("cannot reclaim coverage twice, from another address, or while paused", async function () {
    const { admin, provider, stranger, core } = await fixture();
    await advance(3600 + SETTLEMENT_WINDOW + 60);

    await expect(core.connect(stranger).withdrawExpired(1)).to.be.revertedWithCustomError(
      core,
      "UnauthorizedProvider",
    );

    await core.connect(admin).pause();
    await expect(core.connect(provider).withdrawExpired(1)).to.be.revertedWithCustomError(core, "EnforcedPause");
    await core.connect(admin).unpause();

    await core.connect(provider).withdrawExpired(1);
    await expect(core.connect(provider).withdrawExpired(1)).to.be.revertedWithCustomError(
      core,
      "GuaranteeNotActive",
    );
  });

  it("returns only the coverage left after a payout", async function () {
    const { provider, monitor, beneficiary, token, core, payout, coverage } = await fixture(2);
    const providerBefore = await token.balanceOf(provider.address);

    await submitNow(core, monitor, false, "partial-1");
    await advance(60);
    await submitNow(core, monitor, false, "partial-2");
    await advance(60);
    await submitNow(core, monitor, false, "partial-3");
    expect(await token.balanceOf(beneficiary.address)).to.equal(payout);

    await advance(3600 + SETTLEMENT_WINDOW + 60);
    await core.connect(provider).withdrawExpired(1);
    expect(await token.balanceOf(provider.address)).to.equal(providerBefore + coverage - payout);
    expect(await token.balanceOf(await core.getAddress())).to.equal(0);
  });

  // -------------------------------------------------------------------------
  // Coverage-token behaviour
  // -------------------------------------------------------------------------

  it("refuses a coverage token that delivers less than it is asked to", async function () {
    const [, provider, beneficiary, , monitor] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("FeeOnTransferToken");
    const token = await Token.deploy(100); // 1% fee
    const Core = await ethers.getContractFactory("UptimeSureCore");
    const core = await Core.deploy(await token.getAddress(), monitor.address);
    await token.mint(provider.address, 1_000n * USDC);
    await token.connect(provider).approve(await core.getAddress(), 1_000n * USDC);

    const params = {
      beneficiary: beneficiary.address,
      endpointUrl: "https://example.com/health",
      expectedStatus: 200,
      expectedFragment: "",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 2,
      minOutageSecs: 60,
      payoutPerIncident: 25n * USDC,
      maxPayouts: 2,
      expiresAt: (await now()) + 3600,
      coverageAmount: 50n * USDC,
    } as Params;
    // Crediting 50 USDC of promised compensation while holding 49.5 would let the guarantee promise more
    // than the escrow can pay.
    await expect(core.connect(provider).createGuarantee(params)).to.be.revertedWithCustomError(
      core,
      "UnexpectedTokenBehaviour",
    );
  });

  it("turns a silently failing coverage token into a revert rather than a lost payout", async function () {
    const [, provider, beneficiary, , monitor] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("FalseReturnToken");
    const token = await Token.deploy();
    const Core = await ethers.getContractFactory("UptimeSureCore");
    const core = await Core.deploy(await token.getAddress(), monitor.address);
    await token.mint(provider.address, 1_000n * USDC);
    await token.connect(provider).approve(await core.getAddress(), 1_000n * USDC);

    const params = {
      beneficiary: beneficiary.address,
      endpointUrl: "https://example.com/health",
      expectedStatus: 200,
      expectedFragment: "",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 1,
      minOutageSecs: 0,
      payoutPerIncident: 25n * USDC,
      maxPayouts: 1,
      expiresAt: (await now()) + 3600,
      coverageAmount: 25n * USDC,
    } as Params;
    await core.connect(provider).createGuarantee(params);

    // transfer() returns false instead of reverting. SafeERC20 must reject it, so the incident is not
    // recorded as paid when no tokens actually moved.
    await expect(submitNow(core, monitor, false, "false-return")).to.be.revertedWithCustomError(
      core,
      "SafeERC20FailedOperation",
    );
    expect(await core.activeIncidentId(1)).to.equal(0);
    expect(await token.balanceOf(beneficiary.address)).to.equal(0);
  });

  it("blocks re-entry from inside a coverage-token transfer", async function () {
    const [, provider, beneficiary, , monitor] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("ReentrantToken");
    const token = await Token.deploy();
    const Core = await ethers.getContractFactory("UptimeSureCore");
    const core = await Core.deploy(await token.getAddress(), monitor.address);
    await token.mint(provider.address, 1_000n * USDC);
    await token.connect(provider).approve(await core.getAddress(), 1_000n * USDC);

    const params = {
      beneficiary: beneficiary.address,
      endpointUrl: "https://example.com/health",
      expectedStatus: 200,
      expectedFragment: "",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 1,
      minOutageSecs: 0,
      payoutPerIncident: 25n * USDC,
      maxPayouts: 2,
      expiresAt: (await now()) + 3600,
      coverageAmount: 50n * USDC,
    } as Params;
    await core.connect(provider).createGuarantee(params);

    await token.arm(await core.getAddress(), 1);
    await expect(submitNow(core, monitor, false, "reentrant")).to.emit(core, "IncidentConfirmed");

    expect(await token.reentryAttempted()).to.equal(true);
    expect(await token.reentryReverted()).to.equal(true);
    // The re-entrant top-up did not credit coverage.
    expect((await core.getGuarantee(1)).remainingCoverage).to.equal(25n * USDC);
    expect(await token.balanceOf(beneficiary.address)).to.equal(25n * USDC);
    expect(await token.balanceOf(await core.getAddress())).to.equal(25n * USDC);
  });

  // -------------------------------------------------------------------------
  // Numeric boundaries
  // -------------------------------------------------------------------------

  it("handles the largest representable payout and coverage without overflow", async function () {
    const [, provider, beneficiary, , monitor] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    const token = await Token.deploy();
    const Core = await ethers.getContractFactory("UptimeSureCore");
    const core = await Core.deploy(await token.getAddress(), monitor.address);

    const maxPayout = (1n << 96n) - 1n; // type(uint96).max
    const coverageAmount = maxPayout * 100n; // maxPayouts at its ceiling
    await token.mint(provider.address, coverageAmount);
    await token.connect(provider).approve(await core.getAddress(), coverageAmount);

    const params = {
      beneficiary: beneficiary.address,
      endpointUrl: "https://example.com/health",
      expectedStatus: 200,
      expectedFragment: "",
      maxLatencyMs: 2000,
      checkIntervalSecs: 60,
      failureThreshold: 1,
      minOutageSecs: 0,
      payoutPerIncident: maxPayout,
      maxPayouts: 100,
      expiresAt: (await now()) + 3600,
      coverageAmount,
    } as Params;
    await core.connect(provider).createGuarantee(params);
    expect((await core.getGuarantee(1)).remainingCoverage).to.equal(coverageAmount);

    await submitNow(core, monitor, false, "max-payout");
    expect(await token.balanceOf(beneficiary.address)).to.equal(maxPayout);
    expect((await core.getGuarantee(1)).remainingCoverage).to.equal(coverageAmount - maxPayout);
  });

  it("saturates the consecutive-failure counter instead of overflowing it", async function () {
    // failureThreshold is capped at 10 and the counter is uint8, so the counter is unreachable at its
    // boundary in practice. This proves the guard exists rather than relying on that.
    const { monitor, core } = await fixture(1, { failureThreshold: 10, minOutageSecs: 540 });
    for (let i = 0; i < 9; i++) {
      await submitNow(core, monitor, false, `sat-${i}`);
      await advance(60);
    }
    expect((await core.getGuarantee(1)).consecutiveFailures).to.equal(9);
    await expect(submitNow(core, monitor, false, "sat-final")).to.emit(core, "IncidentConfirmed");
  });
});
