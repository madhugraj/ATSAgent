# syntax=docker/dockerfile:1
# ATSIQ production image — Nitro node-server output (.output/server/index.mjs).

# Base images pinned by digest (docs/guardrails.md P2-3); Dependabot proposes updates.
FROM oven/bun:1@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

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
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
