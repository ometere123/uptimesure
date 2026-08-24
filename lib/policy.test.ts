import { describe, expect, it } from "vitest";
import {
  firstIllegalEndpointChar,
  formatUsdcInput,
  fullLiability,
  isAddress,
  LIMITS,
  minimumOutageFor,
  normalizeAddress,
  parseUsdc,
  validateGuaranteeForm,
  type GuaranteeFormValues,
} from "./policy";

const NOW = 1_800_000_000;

/** A form the contract would accept, used as the baseline every case below mutates one field of. */
const VALID: GuaranteeFormValues = {
  beneficiary: "0x1111111111111111111111111111111111111111",
  endpointUrl: "https://status.example.com/health",
  expectedStatus: 200,
  expectedFragment: "",
  maxLatencyMs: 2_000,
  checkIntervalSecs: 300,
  failureThreshold: 3,
  minOutageSecs: 900,
  payoutPerIncident: "25",
  maxPayouts: 4,
  termDays: 30,
  coverageAmount: "100",
};

function errorsFor(overrides: Partial<GuaranteeFormValues>): string[] {
  const result = validateGuaranteeForm({ ...VALID, ...overrides }, NOW);
  return result.ok ? [] : result.errors.map((e) => `${e.field}:${e.message}`);
}

function fieldsFor(overrides: Partial<GuaranteeFormValues>): string[] {
  const result = validateGuaranteeForm({ ...VALID, ...overrides }, NOW);
  return result.ok ? [] : result.errors.map((e) => e.field);
}

describe("parseUsdc", () => {
  it("converts a decimal amount to base units without floating point drift", () => {
    // Number("0.07") * 1e6 is 70000.00000000001. Money must not round-trip through a float.
    expect(parseUsdc("0.07")).toEqual({ value: 70_000n });
    expect(parseUsdc("1")).toEqual({ value: 1_000_000n });
    expect(parseUsdc("1.5")).toEqual({ value: 1_500_000n });
    expect(parseUsdc("0.000001")).toEqual({ value: 1n });
    expect(parseUsdc("1234567.891234")).toEqual({ value: 1_234_567_891_234n });
  });

  it("refuses anything that is not a plain positive decimal", () => {
    for (const input of ["", "  ", "-1", "1e6", "1,5", "abc", "1.2.3", "0x10", "+1", ".5"]) {
      expect(parseUsdc(input), input).toHaveProperty("error");
    }
  });

  it("refuses more precision than USDC can hold rather than silently truncating", () => {
    // Truncating would fund less coverage than the user typed and read back as a different number.
    expect(parseUsdc("1.1234567")).toEqual({ error: "USDC has 6 decimal places; 7 were given." });
  });

  it("refuses zero, which the contract rejects as a payout", () => {
    expect(parseUsdc("0")).toEqual({ error: "Amount must be greater than zero." });
    expect(parseUsdc("0.000000")).toEqual({ error: "Amount must be greater than zero." });
  });

  it("round-trips through formatUsdcInput", () => {
    for (const input of ["1", "1.5", "0.07", "0.000001", "1234567.891234"]) {
      const parsed = parseUsdc(input);
      expect(parsed).toHaveProperty("value");
      expect(parseUsdc(formatUsdcInput((parsed as { value: bigint }).value))).toEqual(parsed);
    }
  });
});

describe("address handling", () => {
  it("accepts a 42-character hex address in any case", () => {
    expect(isAddress("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01")).toBe(true);
    expect(isAddress("0xabcdef0123456789abcdef0123456789abcdef01")).toBe(true);
  });

  it("rejects wrong lengths, missing prefix, and non-hex characters", () => {
    for (const value of [
      "0x123",
      "abcdef0123456789abcdef0123456789abcdef01",
      "0xzzcdef0123456789abcdef0123456789abcdef01",
      "0xabcdef0123456789abcdef0123456789abcdef012",
      "",
    ]) {
      expect(isAddress(value), value).toBe(false);
    }
  });

  it("normalizeAddress lowercases a valid address and returns null for anything else", () => {
    expect(normalizeAddress(" 0xAbCdEf0123456789AbCdEf0123456789AbCdEf01 ")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
    expect(normalizeAddress(null)).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress("not-an-address")).toBeNull();
  });

  it("normalizeAddress refuses values that could inject into a PostgREST filter expression", () => {
    // The dashboard interpolates the connected address into `.or('provider.eq.X,beneficiary.eq.X')`.
    // Anything containing a comma, a dot, or a parenthesis must never reach that string.
    for (const value of [
      "0x1111111111111111111111111111111111111111,provider.neq.null",
      "provider.eq.*",
      "0x1111'",
      "*",
    ]) {
      expect(normalizeAddress(value), value).toBeNull();
    }
  });
});

describe("firstIllegalEndpointChar", () => {
  it("passes an ordinary https URL", () => {
    expect(firstIllegalEndpointChar("https://status.example.com/health?probe=1")).toBeNull();
  });

  it("catches every character class the contract rejects", () => {
    // Mirrors UptimeSureCore._isMonitorableUrl: control chars, non-ASCII, and the ambiguity/credential set.
    expect(firstIllegalEndpointChar("https://user@example.com/")).toBe("@");
    expect(firstIllegalEndpointChar("https://example.com/\\x")).toBe("\\");
    expect(firstIllegalEndpointChar("https://example.com/a b")).toBe(" ");
    expect(firstIllegalEndpointChar("https://exämple.com/")).toBe("ä");
    expect(firstIllegalEndpointChar("https://example.com/\n")).toBe("\n");
    for (const char of ['"', "<", ">", "^", "`", "{", "}", "|"]) {
      expect(firstIllegalEndpointChar(`https://example.com/${char}`), char).toBe(char);
    }
  });
});

describe("validateGuaranteeForm", () => {
  it("accepts a well-formed policy and returns the values the transaction needs", () => {
    const result = validateGuaranteeForm(VALID, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payout).toBe(25_000_000n);
    expect(result.coverage).toBe(100_000_000n);
    expect(result.expiresAt).toBe(BigInt(NOW + 30 * 86_400));
  });

  it("reports every broken field at once instead of one per submission", () => {
    const fields = fieldsFor({
      beneficiary: "nope",
      endpointUrl: "http://example.com/health",
      expectedStatus: 99,
      maxLatencyMs: 1,
    });
    expect(fields).toContain("beneficiary");
    expect(fields).toContain("endpointUrl");
    expect(fields).toContain("expectedStatus");
    expect(fields).toContain("maxLatencyMs");
  });

  it("rejects the zero beneficiary, whose compensation would be unrecoverable", () => {
    expect(fieldsFor({ beneficiary: `0x${"0".repeat(40)}` })).toContain("beneficiary");
  });

  it("requires https, matching the contract and the monitor's target policy", () => {
    expect(fieldsFor({ endpointUrl: "http://status.example.com/health" })).toContain("endpointUrl");
    expect(fieldsFor({ endpointUrl: "ftp://status.example.com/health" })).toContain("endpointUrl");
  });

  it("enforces the contract's endpoint length window", () => {
    expect(fieldsFor({ endpointUrl: "https://a.b" })).toContain("endpointUrl");
    expect(fieldsFor({ endpointUrl: `https://e.com/${"a".repeat(LIMITS.endpointMaxLength)}` }))
      .toContain("endpointUrl");
  });

  it("enforces each numeric bound at both edges", () => {
    expect(errorsFor({ expectedStatus: LIMITS.statusMin })).toEqual([]);
    expect(errorsFor({ expectedStatus: LIMITS.statusMax })).toEqual([]);
    expect(fieldsFor({ expectedStatus: LIMITS.statusMin - 1 })).toContain("expectedStatus");
    expect(fieldsFor({ expectedStatus: LIMITS.statusMax + 1 })).toContain("expectedStatus");

    expect(fieldsFor({ maxLatencyMs: LIMITS.latencyMinMs - 1 })).toContain("maxLatencyMs");
    expect(fieldsFor({ maxLatencyMs: LIMITS.latencyMaxMs + 1 })).toContain("maxLatencyMs");

    expect(fieldsFor({ checkIntervalSecs: LIMITS.checkIntervalMinSecs - 1, minOutageSecs: 0 }))
      .toContain("checkIntervalSecs");
    expect(fieldsFor({ checkIntervalSecs: LIMITS.checkIntervalMaxSecs + 1, minOutageSecs: 200_000 }))
      .toContain("checkIntervalSecs");

    expect(fieldsFor({ failureThreshold: 0, minOutageSecs: 0 })).toContain("failureThreshold");
    expect(fieldsFor({ failureThreshold: LIMITS.failureThresholdMax + 1, minOutageSecs: 100_000 }))
      .toContain("failureThreshold");

    expect(fieldsFor({ maxPayouts: 0, coverageAmount: "100" })).toContain("maxPayouts");
    expect(fieldsFor({ maxPayouts: LIMITS.maxPayoutsMax + 1, coverageAmount: "100000" }))
      .toContain("maxPayouts");
  });

  it("rejects fractional inputs where the contract takes an integer", () => {
    expect(fieldsFor({ checkIntervalSecs: 300.5 })).toContain("checkIntervalSecs");
    expect(fieldsFor({ failureThreshold: 2.5 })).toContain("failureThreshold");
    expect(fieldsFor({ termDays: 1.5 })).toContain("termDays");
  });

  it("requires a minimum outage the threshold can actually reach", () => {
    // 3 failures 300s apart cannot confirm an outage shorter than 600s, so the contract refuses the policy.
    expect(minimumOutageFor(300, 3)).toBe(600);
    expect(fieldsFor({ minOutageSecs: 599 })).toContain("minOutageSecs");
    expect(errorsFor({ minOutageSecs: 600 })).toEqual([]);
    expect(fieldsFor({ minOutageSecs: LIMITS.minOutageMaxSecs + 1 })).toContain("minOutageSecs");
  });

  it("treats a single-failure threshold as needing no elapsed outage", () => {
    expect(minimumOutageFor(300, 1)).toBe(0);
    expect(errorsFor({ failureThreshold: 1, minOutageSecs: 0 })).toEqual([]);
  });

  it("requires the term to outlast one check interval and stay inside the contract's maximum", () => {
    expect(fieldsFor({ termDays: 0 })).toContain("termDays");
    expect(fieldsFor({ termDays: 367 })).toContain("termDays");
    expect(errorsFor({ termDays: 366 })).toEqual([]);
  });

  it("refuses coverage that does not fund every incident it promises", () => {
    // 4 x 25 USDC = 100 USDC of liability. Anything less would let a guarantee run out mid-term.
    expect(fullLiability(25_000_000n, 4)).toBe(100_000_000n);
    const errors = errorsFor({ coverageAmount: "99.999999" });
    expect(errors.some((e) => e.startsWith("coverageAmount:"))).toBe(true);
    expect(errorsFor({ coverageAmount: "100" })).toEqual([]);
    expect(errorsFor({ coverageAmount: "250" })).toEqual([]);
  });

  it("enforces the body fragment length limit", () => {
    expect(errorsFor({ expectedFragment: "o".repeat(LIMITS.fragmentMaxLength) })).toEqual([]);
    expect(fieldsFor({ expectedFragment: "o".repeat(LIMITS.fragmentMaxLength + 1) }))
      .toContain("expectedFragment");
  });
});
