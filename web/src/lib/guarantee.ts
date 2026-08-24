export type GuaranteeDraft = {
  serviceName: string;
  endpointUrl: string;
  expectedFragment: string;
  beneficiary: string;
  intervalSeconds: string;
  failureThreshold: string;
  compensationRlo: string;
  maxPayouts: string;
};

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/i,
  /^\[?(fc|fd)[0-9a-f:]+\]?$/i,
  /^\[?fe80:/i,
];

export function validateGuarantee(draft: GuaranteeDraft): string[] {
  const errors: string[] = [];
  if (!draft.serviceName.trim() || draft.serviceName.length > 96) {
    errors.push("Service name must be 1–96 characters.");
  }
  if (draft.expectedFragment.length > 128) {
    errors.push("Expected body fragment must be at most 128 characters.");
  }

  try {
    const parsed = new URL(draft.endpointUrl);
    if (parsed.protocol !== "https:") errors.push("Endpoint must use HTTPS.");
    if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
      errors.push("Private, loopback and link-local endpoints are not allowed.");
    }
  } catch {
    errors.push("Endpoint URL is invalid.");
  }

  const interval = Number(draft.intervalSeconds);
  if (!Number.isInteger(interval) || interval < 15 || interval > 86400) {
    errors.push("Check interval must be an integer from 15 to 86400 seconds.");
  }
  const threshold = Number(draft.failureThreshold);
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > 20) {
    errors.push("Failure threshold must be an integer from 2 to 20.");
  }
  const maxPayouts = Number(draft.maxPayouts);
  if (!Number.isInteger(maxPayouts) || maxPayouts < 1 || maxPayouts > 100) {
    errors.push("Maximum payouts must be an integer from 1 to 100.");
  }
  if (!draft.beneficiary.trim()) errors.push("Beneficiary pubkey is required.");

  try {
    rloToKelvin(draft.compensationRlo);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Invalid compensation amount.");
  }
  return errors;
}

export function rloToKelvin(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d{0,9})?$/.test(normalized)) {
    throw new Error("Compensation must be a non-negative RLO amount with at most 9 decimals.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt((fraction + "000000000").slice(0, 9));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildOperatorCommand(draft: GuaranteeDraft, programId: string): string {
  const kelvin = rloToKelvin(draft.compensationRlo);
  return [
    `rialo client program invoke ${shellQuote(programId)} --program-dir program \\`,
    `  --function create_guarantee \\`,
    `  --arg workflow_pda_slug=random \\`,
    `  --arg service_name=${shellQuote(draft.serviceName.trim())} \\`,
    `  --arg endpoint_url=${shellQuote(draft.endpointUrl.trim())} \\`,
    `  --arg expected_fragment=${shellQuote(draft.expectedFragment)} \\`,
    `  --arg beneficiary=${shellQuote(draft.beneficiary.trim())} \\`,
    `  --arg check_interval_secs=${draft.intervalSeconds} \\`,
    `  --arg failure_threshold=${draft.failureThreshold} \\`,
    `  --arg compensation_kelvin=${kelvin.toString()} \\`,
    `  --arg max_payouts=${draft.maxPayouts}`,
  ].join("\n");
}
