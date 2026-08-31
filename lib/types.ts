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
  exhausted: boolean;
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
  body_keccak256: string | null;
  evidence_hash: string;
  error_code: string | null;
  chain_error: string | null;
  tx_hash: string | null;
  /** Mirrors the observations_tx_status_check constraint. See migration 0006 for what each value means. */
  tx_status: ObservationChainStatus;
};

export type ObservationChainStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "indexed"
  | "not_required"
  | "unmonitorable";

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

/** The `chain_sync_public` view: indexer health, readable with the publishable key. */
export type ChainSyncRow = {
  chain_id: number;
  deploy_block: string;
  contract_address: string;
  last_synced_block: string;
  safe_block: string;
  last_run_at: string | null;
  last_error: string | null;
};
