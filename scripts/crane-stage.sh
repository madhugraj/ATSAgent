#!/bin/sh
# Runs INSIDE the deploy builder pod (oven/bun): assembles the ATSIQ runtime
# image with crane — base node:22-slim + one layer containing /app/.output,
# then sets the image config (env, workdir, entrypoint) and pushes.
# Invoked by scripts/deploy.sh with env: DESTINATION (full image tag),
# REGISTRY_AUTH (docker config JSON for the Artifact Registry).
set -e
mkdir -p /outimg/.docker
printf "%s" "$REGISTRY_AUTH" > /outimg/.docker/config.json

# layer: /stage/app/.output (paths are image-root relative)
mkdir -p /stage/app
tar -xzf /out.tgz -C /stage/app
test -f /stage/app/.output/server/index.mjs
test -f /stage/app/.output/voice-worker/index.mjs
tar -cf /stage/layer.tar -C /stage app

# crane: single static binary from go-containerregistry releases (gzip tar)
for i in 1 2 3; do
  bun -e "await Bun.write('/crane.tgz', new Uint8Array(await (await fetch('https://github.com/google/go-containerregistry/releases/download/v0.20.3/go-containerregistry_Linux_x86_64.tar.gz')).arrayBuffer()))" || { sleep 3; continue; }
  [ "$(head -c 2 /crane.tgz | od -An -tx1 | tr -d ' \n')" = "1f8b" ] && break
  sleep 3
done
[ "$(head -c 2 /crane.tgz | od -An -tx1 | tr -d ' \n')" = "1f8b" ] || { echo "crane download failed (not gzip)" >&2; exit 1; }
tar -xzf /crane.tgz -C /outimg crane
chmod +x /outimg/crane

CRANE="/outimg/crane --verbose"
STAGE_TAG="$DESTINATION-stage"
export DOCKER_CONFIG=/outimg/.docker

$CRANE append -f /stage/layer.tar -b node:22-slim -t "$STAGE_TAG"
$CRANE mutate "$STAGE_TAG" \
  --env NODE_ENV=production \
  --env HOST=0.0.0.0 \
  --env PORT=3000 \
  --entrypoint "node,/app/.output/server/index.mjs" \
  -t "$DESTINATION"
$CRANE manifest "$DESTINATION" >/dev/null && echo "pushed $DESTINATION"
# Best-effort cleanup of the staging tag — never fail the run here.
$CRANE delete "$STAGE_TAG" >/dev/null 2>&1 || true
