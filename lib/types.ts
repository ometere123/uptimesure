export type GuaranteeRow = {
  id: number;
  chain_id: number;
  contract_address: string;
  provider: string;
  beneficiary: string;
  endpoint_url: string;
  criteria_hash: string;
  expected_status: number;
  expected_fragment: string;
  max_latency_ms: number;
  check_interval_seconds: number;
  failure_threshold: number;
  min_outage_seconds: number;
  payout_per_incident: string;
  max_payouts: number;
  paid_payouts: number;
  remaining_coverage: string;
  created_at: string;
  expires_at: string;
  first_failure_at: string | null;
  last_observed_at: string | null;
  consecutive_failures: number;
  active: boolean;
  withdrawn: boolean;
  next_check_at: string;
  updated_at: string;
};

export type ObservationRow = {
  observation_id: string;
  guarantee_id: number;
  observed_at: string;
  healthy: boolean;
  http_status: number | null;
  latency_ms: number | null;
  body_sha256: string | null;
  evidence_hash: string;
  error_code: string | null;
  chain_error: string | null;
  tx_hash: string | null;
  tx_status: "pending" | "confirmed" | "failed" | "indexed" | "not_required";
};

export type IncidentRow = {
  id: number;
  guarantee_id: number;
  started_at: string;
  confirmed_at: string;
  recovered_at: string | null;
  payout_amount: string;
  confirm_evidence_hash: string;
  recovery_evidence_hash: string | null;
};
