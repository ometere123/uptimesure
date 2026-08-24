#!/usr/bin/env bash
# Local mirror of the product-verify `database-schema` job.
#
# CI runs the schema against a postgres service container. This script does the same against a throwaway
# local cluster so schema defects are caught in seconds instead of a CI round-trip. It must stay behaviourally
# identical to the job in .github/workflows/product-verify.yml: same role creation, same extension shim, same
# double migration pass, same assertions. If the two drift, CI is authoritative.
#
# One known divergence: CI pins postgres:15 while this runs against whatever local cluster is installed. Nothing
# in the schema uses post-15 syntax, but a green run here is not a substitute for the CI job.
#
# Usage: bash scripts/verify-schema.sh
set -euo pipefail

PGBIN="${PGBIN:-/c/Program Files/PostgreSQL/18/bin}"
PGDATA="${PGDATA:-/tmp/uspg}"
PGPORT="${PGPORT:-55432}"
export PATH="$PGBIN:$PATH"
export PGPASSWORD=postgres

psql_run() { psql -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }

if ! pg_isready -h 127.0.0.1 -p "$PGPORT" -q 2>/dev/null; then
  echo "== starting throwaway cluster at $PGDATA on port $PGPORT"
  [ -d "$PGDATA/base" ] || initdb -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null
  pg_ctl -D "$PGDATA" -o "-p $PGPORT" -l /tmp/uspg.log start >/dev/null
  sleep 4
fi

# A fresh database per run. Re-using one would let a previous run's objects mask a migration that fails to
# create something, which is the opposite of what this check is for.
DB="uptimesure_schema_$$"
psql -h 127.0.0.1 -p "$PGPORT" -U postgres -q -c "create database $DB;"
trap 'psql -h 127.0.0.1 -p "$PGPORT" -U postgres -q -c "drop database if exists $DB;" >/dev/null 2>&1 || true' EXIT
psql_run() { psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

echo "== creating Supabase-managed roles (cluster-wide, NOLOGIN)"
psql -h 127.0.0.1 -p "$PGPORT" -U postgres -q -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;
SQL

psql_run -q -c "create schema if not exists vault;"

for pass in 1 2; do
  echo "== migration pass $pass"
  for file in supabase/migrations/*.sql; do
    printf '   %s ... ' "$(basename "$file")"
    if out=$(sed -E 's/^create extension if not exists (pg_cron|pg_net|supabase_vault).*$/-- managed extension (skipped in CI)/' "$file" \
      | psql_run -q -f - 2>&1); then
      echo "ok"
    else
      echo "FAILED"
      echo "$out" | tail -40
      exit 1
    fi
  done
done

echo "== asserting schema invariants"
if out=$(psql_run -q -f supabase/tests/schema_assertions.sql 2>&1); then
  echo "$out" | grep -E "NOTICE" | tail -5 || true
  echo "===== SCHEMA CHECKS PASSED ====="
else
  echo "$out" | tail -45
  exit 1
fi
