#!/usr/bin/env bash
# The production image copies only .output (no node_modules) and runs
# `node .output/voice-worker/index.mjs` and `node .output/parser-worker/index.mjs`.
# Prove both bundles boot on their own: copy each into an empty directory, start
# it with throwaway env, and require its startup line. Run after `bun run build`.
set -u
fail=0
rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

boot() { # name, expected line, env...
  local name=$1 want=$2; shift 2
  local dir log
  dir=$(mktemp -d)
  log="$dir/boot.log"
  cp -R ".output/$name/." "$dir/"
  (cd "$dir" && env "$@" node -e \
    "setTimeout(()=>process.exit(0),8000);import('./index.mjs').catch(e=>{console.error(e);process.exit(1)})" \
    >"$log" 2>&1)
  if grep -qE "ERR_MODULE_NOT_FOUND|ERR_PACKAGE_IMPORT_NOT_DEFINED|Cannot find (package|module)" "$log" \
    || ! grep -q "$want" "$log"; then
    echo "::error::$name did not boot without node_modules"; cat "$log"; fail=1
  else
    echo "$name boots without node_modules"
  fi
  rm -rf "$dir"
}

boot voice-worker "voice_worker.started" \
  DATABASE_URL=postgres://127.0.0.1:1/none SESSION_SECRET="$(rand)" \
  SIP_SERVER=127.0.0.1 SIP_PORT=5060 SIP_USER=smoke SIP_PASSWORD="$(rand)" SIP_DOMAIN=smoke.invalid
boot parser-worker "parser worker listening" PARSER_TOKEN="$(rand)" PORT=0
exit $fail
