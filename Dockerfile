# syntax=docker/dockerfile:1
# ATSIQ production image — Nitro node-server output (.output/server/index.mjs).

# Base images pinned by digest (docs/guardrails.md P2-3); Dependabot proposes updates.
FROM oven/bun:1@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# The browser companion download (Integrations → Capture extension).
RUN bun scripts/build-extension-zip.mjs
RUN bun run build

# Database migrations and one-off admin scripts (docs/deployment-scouts-gcp.md):
# `docker build --target migrate`. Has Bun, node_modules, scripts/ and
# drizzle/pg-migrations; runs inside the cluster where Cloud SQL is reachable.
# Listed before the runtime stage so a plain `docker build` still ends there.
FROM build AS migrate
CMD ["bun", "scripts/migrate-pg.mjs"]

FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build /app/.output ./.output
# safe-fetch imports undici at runtime and nitro does not copy it into
# .output; it has no dependencies of its own.
COPY --from=build /app/node_modules/undici ./node_modules/undici
# Fail the build if the bundle imports a package that is not in the image
# (only .output is copied here), instead of a 500 on the first request.
COPY --from=build /app/scripts/check-bundle-imports.mjs /tmp/check-bundle-imports.mjs
RUN node --experimental-import-meta-resolve /tmp/check-bundle-imports.mjs \
      .output/server .output/voice-worker .output/parser-worker \
    && rm /tmp/check-bundle-imports.mjs
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
