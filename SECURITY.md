# Security Policy

## Reporting a vulnerability

Email **security@yavar.ai** (or use the contact in README.md if that alias is not yet live).
Please include reproduction steps and affected URLs/endpoints. Do not open a public issue
for a suspected vulnerability.

- Acknowledgement target: **2 business days**
- Triage + severity decision: **5 business days**
- Fix or mitigation for Critical/High: **30 days**

We credit reporters in release notes on request.

## Scope

- `z-atsiq.yavar.ai` / `atsiq.yavar.ai` deployments and this repository's code.
- Out of scope: social engineering, volumetric DoS, spam, attacks against third-party
  providers (LinkedIn, Google, Microsoft, Zoom, OpenAI/Anthropic).

## Secure-development baseline

- Authentication: first-party credentials and database-backed sessions are delivered in Secure,
  HttpOnly cookies with a bounded seven-day sliding lifetime. Password hashes use scrypt; legacy
  bcrypt hashes are upgraded after a successful sign-in. One password policy (8–128 characters with
  upper, lower and digit) is enforced server-side on registration, reset and change.
- Authorization contract: every tenant-scoped server function uses `requireOrg`, `requireRole`,
  `requireOrgOwner` or `requirePlatformAdmin`, and every query carries an explicit `orgId`
  predicate. There is no database row-level-security fallback; server middleware and query scope
  are the mandatory tenant boundary.
- Roles are stored in a separate membership-role table. Platform administration is a separate,
  server-validated allowlist and is never inferred from browser storage.
- Secrets: `SECRET_ENCRYPTION_KEY` encrypts stored credentials (AES-256-GCM); OAuth state
  is HMAC-signed with required secrets; no secret values are committed. Every organisation supplies
  its own AI provider key, and no deployment-level AI key is used as a fallback.
- Rate limiting on all public HTTP routes and server-function RPCs (`src/server.ts`).
- SSRF gate: server-side fetches of user-supplied URLs go through `src/server/safe-fetch.ts`.
- Auditing: privileged actions append to `audit_log` (`src/server/audit.ts`).
- AI safety: untrusted CV, JD, profile and mail text is delimited before prompting; structured model
  responses are schema-validated before use. AI decisions retain evidence and permit audited human override.
- AI usage ledger: every provider request is recorded in `ai_usage_events`
  (organisation, feature, provider, model, token counts, attempt, latency, outcome) directly from
  the gateway. The ledger is read-only to platform super admins via `/platform-ai-usage` and gives
  per-tenant AI visibility without exposing model identities to tenant users — vendor and model
  names stay inside the organisation's own integrations settings.
- Files: CVs and screening recordings remain private in S3-compatible storage and are served through
  authorised application paths rather than public object URLs.
- CI: typecheck, lint, `bun audit --level high`, gitleaks, integration tests (`.github/workflows/ci.yml`).

## Data and dependency boundaries

PostgreSQL is the operational system of record. Authentication, files, AI providers, meeting services,
email and job boards are external trust boundaries with narrowly scoped credentials. Public capture,
webhook, OAuth callback and scheduler endpoints validate callers, validate payloads and are rate limited.

The candidate's offer page (`/offer/<token>`) is public in the same way: a 64-hex token set when the
offer is released (a revision gets a new one), showing only that offer's role, CTC, joining date and
letter; it records one answer (accept, decline, ask for changes) on a released offer — claimed in the
update itself — and its server functions are rate-limited with all other RPCs.

The candidate's interview-time page (`/schedule/<token>`) is public: the token is 64 random hex
characters, it returns only the round, role, organisation, the interviewer's first name and the
offered times, it can book one of those times once (the offer is claimed before booking and every
time is re-checked as free), and its server functions are rate-limited with all other RPCs.
Calendar access for availability is free/busy only — event titles and details are never read.

Job-board application webhooks (`/api/public/boards/<provider>/<token>`) authenticate on two
factors: a per-connection delivery token (24 random bytes, stored encrypted with a SHA-256 hash
lookup — the capture-token precedent) and, where the board's contract defines one, a signature
header verified as HMAC-SHA256 over the raw, unmodified body with a timing-safe comparison
(Indeed's `X-Indeed-Signature`). Requisitions are never accepted from a vendor payload — the
application is routed through ATSIQ's own org-scoped posting rows, and every delivery is stored
first in `board_webhook_events` (deduplicated, signature failures kept for forensics, terminal
rows purged after 30 days). Publishing and webhook rotation are `hr_head`-gated and audited.

Agent telemetry leaves the platform only to destinations an organisation configures (HR head /
CBO / owner, audited as `agent.telemetry.updated`): OpenTelemetry trace export and alert webhooks
are sent through `safeFetch` (https only, private ranges blocked), collector header values and the
webhook signing secret are stored with `encryptSecret` and never returned to the browser, and
alert webhooks are signed with HMAC-SHA256 (`X-ATSAgent-Signature: sha256=<hex>`). Exported spans
and alerts carry ids, rule names, statuses, timings and token counts only — no goals, prompts,
candidate content or model names.

## Release evidence

`VERIFICATION_REPORT.md` records the latest automated and browser checks. A fresh application security
scan and production dependency scan are required before each publication. Provider integrations that need
customer credentials are reported as environment-dependent rather than represented as tested.

## Pre-onboarding documents

Candidate proof documents (photo ID, experience letters, payslips, education
certificates) are stored in private object storage under an organisation-scoped
path, and every read re-checks that prefix against the caller's organisation.
Extraction runs on the organisation's own AI credentials, with untrusted
document text isolated in the prompt and the model's reading validated against a
schema; any instruction-like content is reported to the reviewer rather than
acted upon. Upload, validation and rejection decisions are written to the audit
log with the acting user, and offer release is refused server-side until every
mandatory document type has been validated.
