/**
 * Guarantee policy validation, mirroring `UptimeSureCore._validateCreateParams`.
 *
 * Every rule here exists in the contract too. The contract is authoritative — this module cannot make an
 * invalid guarantee valid — but a revert costs gas and tells the user only `InvalidTerms()`, so the same rules
 * are checked before signing and reported against the specific field that broke them.
 *
 * Kept free of React and of `window` so it can be unit-tested directly, and so a drift between these bounds and
 * the contract's shows up as a failing test rather than as a failed transaction.
 */

/** Contract bounds. Changing one here without changing the contract is a bug the tests are meant to catch. */
export const LIMITS = {
  endpointMinLength: 12,
  endpointMaxLength: 512,
  fragmentMaxLength: 128,
  statusMin: 100,
  statusMax: 599,
  latencyMinMs: 100,
  latencyMaxMs: 30_000,
  checkIntervalMinSecs: 60,
  checkIntervalMaxSecs: 86_400,
  failureThresholdMin: 1,
  failureThresholdMax: 10,
  minOutageMaxSecs: 7 * 24 * 60 * 60,
  maxPayoutsMin: 1,
  maxPayoutsMax: 100,
  maxTermSecs: 366 * 24 * 60 * 60,
} as const;

export const USDC_DECIMALS = 6;

export interface GuaranteeFormValues {
  beneficiary: string;
  endpointUrl: string;
  expectedStatus: number;
  expectedFragment: string;
  maxLatencyMs: number;
  checkIntervalSecs: number;
  failureThreshold: number;
  minOutageSecs: number;
  /** Decimal USDC string as typed, e.g. "25.5". */
  payoutPerIncident: string;
  maxPayouts: number;
  /** Term length in days, converted to an absolute `expiresAt` at submission. */
  termDays: number;
  /** Decimal USDC string as typed. Must cover the full potential liability. */
  coverageAmount: string;
}

/** A validation failure, keyed by form field so the UI can put the message next to the input that caused it. */
export interface FieldError {
  field: keyof GuaranteeFormValues;
  message: string;
}

export function isAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/**
 * Lowercases a well-formed address, or returns null.
 *
 * Used before any value reaches a PostgREST filter. `.or()` takes a comma-separated expression string, so an
 * unvalidated address would be a filter-injection surface; refusing anything that is not 42 hex characters
 * removes the possibility rather than trying to escape it. Lowercasing matches how the indexer stores addresses.
 */
export function normalizeAddress(value: string | null | undefined): `0x${string}` | null {
  if (!value) return null;
  const trimmed = value.trim();
  return isAddress(trimmed) ? (trimmed.toLowerCase() as `0x${string}`) : null;
}

/**
 * Rejects any character the contract's `_isMonitorableUrl` rejects.
 *
 * The contract excludes control characters, non-ASCII, and the set that makes a URL ambiguous to parse or lets
 * credentials or a shell-ish payload hide inside it (`@ \ " < > ^ ` { } |`). An endpoint that fails here would
 * revert with `InvalidEndpoint()`, and would also be refused by the monitor's target policy.
 */
export function firstIllegalEndpointChar(url: string): string | null {
  for (const char of url) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code >= 0x7f) return char;
    if ("@\\\"<>^`{}|".includes(char)) return char;
  }
  return null;
}

/**
 * Parses a decimal USDC amount into base units without going through a float.
 *
 * `Number("0.07") * 1e6` is 70000.00000000001. Money is parsed as text and assembled as a BigInt so a typed
 * amount always becomes the exact base-unit value the contract will hold.
 */
export function parseUsdc(input: string): { value: bigint } | { error: string } {
  const trimmed = input.trim();
  if (trimmed === "") return { error: "Enter an amount." };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { error: "Use digits and at most one decimal point." };

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > USDC_DECIMALS) {
    return { error: `USDC has ${USDC_DECIMALS} decimal places; ${fraction.length} were given.` };
  }
  const value = BigInt(whole + fraction.padEnd(USDC_DECIMALS, "0"));
  if (value === 0n) return { error: "Amount must be greater than zero." };
  return { value };
}

/** Formats base units back into a plain decimal string (no unit suffix), for prefilling an input. */
export function formatUsdcInput(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** The smallest outage the contract will accept for a given cadence and threshold. */
export function minimumOutageFor(checkIntervalSecs: number, failureThreshold: number): number {
  return checkIntervalSecs * Math.max(failureThreshold - 1, 0);
}

/** Total amount that could ever be paid out, and therefore the minimum coverage the contract requires. */
export function fullLiability(payoutPerIncident: bigint, maxPayouts: number): bigint {
  return payoutPerIncident * BigInt(maxPayouts);
}

function requireInteger(value: number, field: keyof GuaranteeFormValues, label: string): FieldError | null {
  if (!Number.isFinite(value)) return { field, message: `${label} must be a number.` };
  if (!Number.isInteger(value)) return { field, message: `${label} must be a whole number.` };
  return null;
}

/**
 * Validates a completed create-guarantee form.
 *
 * Returns every failure rather than the first, so a user fixing a form sees all of it at once instead of
 * discovering one problem per submission.
 */
export function validateGuaranteeForm(
  values: GuaranteeFormValues,
  nowSeconds: number,
): { ok: true; payout: bigint; coverage: bigint; expiresAt: bigint } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];

  if (!isAddress(values.beneficiary)) {
    errors.push({ field: "beneficiary", message: "Enter a 42-character 0x address." });
  } else if (/^0x0{40}$/i.test(values.beneficiary.trim())) {
    // The contract rejects the zero address: compensation sent there would be unrecoverable.
    errors.push({ field: "beneficiary", message: "The zero address cannot receive compensation." });
  }

  const endpoint = values.endpointUrl.trim();
  if (!endpoint.startsWith("https://")) {
    errors.push({ field: "endpointUrl", message: "The endpoint must be an https:// URL." });
  } else if (endpoint.length < LIMITS.endpointMinLength || endpoint.length > LIMITS.endpointMaxLength) {
    errors.push({
      field: "endpointUrl",
      message: `The endpoint must be ${LIMITS.endpointMinLength}-${LIMITS.endpointMaxLength} characters.`,
    });
  } else {
    const illegal = firstIllegalEndpointChar(endpoint);
    if (illegal !== null) {
      errors.push({
        field: "endpointUrl",
        message: `The endpoint cannot contain ${JSON.stringify(illegal)}.`,
      });
    }
  }

  if (values.expectedFragment.length > LIMITS.fragmentMaxLength) {
    errors.push({
      field: "expectedFragment",
      message: `The body fragment must be at most ${LIMITS.fragmentMaxLength} characters.`,
    });
  }

  const integerChecks: [number, keyof GuaranteeFormValues, string][] = [
    [values.expectedStatus, "expectedStatus", "Expected status"],
    [values.maxLatencyMs, "maxLatencyMs", "Maximum latency"],
    [values.checkIntervalSecs, "checkIntervalSecs", "Check interval"],
    [values.failureThreshold, "failureThreshold", "Failure threshold"],
    [values.minOutageSecs, "minOutageSecs", "Minimum outage"],
    [values.maxPayouts, "maxPayouts", "Maximum incidents"],
    [values.termDays, "termDays", "Term"],
  ];
  for (const [value, field, label] of integerChecks) {
    const error = requireInteger(value, field, label);
    if (error) errors.push(error);
  }

  if (values.expectedStatus < LIMITS.statusMin || values.expectedStatus > LIMITS.statusMax) {
    errors.push({
      field: "expectedStatus",
      message: `Expected status must be between ${LIMITS.statusMin} and ${LIMITS.statusMax}.`,
    });
  }
  if (values.maxLatencyMs < LIMITS.latencyMinMs || values.maxLatencyMs > LIMITS.latencyMaxMs) {
    errors.push({
      field: "maxLatencyMs",
      message: `Maximum latency must be between ${LIMITS.latencyMinMs}ms and ${LIMITS.latencyMaxMs}ms.`,
    });
  }
  if (
    values.checkIntervalSecs < LIMITS.checkIntervalMinSecs ||
    values.checkIntervalSecs > LIMITS.checkIntervalMaxSecs
  ) {
    errors.push({
      field: "checkIntervalSecs",
      message: `Check cadence must be between ${LIMITS.checkIntervalMinSecs}s and ${LIMITS.checkIntervalMaxSecs}s.`,
    });
  }
  if (
    values.failureThreshold < LIMITS.failureThresholdMin ||
    values.failureThreshold > LIMITS.failureThresholdMax
  ) {
    errors.push({
      field: "failureThreshold",
      message: `Failure threshold must be between ${LIMITS.failureThresholdMin} and ${LIMITS.failureThresholdMax}.`,
    });
  }

  // The contract enforces minOutage >= interval * (threshold - 1): a shorter window would be unreachable,
  // because that much time must pass before the threshold-th consecutive failure can even be observed.
  const minimumOutage = minimumOutageFor(values.checkIntervalSecs, values.failureThreshold);
  if (values.minOutageSecs < minimumOutage) {
    errors.push({
      field: "minOutageSecs",
      message: `With ${values.failureThreshold} failures at ${values.checkIntervalSecs}s apart, the minimum outage cannot be below ${minimumOutage}s.`,
    });
  }
  if (values.minOutageSecs > LIMITS.minOutageMaxSecs) {
    errors.push({ field: "minOutageSecs", message: "The minimum outage cannot exceed 7 days." });
  }

  if (values.maxPayouts < LIMITS.maxPayoutsMin || values.maxPayouts > LIMITS.maxPayoutsMax) {
    errors.push({
      field: "maxPayouts",
      message: `Maximum incidents must be between ${LIMITS.maxPayoutsMin} and ${LIMITS.maxPayoutsMax}.`,
    });
  }

  const payoutParsed = parseUsdc(values.payoutPerIncident);
  if ("error" in payoutParsed) errors.push({ field: "payoutPerIncident", message: payoutParsed.error });

  const coverageParsed = parseUsdc(values.coverageAmount);
  if ("error" in coverageParsed) errors.push({ field: "coverageAmount", message: coverageParsed.error });

  // The contract requires the term to outlast at least one full check interval, so a guarantee always has a
  // chance to be observed before it expires.
  const termSecs = values.termDays * 24 * 60 * 60;
  if (termSecs <= values.checkIntervalSecs) {
    errors.push({ field: "termDays", message: "The term must be longer than one check interval." });
  }
  if (termSecs > LIMITS.maxTermSecs) {
    errors.push({ field: "termDays", message: "The term cannot exceed 366 days." });
  }

  if ("value" in payoutParsed && "value" in coverageParsed) {
    const liability = fullLiability(payoutParsed.value, values.maxPayouts);
    if (coverageParsed.value < liability) {
      errors.push({
        field: "coverageAmount",
        message: `Coverage must fund every incident it promises: ${formatUsdcInput(liability)} USDC for ${values.maxPayouts} × ${formatUsdcInput(payoutParsed.value)} USDC.`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    payout: (payoutParsed as { value: bigint }).value,
    coverage: (coverageParsed as { value: bigint }).value,
    expiresAt: BigInt(nowSeconds + termSecs),
  };
}
