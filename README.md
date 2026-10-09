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
- Candidate email notifications (acknowledgment, stage update, interview invitation, offer) with per-organisation toggles
- Explainable JD↔CV scoring, social-claim verification and recruiter overrides
- Contextual screening kits, private audio transcription, grading and interview scorecards
- Google Meet, Microsoft Teams and Zoom meeting integrations
- Talent pool ownership, referrals, deduplication, internal job postings and reusable organisation knowledge
- Live compensation research with cited evidence and saved organisation corrections
- CHRO dashboard, reports, Talent Brain ontology and Return on Individual capability-to-goal planning
- Guided first-login journey in the HR copilot, mirrored by the in-app manual
- Hiring desk: describe a hiring need in a chat; agents gather the details, reuse or create the role, rank candidates and line up screening, with every decision shown in the thread
- Hiring agents (opt-in, human-in-the-loop): Copilot, Requisition, JD, Publishing, Intake & matching, Screening, Follow-up, Interview coordinator, Evaluation, Offer, Pre-onboarding & release and Sourcing agents with a Decisions inbox, agent register, observability and health engine, per-organisation autonomy settings with measured recommendations, dry-run replays, alert e-mail / webhooks, optional OpenTelemetry trace export and agent activity tracing — see `docs/agentic-plan.md`
- Product catalogue and organisation oversight for the platform super admin, including an AI usage console (every AI request logged per organisation, module and model with token counts and latency) and a cross-tenant agent console (runs, failures, latency and spend per organisation, agent and model)

## Architecture

- TanStack Start, React 19 and Vite
- PostgreSQL as the system of record, accessed with Drizzle ORM
- First-party password authentication with a shared password policy, database-backed HttpOnly cookie sessions
- S3-compatible private object storage for CVs and screening recordings
- Organisation-supplied AI provider credentials encrypted at rest; there is no shared AI-key fallback, and vendor/model names are never exposed outside the organisation's own integrations settings
- Every AI provider request is recorded in the `ai_usage_events` ledger (feature, provider, model, tokens, attempt, latency) and aggregated in the platform super admin's `/platform-ai-usage` console
- Tenant authorization enforced in server middleware and repeated in every tenant query with an explicit organisation predicate

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

Run the database test suites against a **separate, disposable database**, never the one your dev server uses: some suites delete their own records and `scripts/integration.verify.test.ts` truncates every organisation, user and candidate (it refuses unless the database name contains `test`, `ci`, `verify`, `tmp` or `scratch`). For example: create `atsagent_test`, run `DATABASE_URL=postgres://…/atsagent_test bun scripts/migrate-pg.mjs`, then run the suites with that same `DATABASE_URL`.

The E2E harness under `scripts/local-e2e/` uses a disposable PostgreSQL fixture. Provider-backed AI, email, meeting and job-board operations require an isolated test organisation with its own credentials.

## Roles

Tenant roles are recruiter, hiring manager, department head, HR head and president/CBO. Organisation ownership and the platform super-admin allowlist are separate controls. Role grants are stored separately from user identity records.
