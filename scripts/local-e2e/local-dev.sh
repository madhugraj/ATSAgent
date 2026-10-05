#!/usr/bin/env bash
# One-command local test stack for ATSIQ (production-safe: never touches prod Supabase).
#   scripts/local-e2e/local-dev.sh          — start everything
#   scripts/local-e2e/local-dev.sh stop     — stop everything
#
# Components:
#   1. Disposable Postgres 14 on 127.0.0.1:54333 (datadir /tmp/atsiq-pgdata, rebuilt
#      from scripts/local-e2e/fixture.sql when missing)
#   2. GoTrue-compatible auth stub on 127.0.0.1:54999 (scripts/local-e2e/auth-stub.ts)
#   3. Vite dev server (port from its output — 8080/8081)
#
# Logins: madhu@demo.com / demo1234  (super admin, Demo Corp)
#         hr@yavar.ai    / demo1234  (owner, Yavar Technologies)
set -euo pipefail
cd "$(dirname "$0")/../.."

PG_BIN=/opt/homebrew/opt/postgresql@14/bin
PG_PORT=54333
DATADIR=/tmp/atsiq-pgdata
STUB_PORT=54999

psql() { "$PG_BIN/psql" -h 127.0.0.1 -p $PG_PORT -U postgres -d atsiq_e2e "$@"; }

if [[ "${1:-}" == "stop" ]]; then
  lsof -ti:8080,8081 -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
  pkill -f "auth-stub.ts" 2>/dev/null || true
  [[ -d $DATADIR ]] && "$PG_BIN/pg_ctl" -D "$DATADIR" stop -m fast >/dev/null 2>&1 || true
  echo "local stack stopped"
  exit 0
fi

# 1. Database
if psql -t -c "select 1" >/dev/null 2>&1; then
  echo "postgres: already running on :$PG_PORT"
else
  if [[ ! -d $DATADIR ]]; then
    echo "postgres: initialising disposable cluster + fixture…"
    "$PG_BIN/initdb" -D "$DATADIR" -U postgres --auth=trust >/dev/null
    "$PG_BIN/pg_ctl" -D "$DATADIR" -o "-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1" -l /tmp/atsiq-pgdata.log start >/dev/null
    "$PG_BIN/createdb" -h 127.0.0.1 -p $PG_PORT -U postgres atsiq_e2e
    # the fixture's GRANTs reference Supabase-era roles — create them first
    psql -q -c "create role anon nologin; create role authenticated nologin; create role service_role nologin;" || true
    psql -q -f scripts/local-e2e/fixture.sql
    psql -q -f scripts/local-e2e/seed-roles.sql
  else
    "$PG_BIN/pg_ctl" -D "$DATADIR" -o "-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1" -l /tmp/atsiq-pgdata.log start >/dev/null
    echo "postgres: started existing cluster on :$PG_PORT"
  fi
fi

# schema drift: fixture.sql (and old persisted data dirs) predate some drizzle
# columns/migrations. These are idempotent, so run them on EVERY boot — a
# reused data dir must be healed too, not just a fresh one.
psql -q -f drizzle/pg-migrations/0009_capture_token_hash.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0012_comp_knowledge.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0013_pre_onboarding.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0014_email_outbox.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0015_ai_usage_events.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0017_hrms_sync.sql 2>/dev/null || true
psql -q -c "alter table requisitions add column if not exists job_card_overrides jsonb not null default '{}'::jsonb" || true
psql -q -c "alter table organizations add column if not exists capture_token_hash text" || true
psql -q -c "alter table job_descriptions add column if not exists template_id uuid" || true
psql -q -c "alter table job_descriptions add column if not exists template_name text" || true
psql -q -c "alter table candidates add column if not exists suspected_prompt_injection boolean not null default false" || true
psql -q -f drizzle/pg-migrations/0018_board_connections.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0019_master_items_org_scoped_unique.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0020_content_templates_ensure.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0021_linkedin_row_rename.sql 2>/dev/null || true
psql -q -f drizzle/pg-migrations/0022_screening_prep_jobs.sql 2>/dev/null || true

# 2. Auth stub
if curl -s -o /dev/null "http://127.0.0.1:$STUB_PORT/auth/v1/user" 2>/dev/null; then
  echo "auth stub: already running on :$STUB_PORT"
else
  (bun scripts/local-e2e/auth-stub.ts > /tmp/atsiq-auth-stub.log 2>&1 &)
  sleep 1
  echo "auth stub: started on :$STUB_PORT"
fi

# 3. Env override (gitignored) — points the app at the local stack
if ! grep -q "54999" .env.local 2>/dev/null; then
  cat > .env.local <<'ENV'
VITE_SUPABASE_URL=http://127.0.0.1:54999
VITE_SUPABASE_PUBLISHABLE_KEY=e2e-local-publishable-key
SUPABASE_URL=http://127.0.0.1:54999
SUPABASE_PUBLISHABLE_KEY=e2e-local-publishable-key
DATABASE_URL=postgres://postgres@127.0.0.1:54333/atsiq_e2e
SESSION_SECRET=e2e-local-session-secret-0123456789abcdef
PUBLIC_SITE_URL=http://localhost:8080
CRON_SECRET=local-e2e-cron-secret
ENV
  echo ".env.local: written (points app at local stack)"
fi

# Existing checkouts keep their .env.local — add the cron secret in place so
# the /api/public/* job routes stay curl-able locally.
if ! grep -q "CRON_SECRET" .env.local 2>/dev/null; then
  printf '\nCRON_SECRET=local-e2e-cron-secret\n' >> .env.local
  echo ".env.local: added CRON_SECRET (cron routes curl-able locally)"
fi

# 4. Dev server
if curl -s -o /dev/null http://localhost:8080/ 2>/dev/null; then
  echo "dev server: already running at http://localhost:8080"
elif curl -s -o /dev/null http://localhost:8081/ 2>/dev/null; then
  echo "dev server: already running at http://localhost:8081"
else
  (bun run dev > /tmp/atsiq-dev.log 2>&1 &)
  for i in $(seq 1 30); do
    sleep 2
    curl -sf -o /dev/null http://localhost:8080/ 2>/dev/null && { echo "dev server: http://localhost:8080"; break; }
    curl -sf -o /dev/null http://localhost:8081/ 2>/dev/null && { echo "dev server: http://localhost:8081"; break; }
  done
fi

echo ""
echo "Open the printed URL and sign in:"
echo "  madhu@demo.com / demo1234   (super admin, Demo Corp)"
echo "  hr@yavar.ai    / demo1234   (owner, Yavar Technologies)"
