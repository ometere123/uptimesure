import { describe, expect, it } from "vitest";
import { divergences, type OnchainGuarantee, withdrawableAt } from "./onchain";
import type { GuaranteeRow } from "./types";

const EXPIRY_ISO = "2026-09-01T00:00:00+00:00";
const EXPIRY_SECS = BigInt(Math.floor(Date.parse(EXPIRY_ISO) / 1000));

/** A contract read and an index row that agree on every value that matters financially. */
function pair(): { chain: OnchainGuarantee; indexed: GuaranteeRow } {
  const chain: OnchainGuarantee = {
    provider: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
    beneficiary: "0xdD2FD4581271e230360230F9337D5c0430Bf44C0",
    endpointUrl: "https://api.example.com/health",
    criteriaHash: `0x${"c".repeat(64)}`,
    expectedStatus: 200,
    expectedFragment: "ok",
    maxLatencyMs: 2000,
    checkIntervalSecs: 300,
    failureThreshold: 3,
    minOutageSecs: 900,
    payoutPerIncident: 25_000_000n,
    maxPayouts: 4,
    paidPayouts: 1,
    remainingCoverage: 75_000_000n,
    createdAt: 1_760_000_000n,
    expiresAt: EXPIRY_SECS,
    firstFailureAt: 0n,
    lastObservedAt: 1_760_000_600n,
    consecutiveFailures: 0,
    active: true,
    withdrawn: false,
    exhausted: false,
  };

  const indexed: GuaranteeRow = {
    id: 7,
    chain_id: 84532,
    contract_address: "0x1111111111111111111111111111111111111111",
    provider: chain.provider,
    beneficiary: chain.beneficiary,
    endpoint_url: chain.endpointUrl,
    criteria_hash: chain.criteriaHash,
    expected_status: 200,
    expected_fragment: "ok",
    max_latency_ms: 2000,
    check_interval_seconds: 300,
    failure_threshold: 3,
    min_outage_seconds: 900,
    payout_per_incident: "25000000",
    max_payouts: 4,
    paid_payouts: 1,
    remaining_coverage: "75000000",
    created_at: "2025-10-09T07:33:20+00:00",
    expires_at: EXPIRY_ISO,
    first_failure_at: null,
    last_observed_at: "2025-10-09T07:43:20+00:00",
    consecutive_failures: 0,
    active: true,
    exhausted: false,
    withdrawn: false,
    next_check_at: "2025-10-09T07:48:20+00:00",
    updated_at: "2025-10-09T07:43:20+00:00",
  };

  return { chain, indexed };
}

describe("withdrawableAt", () => {
  it("opens strictly after the settlement window, because the contract compares with >", () => {
    // withdrawExpired requires block.timestamp > expiresAt + SETTLEMENT_WINDOW. Returning the boundary itself
    // would enable the button on the one second where the call still reverts.
    expect(withdrawableAt(1_000_000, 1800)).toBe(1_001_801);
  });

  it("does not open at expiry", () => {
    const expiry = 1_000_000;
    expect(withdrawableAt(expiry, 1800)).toBeGreaterThan(expiry + 1800);
  });

  it("still requires one second past expiry when the window is zero", () => {
    expect(withdrawableAt(1_000_000, 0)).toBe(1_000_001);
  });
});

describe("divergences", () => {
  it("reports nothing when the index is faithful", () => {
    const { chain, indexed } = pair();
    expect(divergences(chain, indexed)).toEqual([]);
  });

  it("catches a stale remaining coverage", () => {
    const { chain, indexed } = pair();
    indexed.remaining_coverage = "100000000";
    expect(divergences(chain, indexed)).toEqual([
      "remaining coverage: contract 75000000, index 100000000",
    ]);
  });

  it("catches a missed payout", () => {
    const { chain, indexed } = pair();
    indexed.paid_payouts = 0;
    expect(divergences(chain, indexed)).toEqual(["paid incidents: contract 1, index 0"]);
  });

  it("catches a stale failure counter", () => {
    const { chain, indexed } = pair();
    chain.consecutiveFailures = 2;
    expect(divergences(chain, indexed)).toEqual(["consecutive failures: contract 2, index 0"]);
  });

  it("catches an index that still believes coverage is live", () => {
    const { chain, indexed } = pair();
    chain.active = false;
    chain.withdrawn = true;
    expect(divergences(chain, indexed)).toEqual([
      "active: contract false, index true",
      "withdrawn: contract true, index false",
    ]);
  });

  it("catches a rewritten payout amount", () => {
    const { chain, indexed } = pair();
    indexed.payout_per_incident = "1";
    expect(divergences(chain, indexed)).toEqual(["payout per incident: contract 25000000, index 1"]);
  });

  it("catches a redirected beneficiary", () => {
    const { chain, indexed } = pair();
    indexed.beneficiary = "0x0000000000000000000000000000000000000001";
    expect(divergences(chain, indexed)).toEqual([
      "beneficiary: contract 0xdd2fd4581271e230360230f9337d5c0430bf44c0, " +
        "index 0x0000000000000000000000000000000000000001",
    ]);
  });

  it("catches a swapped endpoint, which would invalidate every observation", () => {
    const { chain, indexed } = pair();
    indexed.endpoint_url = "https://api.example.com/healthz";
    expect(divergences(chain, indexed)).toEqual([
      "endpoint: contract https://api.example.com/health, index https://api.example.com/healthz",
    ]);
  });

  it("catches a shifted expiry", () => {
    const { chain, indexed } = pair();
    indexed.expires_at = "2026-09-02T00:00:00+00:00";
    expect(divergences(chain, indexed)).toEqual([
      `expiry: contract ${EXPIRY_SECS}, index ${EXPIRY_SECS + 86_400n}`,
    ]);
  });

  it("treats address checksum casing as agreement, not drift", () => {
    // PostgREST returns whatever the indexer inserted; the contract returns EIP-55 checksummed hex. Comparing
    // raw strings would flag every healthy guarantee as diverged and train providers to ignore the warning.
    const { chain, indexed } = pair();
    indexed.provider = chain.provider.toLowerCase();
    indexed.beneficiary = chain.beneficiary.toUpperCase().replace("0X", "0x");
    expect(divergences(chain, indexed)).toEqual([]);
  });

  it("ignores sub-second precision in the indexed expiry", () => {
    // The contract stores whole seconds. A timestamptz that round-trips with milliseconds is the same instant.
    const { chain, indexed } = pair();
    indexed.expires_at = "2026-09-01T00:00:00.499+00:00";
    expect(divergences(chain, indexed)).toEqual([]);
  });

  it("reports every diverged field at once rather than only the first", () => {
    const { chain, indexed } = pair();
    indexed.remaining_coverage = "0";
    indexed.paid_payouts = 4;
    indexed.active = false;
    expect(divergences(chain, indexed)).toHaveLength(3);
  });
});
