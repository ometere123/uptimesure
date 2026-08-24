#!/usr/bin/env bash
# The same checks the product-verify workflow runs, in the same order, runnable locally.
# CI is authoritative; this exists so a failure can be reproduced without waiting on a runner.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export PATH="$HOME/.deno/bin:$PATH"

fail=0
step() {
  local label="$1"; shift
  printf '\n=== %s ===\n' "$label"
  if "$@" >/tmp/verify-step.log 2>&1; then
    printf 'PASS  %s\n' "$label"
    tail -4 /tmp/verify-step.log
  else
    printf 'FAIL  %s\n' "$label"
    tail -40 /tmp/verify-step.log
    fail=1
  fi
}

step "web: tests"      npx vitest run lib
step "web: typecheck"  npx tsc --noEmit
step "web: build"      npx next build

# Compile precedes typecheck: the TypeScript sources import TypeChain bindings that do not exist until
# the contracts are compiled, so reversing these two would fail on a clean checkout.
step "contracts: compile"   npm --prefix contracts run compile
step "contracts: typecheck" npm --prefix contracts run typecheck
step "contracts: test"      npm --prefix contracts test

step "edge: check monitor-due" deno check --config supabase/functions/monitor-due/deno.json supabase/functions/monitor-due/index.ts
step "edge: check sync-chain"  deno check --config supabase/functions/sync-chain/deno.json supabase/functions/sync-chain/index.ts
step "edge: check shared"      deno check --config supabase/functions/deno.json supabase/functions/_shared/auth.ts supabase/functions/_shared/chain.ts supabase/functions/_shared/evidence.ts supabase/functions/_shared/ssrf.ts
step "edge: tests"             deno test --config supabase/functions/deno.json supabase/functions/_shared

printf '\n===== %s =====\n' "$([ $fail -eq 0 ] && echo 'ALL CHECKS PASSED' || echo 'SOME CHECKS FAILED')"
exit $fail
