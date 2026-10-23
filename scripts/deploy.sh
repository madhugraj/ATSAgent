#!/usr/bin/env bash
# ATSIQ self-service deploy — no DevOps required.
#
# Usage:
#   scripts/deploy.sh [git-sha]     build <sha> (default: HEAD) and roll it out
#   scripts/deploy.sh migrate [sha] run drizzle/pg-migrations against prod DB
#
# What it does (build path proven 2026-09-30):
#   1. packs the committed tree (git archive) + the Capture companion zip
#   2. runs `bun install && bun run build` in a temporary oven/bun pod
#   3. pushes the runtime image with kaniko (Cloud Build is permission-blocked,
#      local Docker is unreliable — this path needs neither)
#   4. `kubectl set image` + rollout status + smoke checks
#
# Requires: gcloud + kubectl authenticated as madhu.r@yavar.ai (cluster RBAC
# and Artifact Registry write are on that account; never use the gmail one).
set -euo pipefail

PROJECT=yavar-studio
REGION=asia-south1
NS=atsiq
REGISTRY="$REGION-docker.pkg.dev/$PROJECT/yavar-platform/atsiq"
REQUIRED_ACCOUNT="madhu.r@yavar.ai"
WORK="/tmp/atsiq-deploy-$$"
SHA="${2:-$(git rev-parse --short HEAD)}"
MODE="${1:-deploy}"

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'rm -rf "$WORK"; kubectl -n $NS delete pod atsiq-deploy-build atsiq-deploy-kaniko --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

# The GKE master resets long exec streams, so kubectl cp truncates multi-MB
# files. Chunked transfer with per-chunk md5 checks instead.
md5_of() { md5 -q "$1" 2>/dev/null || md5sum "$1" | cut -d" " -f1; }

fetch_file() { # fetch_file <pod> <remote-path> <local-path>
  kubectl -n "$NS" exec "$1" -- sh -c "rm -f /tmp/chunk_*; split -b 4M -d '$2' /tmp/chunk_; md5sum /tmp/chunk_* > /tmp/chunks.md5" >/dev/null
  local list n sum
  list=$(kubectl -n "$NS" exec "$1" -- sh -c "awk '{print \$NF, \$1}' /tmp/chunks.md5")
  : > "$3"
  echo "$list" | while read -r n sum; do
    for attempt in 1 2 3 4 5; do
      kubectl -n "$NS" exec "$1" -- cat "$n" > "$WORK/chunk.part" 2>/dev/null || true
      [ "$(md5_of "$WORK/chunk.part")" = "$sum" ] && break
      [ "$attempt" = 5 ] && fail "chunk $n failed md5 after 5 attempts."
      sleep 2
    done
    cat "$WORK/chunk.part" >> "$3"
  done
}

push_file() { # push_file <local-path> <pod> <remote-path>
  local sum size part n i
  sum=$(md5_of "$1"); size=$(stat -f%z "$1" 2>/dev/null || stat -c%s "$1")
  split -b 4M -d "$1" "$WORK/upchunk_" 2>/dev/null || split -b 4m -d "$1" "$WORK/upchunk_"
  kubectl -n "$NS" exec "$2" -- sh -c "rm -f /tmp/upchunk_*" >/dev/null
  for part in "$WORK"/upchunk_*; do
    n=$(basename "$part")
    for i in 1 2 3 4 5; do
      kubectl -n "$NS" exec -i "$2" -- sh -c "cat > /tmp/$n" < "$part" 2>/dev/null || true
      [ "$(kubectl -n "$NS" exec "$2" -- md5sum "/tmp/$n" 2>/dev/null | cut -d" " -f1)" = "$(md5_of "$part")" ] && break
      [ "$i" = 5 ] && fail "upload chunk $n failed md5 after 5 attempts."
      sleep 2
    done
  done
  kubectl -n "$NS" exec "$2" -- sh -c "cat /tmp/upchunk_* > '$3' && md5sum '$3'" | { read -r got _ rest; [ "$got" = "$sum" ] || fail "remote file md5 mismatch after reassembly."; }
  kubectl -n "$NS" exec "$2" -- sh -c "rm -f /tmp/upchunk_*" >/dev/null
}

# ---------------------------------------------------------------- guards
step "Guards"
cd "$(git rev-parse --show-toplevel)" || fail "not inside the atsiq git repository."
[ "$(gcloud config get-value account 2>/dev/null)" = "$REQUIRED_ACCOUNT" ] \
  || fail "gcloud account is not $REQUIRED_ACCOUNT (gcloud auth list)."
git diff --quiet HEAD -- drizzle/schema.ts 2>/dev/null || echo "  note: uncommitted schema changes exist — deploys ship committed code only."
kubectl -n "$NS" get deploy atsiq >/dev/null 2>&1 || fail "no kubectl access to deployment atsiq in namespace $NS."
IMAGE="$REGISTRY:$SHA"
echo "  account ok · cluster ok · target image: $IMAGE"

# ---------------------------------------------------------------- context
step "Packing build context (committed tree + companion zip)"
rm -rf "$WORK/ctx"
mkdir -p "$WORK/ctx"
git archive "$SHA" | tar -x -C "$WORK/ctx" 2>/dev/null || fail "cannot archive $SHA — is it committed/pushed?"
if [ ! -f "$WORK/ctx/public/atsiq-capture.zip" ]; then
  echo "  companion zip missing — rebuilding from extension/"
  ( cd extension && zip -qr "$WORK/ctx/public/atsiq-capture.zip" manifest.json background.js popup.js popup.html )
fi
COPYFILE_DISABLE=1 tar --exclude='._*' -czf "$WORK/ctx.tgz" -C "$WORK/ctx" .
echo "  context: $(du -h "$WORK/ctx.tgz" | cut -f1)"

# ---------------------------------------------------------------- builder
step "Building the app in a temporary oven/bun pod"
kubectl -n "$NS" run atsiq-deploy-build --image=oven/bun:1 --restart=Never --overrides='{"spec":{"containers":[{"name":"atsiq-deploy-build","image":"oven/bun:1","command":["sleep","3600"],"resources":{"requests":{"cpu":"2","memory":"4Gi"},"limits":{"cpu":"4","memory":"8Gi"}}}],"restartPolicy":"Never"}}' >/dev/null
kubectl -n "$NS" wait --for=condition=Ready pod/atsiq-deploy-build --timeout=240s >/dev/null \
  || fail "builder pod never became ready."
push_file "$WORK/ctx.tgz" atsiq-deploy-build /ctx.tgz
kubectl -n "$NS" exec atsiq-deploy-build -- sh -c \
  'rm -rf /build && mkdir /build && tar -xzf /ctx.tgz -C /build 2>/dev/null; cd /build && bun install --frozen-lockfile >/dev/null 2>&1 && bun run build > build.log 2>&1' \
  || { kubectl -n "$NS" exec atsiq-deploy-build -- tail -20 /build/build.log; fail "app build failed — see the log above."; }
kubectl -n "$NS" exec atsiq-deploy-build -- sh -c 'cd /build && tar -czf /out.tgz .output' >/dev/null

fetch_file atsiq-deploy-build /out.tgz "$WORK/out.tgz"
echo "  app build ok ($(du -h "$WORK/out.tgz" | cut -f1))"

# ---------------------------------------------------------------- image
step "Assembling and pushing the runtime image (crane inside the builder pod)"
# scripts/crane-stage.sh ships inside the build context (/build) — nothing
# to upload. It layers /app/.output onto node:22-slim and pushes with crane.
TOKEN=$(gcloud auth print-access-token)
kubectl -n "$NS" exec atsiq-deploy-build -- env \
  DESTINATION="$IMAGE" \
  REGISTRY_AUTH="{\"auths\":{\"$REGION-docker.pkg.dev\":{\"username\":\"oauth2accesstoken\",\"password\":\"$TOKEN\"}}}" \
  sh /build/scripts/crane-stage.sh \
  || fail "could not build/push the runtime image."
echo "  pushed $IMAGE"

# ---------------------------------------------------------------- migrate
if [ "$MODE" = "migrate" ]; then
  step "Running drizzle/pg-migrations against the prod database"
  DBURL=$(kubectl -n "$NS" get secret atsiq-env -o jsonpath='{.data.DATABASE_URL}' | base64 -d)
  kubectl -n "$NS" exec -i atsiq-deploy-build -- env DATABASE_URL="$DBURL" sh -c \
    'cd /build && node scripts/migrate-pg.mjs' \
    || fail "migration run failed."
  echo "  migrations applied (idempotent — already-applied files skipped)."
fi

# ---------------------------------------------------------------- rollout
if [ "$MODE" = "deploy" ]; then
  step "Rolling out"
  PREV=$(kubectl -n "$NS" get deploy atsiq -o jsonpath='{.spec.template.spec.containers[0].image}')
  kubectl -n "$NS" set image deploy/atsiq atsiq="$IMAGE"
  kubectl -n "$NS" rollout status deploy/atsiq --timeout=300s \
    || { echo "Rollout failed — rolling back:"; kubectl -n "$NS" set image deploy/atsiq atsiq="$PREV"; kubectl -n "$NS" rollout status deploy/atsiq --timeout=300s; fail "rolled back to $PREV."; }
  echo "  previous image (rollback if needed): $PREV"
  # The voice worker (phone screening) runs the same image with its own command
  # (node /app/.output/voice-worker/index.mjs). Its Deployment and Secret are
  # created by a person (DEPLOYMENT-GCP.md); roll it only when it exists. A
  # rollout waits for calls in progress to finish (terminationGracePeriodSeconds).
  if kubectl -n "$NS" get deploy atsiq-voice-worker >/dev/null 2>&1; then
    kubectl -n "$NS" set image deploy/atsiq-voice-worker voice-worker="$IMAGE"
    kubectl -n "$NS" rollout status deploy/atsiq-voice-worker --timeout=2400s \
      || echo "  WARNING: voice worker rollout did not finish — check deploy/atsiq-voice-worker."
  fi
fi

# ---------------------------------------------------------------- smoke
step "Smoke checks"
sleep 5
BASE=$(kubectl -n "$NS" get secret atsiq-env -o jsonpath='{.data.PUBLIC_SITE_URL}' | base64 -d)
curl -sf -o /dev/null "$BASE/" && echo "  app: 200" || fail "app not serving at $BASE"
curl -s -o /dev/null -w "  board webhook guard: HTTP %{http_code}\n" -X POST "$BASE/api/public/boards/indeed/probe_token_12345678"
step "DONE — $SHA is live at $BASE"
