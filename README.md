# ATSAgent

Internal development fork of [ATSIQ](https://github.com/madhu-yavar/yavar-ats) (Profile Matcher Pro) for building a fully agentic version of the platform. The original ATSIQ repository and its production deployment (atsiq.yavar.ai) are not modified by work in this repository.

- Forked from upstream `main` at commit `382fbac` (2026-10-01), with full history
- Upstream remote is fetch-only; pushing to it is disabled in this clone

---

# ATSIQ

ATSIQ by Yavar AI is an enterprise recruiting intelligence platform. It combines governed hiring workflows with evidence-led JD↔CV matching, prescreening, compensation research, Talent Brain workforce intelligence and Return on Individual analysis.

**Production:** https://atsiq.yavar.ai

## Product scope

- Organisation registration, platform approval, role-based access and tenant lifecycle controls
- Requisition, JD and offer approval workflows with immutable decision trails
- Pre-onboarding document collection, agent extraction and HR validation gating offer release
- Public applications, careers-inbox intake, bulk CV parsing and ATSIQ Capture for deep LinkedIn Recruiter collection
- Enterprise job-board connections for LinkedIn, Indeed and Naukri: approved requisitions publish to the boards' job surfaces and board applications are ingested (signed webhooks + scheduled polling) into the same deduplicated, scored pipeline — capability-gated per partner contract
- Job distribution across 14 portals (verified routes in `docs/job-distribution-research.md`): Google for Jobs structured data on every approved role's apply page (Indexing API notifications within the daily quota), per-organisation job feeds for Jooble, Adzuna and Jora, copy-ready posting packs for portals with no integration, apply links tagged per channel and a per-channel report of who applied and how far they got
- Candidate email notifications (acknowledgment, stage update, interview invitation, offer) with per-organisation toggles
- Explainable JD↔CV scoring, social-claim verification and recruiter overrides
- Contextual screening kits, private audio transcription, grading and interview scorecards
- Google Meet, Microsoft Teams and Zoom meeting integrations
- Talent pool ownership, referrals, deduplication, internal job postings and reusable organisation knowledge
- Live compensation research with cited evidence and saved organisation corrections
- Pay discussions before the letter: a call brief and a person-approved message when the candidate expects more than the approved ceiling
- Pay & availability collected at screening through a private candidate form (HR-only), so offers are built on the candidate's stated expectation and notice period
- CHRO dashboard, reports, Talent Brain ontology and Return on Individual capability-to-goal planning
- Guided first-login journey in the HR copilot, mirrored by the in-app manual
- Hiring desk: describe a hiring need in a chat; agents gather the details, reuse or create the role, rank candidates and line up screening, with every decision shown in the thread
- Hiring agents (opt-in, human-in-the-loop): Copilot, Requisition, JD, Publishing, Intake & matching, Screening, Follow-up, Interview coordinator, Evaluation, Offer, Pre-onboarding & release and Sourcing and Distribution agents with a Decisions inbox, agent register, observability and health engine, per-organisation autonomy settings with measured recommendations, dry-run replays, alert e-mail / webhooks, optional OpenTelemetry trace export and agent activity tracing — see `docs/agentic-plan.md`
- Product catalogue and organisation oversight for the platform super admin, including an AI usage console (every AI request logged per organisation, module and model with token counts and latency) and a cross-tenant agent console (runs, failures, latency and spend per organisation, agent and model)

## Architecture

- TanStack Start, React 19 and Vite
- PostgreSQL as the system of record, accessed with Drizzle ORM
- First-party password authentication with a shared password policy, database-backed HttpOnly cookie sessions
- S3-compatible private object storage for CVs and screening recordings
- Organisation-supplied AI provider credentials encrypted at rest; there is no shared AI-key fallback, and vendor/model names are never exposed outside the organisation's own integrations settings
- Every AI provider request is recorded in the `ai_usage_events` ledger (feature, provider, model, tokens, attempt, latency) and aggregated in the platform super admin's `/platform-ai-usage` console
- Tenant authorization enforced in server middleware and repeated in every tenant query with an explicit organisation predicate

## Observability

- **Logs** — one JSON object per line (`src/server/log.ts`, OpenTelemetry field names). Ids and short summaries only: never CV, document, mail or prompt text, secrets, or vendor/model names.
- **Correlation** — `src/server.ts` opens a request context per request (`src/server/request-context.ts`): it continues a valid W3C `traceparent` or starts a trace, every log line on that request carries `trace_id` / `span_id`, and the response returns `traceparent` and `x-request-id`. Agent runs started from a request join its trace (`agent_runs.trace_id` is the same 16 bytes as a uuid), and lines written while a run executes carry the run's trace. Logs Explorer: `jsonPayload.trace_id="<x-request-id>"` finds every line of a request and its runs.
- **Request logs and metrics** — one `http.request` line per request (method, route template with ids as `:id`, `route_group`, status, `status_class`, `duration_ms`, `server_fn` id). In-process counters and a latency histogram are exposed as OpenMetrics on `GET /metrics` (`src/server/http-metrics.ts`) when `METRICS_TOKEN` is set — bearer-protected, rate-limited, 404 otherwise.
- **Label rules (cardinality)** — metric labels come from a fixed set only: `route_group` (server_fn, page, api_public, api_auth, api, metrics, static), `method` (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, OTHER), `status_class` (1xx–5xx). Raw paths, ids, tokens, org/user ids, server-function ids and model names are never labels; they stay in log lines.
- **SLOs** — defined once in `src/server/slo.ts`: server-function availability 99 %, server-function latency 95 % within 2.5 s, agent run success 95 % (30-day windows). Each replica persists per-minute request counts to `service_request_minutes`; platform super admins see SLI vs objective, error budget left and 5 min / 1 h / 6 h / 24 h burn rates on **Platform → Service health** (`/platform-health`). Note: the framework answers any thrown server-function error with HTTP 500, so expected errors (validation, permission) count against availability; the log line flags them `fn_error: true`. A client that hangs up mid-request (navigating away) is logged once at info as status 499 with `client_aborted: true` and never counts as a bad event.
- **Alerts** — multi-window burn-rate alerts (14.4× over 1 h and 5 min → critical; 6× over 6 h and 30 min → serious) are evaluated with the agent health engine on the scheduler tick (`src/server/slo.server.ts`) and go to platform admins by e-mail, the optional signed `PLATFORM_ALERT_WEBHOOK_URL`, an ERROR `slo.burn_alert` log line and `audit_log`. Agent health issues keep their per-organisation e-mail / webhook alerts and Agent observability page.
- **Ops** — Cloud Monitoring log-based metrics, dashboard and alert policies as code in `infra/monitoring/` (`DEPLOYMENT-GCP.md` §9).

## Documentation

- `docs/testing-guide.md` — step-by-step local test script for the agents, hiring desk, observability and platform console (everything except voice)
- `docs/agentic-plan.md` — the plan for turning ATSIQ into a multi-agent, human-in-the-loop hiring system (requisition → offer release)
- `docs/er-diagram.md` — entity-relationship diagram for all tables, generated from `drizzle/schema.ts` (`node scripts/gen-er-diagram.mjs`)
- `DEPLOYMENT-GCP.md` and `infra/DEPLOYMENT-HANDOFF.md` — deployment runbooks
- `SECURITY.md` — security policy and secure-development baseline
- `VERIFICATION_REPORT.md` — release validation evidence
- `roadmap.md` — shipped work and open items

See also `SECURITY.md` and `VERIFICATION_REPORT.md` for operating, security and release evidence.

## Local development

Use Bun and a PostgreSQL database.

```sh
bun install
bun run db:migrate
bun run dev
```

Required configuration is documented in `.env.example`. Never commit passwords, encryption keys, OAuth secrets or AI provider keys.

## Quality gates

```sh
bun run typecheck
bun test
bun run test:e2e
```

Local PostgreSQL is managed by `scripts/local-db.sh` (`bun run db:local init`, then `start`, `stop`, `status`, `migrate`, `backup`, `restore`): PostgreSQL 14 like production, data in a durable per-user folder (never `/tmp`), password auth on 127.0.0.1, verified daily backups. See `docs/runbooks/local-database.md`.

Run the database test suites against a **separate, disposable database**, never the one your dev server uses: some suites delete their own records and `scripts/integration.verify.test.ts` truncates every organisation, user and candidate (it refuses unless the database name contains `test`, `ci`, `verify`, `tmp` or `scratch`). For example: create `atsagent_test`, run `DATABASE_URL=postgres://…/atsagent_test bun scripts/migrate-pg.mjs`, then run the suites with that same `DATABASE_URL`.

The E2E harness under `scripts/local-e2e/` uses a disposable PostgreSQL fixture. Provider-backed AI, email, meeting and job-board operations require an isolated test organisation with its own credentials.

## Roles

Tenant roles are recruiter, hiring manager, department head, HR head and president/CBO. Organisation ownership and the platform super-admin allowlist are separate controls. Role grants are stored separately from user identity records.
