#!/bin/sh
# Local stand-in for the production scheduler: drives the agent tick (agent
# runs, interview-time answer windows, offer expiry, hiring-SLA warnings…).
# Usage: scripts/local-agent-tick.sh [checkout-dir] [port]
# Reads CRON_SECRET from <checkout>/.env.local on every call; never stores it.
DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${2:-9000}"
SECRET=$(grep '^CRON_SECRET=' "$DIR/.env.local" 2>/dev/null | head -1 | cut -d= -f2-)
[ -n "$SECRET" ] || { echo "$(date -u +%FT%TZ) no CRON_SECRET in $DIR/.env.local"; exit 1; }
OUT=$(curl -s -m 170 -X POST -H "Authorization: Bearer $SECRET" "http://localhost:$PORT/api/public/agent-tick")
echo "$(date -u +%FT%TZ) $OUT"
