<!-- SECURITY:BEGIN -->

## Security invariants (do not regress)

- Every tenant-scoped server function uses `requireOrg` / `requireRole` /
  `requireOrgOwner` / `requirePlatformAdmin` (src/lib/auth.middleware.ts), and every
  query it issues carries an explicit `eq(table.orgId, context.orgId)` predicate.
  There is no row-level security — this middleware is the only boundary.
- Client-supplied `requisitionId`s must pass `assertRequisitionInOrg`
  (src/server/guards.ts) before any insert that references them.
- Server-side fetches of user-supplied URLs go through `safeFetch` /
  `safeFetchText` (src/server/safe-fetch.ts) — never raw `fetch`.
- Untrusted text (CV, JD, profile, mail) enters AI prompts only through
  `untrusted(...)` with `INJECTION_RULES` in the system prompt; model JSON is
  zod-validated via the `schema` option of `aiJson`.
- Requisition/offer approval transitions and their trails are built
  server-side with `assertRole` — never accept status logic or trail entries
  from the client.
- Privileged actions (role grants, platform-admin and tenant operations,
  credential changes, capture rotation) must append to `audit_log` via
  `writeAudit` (src/server/audit.ts).
- Credentials at rest are stored via `encryptSecret`/`decryptSecret`
  (src/server/crypto.ts) — never plaintext.
- Public endpoints and server-fn RPCs are rate-limited in src/server.ts; do
  not add new public routes without limiter coverage.
- Every AI provider request must go through `aiJson` / `aiResearchJson` /
  `aiAgentStep` (agent tool-calling turns)
  (src/lib/ai-gateway.server.ts) with a `feature` slug from `AI_FEATURES`
  (src/server/ai-usage.ts); the gateway writes the `ai_usage_events` ledger
  row automatically. Never call provider REST endpoints directly, and never
  estimate tokens — log what the provider reports (zero when no usage frame).
- AI vendor and model names are never sent to the client or rendered outside
  the organisation's own Integrations → AI model settings (BYO-key page).
  Strip `model` / `engine` fields from server-fn wire returns (keep them in
  the database) and keep marketing, manual and error copy vendor-neutral.
- Security review reports live in SECURITY_AUDIT_REPORT*.md — never commit
  them while the repository is public.

<!-- SECURITY:END -->

## Documentation

- `drizzle/schema.ts` is the schema source of truth. Any schema change adds an
  idempotent SQL file under `drizzle/pg-migrations/` (next number, applied by
  `scripts/migrate-pg.mjs`) and regenerates `docs/er-diagram.md` via
  `node scripts/gen-er-diagram.mjs`.
- Keep `README.md`, `DEPLOYMENT-GCP.md`, `infra/DEPLOYMENT-HANDOFF.md`,
  `SECURITY.md` and `roadmap.md` current with shipped behaviour in the same
  change that alters behaviour.

## Product guidance

- Keep the first-login journey and manual in `src/lib/user-manual.ts` as one source so the copilot walkthrough and help page cannot drift.
- Keep the guided overlay within the existing database-backed HR copilot rather than replacing its transcript and composer with AI Elements; its current request/response transport is not AI SDK streaming, and a transport rewrite is outside onboarding guidance scope.
