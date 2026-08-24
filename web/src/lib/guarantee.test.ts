import { describe, expect, it } from "vitest";
import { buildOperatorCommand, rloToKelvin, validateGuarantee, type GuaranteeDraft } from "./guarantee";

const valid: GuaranteeDraft = {
  serviceName: "Payments API",
  endpointUrl: "https://example.com/health",
  expectedFragment: "ok",
  beneficiary: "beneficiary-pubkey",
  intervalSeconds: "30",
  failureThreshold: "3",
  compensationRlo: "0.05",
  maxPayouts: "5",
};

describe("guarantee helpers", () => {
  it("converts RLO to kelvin exactly", () => {
    expect(rloToKelvin("1.000000001")).toBe(1_000_000_001n);
    expect(rloToKelvin("0.05")).toBe(50_000_000n);
  });

  it("rejects local and insecure endpoints", () => {
    expect(validateGuarantee({ ...valid, endpointUrl: "http://example.com" })).toContain("Endpoint must use HTTPS.");
    expect(validateGuarantee({ ...valid, endpointUrl: "https://127.0.0.1/health" })).toContain(
      "Private, loopback and link-local endpoints are not allowed.",
    );
  });

  it("builds a real Venus invocation command", () => {
    const command = buildOperatorCommand(valid, "program-id");
    expect(command).toContain("--function create_guarantee");
    expect(command).toContain("--arg compensation_kelvin=50000000");
    expect(command).toContain("'https://example.com/health'");
  });
});
