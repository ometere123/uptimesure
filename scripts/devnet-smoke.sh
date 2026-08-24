#!/usr/bin/env bash
set -euo pipefail

PROGRAM_ID="${1:?usage: devnet-smoke.sh <program-id> <beneficiary-pubkey>}"
BENEFICIARY="${2:?usage: devnet-smoke.sh <program-id> <beneficiary-pubkey>}"

# A real public HTTPS endpoint. No mocked contract state is used.
rialo client program invoke "$PROGRAM_ID" --program-dir program \
  --function create_guarantee \
  --arg workflow_pda_slug=random \
  --arg service_name="UptimeSure Example" \
  --arg endpoint_url="https://example.com" \
  --arg expected_fragment="Example Domain" \
  --arg beneficiary="$BENEFICIARY" \
  --arg check_interval_secs=30 \
  --arg failure_threshold=2 \
  --arg compensation_kelvin=1000000 \
  --arg max_payouts=2
