#!/usr/bin/env bash
# Local PostgreSQL for development, kept like a real environment:
#  - the same major version as production (Cloud SQL POSTGRES_14);
#  - data in a durable per-user folder — never /tmp or another folder the OS
#    cleans (a dev cluster in /tmp was purged by macOS: see docs/runbooks);
#  - password (scram-sha-256) auth, listening on 127.0.0.1 only;
#  - a dev database and a separate disposable test database;
#  - compressed daily backups with rotation, and a checked restore.
#
# Usage: scripts/local-db.sh <init|start|stop|status|migrate|backup|restore FILE|schedule-backups|unschedule-backups>
# Settings (env): ATSAGENT_PG_BIN, ATSAGENT_PG_DATA, ATSAGENT_PG_PORT, ATSAGENT_BACKUP_DIR, ATSAGENT_BACKUP_KEEP
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
PG_MAJOR=14
PG_BIN="${ATSAGENT_PG_BIN:-}"
if [[ -z "$PG_BIN" ]]; then
  for c in /opt/homebrew/opt/postgresql@$PG_MAJOR/bin /usr/local/opt/postgresql@$PG_MAJOR/bin /usr/lib/postgresql/$PG_MAJOR/bin; do
    [[ -x "$c/pg_ctl" ]] && PG_BIN="$c" && break
  done
fi
[[ -n "$PG_BIN" && -x "$PG_BIN/pg_ctl" ]] || { echo "PostgreSQL $PG_MAJOR not found (brew install postgresql@$PG_MAJOR, or set ATSAGENT_PG_BIN)." >&2; exit 1; }

if [[ "$(uname)" == "Darwin" ]]; then
  APP_DIR="$HOME/Library/Application Support/ATSAgent"
else
  APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atsagent"
fi
DATA="${ATSAGENT_PG_DATA:-$APP_DIR/postgres-$PG_MAJOR}"
BACKUPS="${ATSAGENT_BACKUP_DIR:-$APP_DIR/backups}"
KEEP="${ATSAGENT_BACKUP_KEEP:-14}"
PORT="${ATSAGENT_PG_PORT:-54377}"
LOG="$APP_DIR/postgres.log"
SUPERUSER=postgres
DEV_DB=atsagent
TEST_DB=atsagent_test

# Data must survive: refuse folders the OS empties.
case "$(cd "$(dirname "$DATA")" 2>/dev/null && pwd -P || dirname "$DATA")/" in
  /tmp/*|/private/tmp/*|/var/tmp/*|/private/var/folders/*|/var/folders/*)
    echo "Refusing to keep database data in a temporary folder ($DATA): the OS deletes files there." >&2
    exit 1 ;;
esac

PGPASS="$HOME/.pgpass"
password() {
  [[ -f "$PGPASS" ]] && awk -F: -v p="$PORT" '$1=="127.0.0.1" && $2==p && $4=="postgres" {print $5; exit}' "$PGPASS"
}
url() { echo "postgres://$SUPERUSER:$1@127.0.0.1:$PORT/$2"; }
# Postgres tools read ~/.pgpass themselves: no password on command lines or in the environment.
psql_as() { "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$SUPERUSER" -v ON_ERROR_STOP=1 "$@"; }
running() { "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }

set_env_url() {
  local u="$1"
  touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
  if grep -qE '^DATABASE_URL=' "$ENV_FILE"; then
    local tmp; tmp="$(mktemp "$ROOT/.env.local.XXXX")"
    awk -v line="DATABASE_URL=$u" '/^DATABASE_URL=/{print line; next} {print}' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE" && chmod 600 "$ENV_FILE"
  else
    echo "DATABASE_URL=$u" >> "$ENV_FILE"
  fi
}

cmd_init() {
  if [[ -f "$DATA/PG_VERSION" ]]; then echo "Cluster already initialised at $DATA"; return; fi
  mkdir -p "$APP_DIR" "$BACKUPS" && chmod 700 "$APP_DIR" "$BACKUPS"
  local pw; pw="$(openssl rand -hex 24)"
  local pwfile; pwfile="$(mktemp)"; chmod 600 "$pwfile"; printf '%s' "$pw" > "$pwfile"
  "$PG_BIN/initdb" -D "$DATA" -U "$SUPERUSER" --pwfile="$pwfile" --auth-host=scram-sha-256 --auth-local=scram-sha-256 -E UTF8 --locale=C >/dev/null
  rm -f "$pwfile"
  touch "$PGPASS" && chmod 600 "$PGPASS"
  grep -v "^127.0.0.1:$PORT:" "$PGPASS" > "$PGPASS.tmp" || true
  echo "127.0.0.1:$PORT:*:$SUPERUSER:$pw" >> "$PGPASS.tmp" && mv "$PGPASS.tmp" "$PGPASS" && chmod 600 "$PGPASS"
  cat >> "$DATA/postgresql.conf" <<CONF
# ATSAgent local development
listen_addresses = '127.0.0.1'
port = $PORT
unix_socket_directories = '$DATA'
password_encryption = 'scram-sha-256'
logging_collector = off
CONF
  set_env_url "$(url "$pw" "$DEV_DB")"
  echo "Initialised PostgreSQL $PG_MAJOR at $DATA (port $PORT); DATABASE_URL written to .env.local."
  cmd_start
  psql_as -d postgres -qc "create database $DEV_DB" -c "create database $TEST_DB"
  cmd_migrate
}

cmd_start() {
  running && { echo "Already running."; return; }
  "$PG_BIN/pg_ctl" -D "$DATA" -l "$LOG" -w start >/dev/null
  echo "Started (port $PORT, log $LOG)."
}
cmd_stop() { running && "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null; echo "Stopped."; }
cmd_status() {
  echo "Data: $DATA"; echo "Backups: $BACKUPS (keep $KEEP)"
  running && echo "Server: running on 127.0.0.1:$PORT" || echo "Server: stopped"
  ls -1t "$BACKUPS"/*.dump 2>/dev/null | head -3 | sed 's/^/Latest backup: /' || true
}

cmd_migrate() {
  local pw; pw="$(password)"
  for db in "$DEV_DB" "$TEST_DB"; do
    (cd "$ROOT" && DATABASE_URL="$(url "$pw" "$db")" node scripts/migrate-pg.mjs >/dev/null) && echo "Migrated $db."
  done
}

cmd_backup() {
  mkdir -p "$BACKUPS" && chmod 700 "$BACKUPS"
  local f="$BACKUPS/$DEV_DB-$(date +%Y%m%d-%H%M%S).dump"
  "$PG_BIN/pg_dump" -h 127.0.0.1 -p "$PORT" -U "$SUPERUSER" -Fc -Z 6 -f "$f.partial" "$DEV_DB"
  # A backup counts only once it can be read back.
  "$PG_BIN/pg_restore" --list "$f.partial" >/dev/null
  mv "$f.partial" "$f" && chmod 600 "$f"
  ls -1t "$BACKUPS"/$DEV_DB-*.dump | tail -n +$((KEEP + 1)) | while read -r old; do rm -f -- "$old"; done
  echo "Backup written and verified: $f"
}

cmd_restore() {
  local f="${1:-}"; [[ -f "$f" ]] || { echo "Usage: $0 restore <backup.dump>" >&2; exit 1; }
  "$PG_BIN/pg_restore" --list "$f" >/dev/null
  [[ "${ATSAGENT_RESTORE_CONFIRM:-}" == "$DEV_DB" ]] || {
    echo "Restoring replaces the $DEV_DB database. Re-run with ATSAGENT_RESTORE_CONFIRM=$DEV_DB to proceed." >&2; exit 1; }
  cmd_backup # keep what is being replaced
  psql_as -d postgres -qc "drop database if exists ${DEV_DB}_restoring" -c "create database ${DEV_DB}_restoring"
  "$PG_BIN/pg_restore" -h 127.0.0.1 -p "$PORT" -U "$SUPERUSER" -d "${DEV_DB}_restoring" --no-owner "$f"
  psql_as -d postgres -qc "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DEV_DB'" \
    -c "drop database $DEV_DB" -c "alter database ${DEV_DB}_restoring rename to $DEV_DB"
  echo "Restored $DEV_DB from $f."
}

PLIST="$HOME/Library/LaunchAgents/ai.yavar.atsagent.db-backup.plist"
cmd_schedule() {
  [[ "$(uname)" == "Darwin" ]] || { echo "Add a daily cron entry: 0 2 * * * $ROOT/scripts/local-db.sh backup"; return; }
  mkdir -p "$(dirname "$PLIST")"
  # launchd jobs cannot read ~/Documents: run a copy kept with the data.
  cp "$0" "$APP_DIR/local-db.sh" && chmod 700 "$APP_DIR/local-db.sh"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.yavar.atsagent.db-backup</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$APP_DIR/local-db.sh</string><string>backup</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$APP_DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/backup.log</string>
</dict></plist>
PL
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Daily backup scheduled (13:00 local) — $PLIST"
}
cmd_unschedule() { launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; echo "Daily backup unscheduled."; }

case "${1:-}" in
  init) cmd_init ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  migrate) cmd_migrate ;;
  backup) cmd_backup ;;
  restore) shift; cmd_restore "${1:-}" ;;
  schedule-backups) cmd_schedule ;;
  unschedule-backups) cmd_unschedule ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
