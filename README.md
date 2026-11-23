# ATSAgent

Internal development fork of [ATSIQ](https://github.com/madhu-yavar/yavar-ats) (Profile Matcher Pro) for building a fully agentic version of the platform. The original ATSIQ repository and its production deployment (atsiq.yavar.ai) are not modified by work in this repository.

- Forked from upstream `main` at commit `382fbac` (2026-10-01), with full history
- Upstream remote is fetch-only; pushing to it is disabled in this clone

---

# ATSIQ

ATSIQ by Yavar AI is an enterprise recruiting intelligence platform. It combines governed hiring workflows with evidence-led JD↔CV matching, prescreening, compensation research, Talent Brain workforce intelligence and Return on Individual analysis.

**Production:** https://atsiq.yavar.ai

## Product scope

- Navigation by area: the sidebar lists hubs (Home, Agents, Agent admin, Pipeline, Candidates, Sourcing, Insights; Settings, Platform and Help at the foot) and each hub's pages show as tabs above the page; page URLs and role visibility are unchanged (`src/components/nav-config.ts`); people pin up to six pages to a Pinned list at the top of the sidebar (per browser)
- Organisation registration, platform approval, role-based access and tenant lifecycle controls
- Versioned Terms of Service, Privacy Policy and Data Processing Agreement (`src/lib/legal/`, `/terms`, `/privacy`, `/dpa`): accepted by a named signatory at registration, re-accepted by the owner when a version changes, recorded in `org_agreements`, audited and visible on the platform console
- Requisition, JD and offer approval workflows with immutable decision trails
- Pre-onboarding document collection, agent extraction and HR validation gating offer release
- Public applications, careers-inbox intake, bulk CV parsing and ATSIQ Capture for deep LinkedIn Recruiter collection
- Enterprise job-board connections for LinkedIn, Indeed and Naukri: approved requisitions publish to the boards' job surfaces and board applications are ingested (signed webhooks + scheduled polling) into the same deduplicated, scored pipeline — capability-gated per partner contract
- Job distribution across 14 portals (verified routes in `docs/job-distribution-research.md`): Google for Jobs structured data on every approved role's apply page (Indexing API notifications within the daily quota), per-organisation job feeds for Jooble, Adzuna and Jora, copy-ready posting packs for portals with no integration (on Internshala and Apna the ATSIQ Capture companion fills the portal's form in the person's own signed-in browser — never submitting — and records the posting), apply links tagged per channel and a per-channel report of who applied and how far they got
- Candidate email notifications (acknowledgment, stage update, interview invitation, offer) with per-organisation toggles
- Explainable JD↔CV scoring, social-claim verification and recruiter overrides
- Contextual screening kits, private audio transcription, grading and interview scorecards — each role's rounds rate its own competencies, with weights and a 1/3/5 rating guide per competency; the overall is the weighted average, worked out on the server
- AI phone screening (optional, per organisation): the Screening call agent phones shortlisted candidates for a short call (about 3 minutes, set per organisation) through the organisation's PBX line and its own AI voice key — says it is an AI, asks consent, takes the practical details (the joining date and current and expected pay are required — recorded for HR only, or noted as declined), asks the kit's questions, retries and takes callbacks within calling hours, falls back to the written assessment; only the answered questions are graded, and the hiring desk shows the result with _Why this score_ and asks a person who moves on (`docs/voice-screening-agent.md`)
- Voice Guard (mandatory wherever AI phone calls are on): every answered AI phone call (screening, scheduling, pay) is reviewed after it ends, silently and without changing anything. It checks clues to the answer, questions it fell for, going beyond its facts, repeats and read-backs, commitments, agreements, records against what was said, the call's rules, the required joining date and pay, and turn-taking on the line. Findings quote the transcript and are listed under Agents → Call reviews for a person, with a 7-day summary on the agent health page (`docs/voice-guard.md`)
- Google Meet, Microsoft Teams and Zoom meeting integrations
- Panel liberty under the hiring SLA: a panelist who accepted a round can move it once — only to a time the whole panel has free and no later than the stage's SLA deadline, until 12 hours before — or step down, and the Interview coordinator proposes a stand-in for the booked time; panelists can propose topics, competencies and weights for their round (the role's must-haves stay and nothing outweighs them; among the existing competencies no share moves more than 10 points, so new ones can be added and the split balanced evenly), the AI reviews the change against the job and the role's hiring manager approves it on the Interview plan (migration 0090)
- Panel directory: interview panels drawn from org members and people HR adds — internal or external (a client, an advisor); when nobody fits a round, the Interview coordinator asks the HR head in the hiring desk to type someone in (self-approved, audited); external panellists score through a private, expiring link sent with their brief and the L1–L3 panel summary, which shows the candidate's profile, CV and the round's rubric (`docs/panel-directory.md`)
- Hiring SLA from start to finish (default 5 days, application to offer, set per organisation): each stage gets its share, the hiring desk hears when a candidate falls behind, Reports shows on track / at risk / past; panelists have 2 hours to answer an interview time before the round goes ahead without them; the AI scheduling call closes the candidate's slot the same day (3 tries an hour apart, 24-hour link); scorecards are due 2 hours after a round, with reminders and HR-head escalation. Locally, `scripts/local-agent-tick.sh` stands in for the production scheduler (run it every few minutes, e.g. from launchd or cron)
- Interview times agreed before the candidate hears: each panelist accepts or declines the time from a private link; the candidate is not called or e-mailed until the whole panel accepts, and the candidate then confirms the booked time
- Panel-only access: the Interviewer role gives colleagues who only interview a one-page app — their rounds, the brief and CV for each, and their scorecard — and the server refuses them everything else
- Silent panel agents L1 / L2 / L3 (optional, per organisation and round; steps 1–3 of 4): online interview calls transcribed by the organisation's own Teams, Zoom or Meet and read back after the call (the candidate is told in the invite and can decline); each level's agent keeps its own hidden view of the candidate and of how the round was run, and e-mails the panel a factual summary with no score; when the panel has scored, a fixed rule compares the two — agreement lets the panel's verdict stand, a partial match lets it stand and asks the HR head to review, a disagreement holds the move until the HR head decides (`docs/silent-panel-agent-plan.md`)
- Talent pool ownership, referrals, deduplication, internal job postings and reusable organisation knowledge
- Live compensation research with cited evidence and saved organisation corrections
- Pay discussions before the letter: a call brief and a person-approved message when the candidate expects more than the approved ceiling
- AI pay calls: the assistant phones the candidate with the approved figure (and at most one pre-approved improved figure), never the ceiling; a yes comes back for TA / the HR head to confirm in one click
- Pay & availability collected at screening through a private candidate form (HR-only), so offers are built on the candidate's stated expectation and notice period
- CHRO dashboard, reports, Talent Brain ontology and Return on Individual capability-to-goal planning
- Role expert interview: the Role expert interview agent asks a role's hiring manager what the role really needs (at most two rounds of questions, in their inbox) and writes the role's expert brief — must-haves and why, deal-breakers, what good looks like, must-ask screening questions and each interview round's rubric. The hiring manager approves it; then screening kits ask its questions and the interview rounds rate its areas
- Organisation profile: what the organisation does and how it hires, each line marked for candidates or internal use, versioned and approved by the HR head or owner — pay figures and staff names are refused. The Organisation context agent builds and keeps it from the admin's answers (its workspace on the Profile page: the conversation beside the live draft), the organisation's own website (own domain only, robots.txt, monthly re-read) and uploaded documents (OCR for scans) — every item quotes its source, nothing is approved by an agent. Once approved, the JD agent writes "About us" only from the candidate-visible lines, the Requisition agent drafts from the hiring norms, candidate matching weighs domain experience against it, and screening kits may verify domain and regulators (`docs/org-context-agent-plan.md`)
- Guided first-login journey in the HR copilot, mirrored by the in-app manual
- Aditi, the HR copilot, answers by role: requisition status and approval trails, approvals waiting on you, pipeline, the role ontology and emerging roles, talent-pool coverage per open role, a demand outlook (internal requisition trend + market signal, with confidence) and, for leadership, governance and AI usage; every figure comes from role-filtered server-side lookups, short formatted answers (bullets, small tables, links to the page) that name a cause only when the data shows it, and work it proposes starts the agents only when you click
- Hiring desk: describe a hiring need in a chat; agents gather the details, reuse or create the role, rank candidates and line up screening, with every decision shown in the thread
- Hiring agents (opt-in, human-in-the-loop): Aditi (the front-door Copilot agent, one name with the HR copilot), Requisition, JD, Publishing, Intake & matching, Screening, Follow-up, Interview coordinator, Evaluation, Offer, Pre-onboarding & release and Sourcing and Distribution agents with a Decisions inbox, agent register, observability and health engine, per-organisation autonomy settings with measured recommendations, dry-run replays, alert e-mail / webhooks, optional OpenTelemetry trace export and agent activity tracing — see `docs/agentic-plan.md`
- AI guardrails (`docs/guardrails.md`, `docs/red-team.md`): outside text fenced as data, hidden text removed from CVs, injection-flagged candidates never auto-advance, a run that read suspicious text asks a person before acting, model output schema-checked and stripped of echoed instructions, organisation spend limits (monthly AI tokens, daily scorings per role), a two-person rule on the organisation profile, and a model safety check (attacks run against your own AI model) required before any agent works at Autonomous
- Agent studio (`docs/agent-studio.md`; platform super admin only, never offered for sale): build agents from the tool catalogue — adapted from a stock agent or new — with their own instructions, responsibility, must-never list, human decisions, risk tier and renamed tools (same inputs). Each version is tested with sample data in a test organisation (stand-in tools, nothing real changes), approved and published as an immutable manifest that runs pin; the super admin grants it to the organisations they pick, where it appears in Agent settings (off until switched on) and runs inside the app as `studio:<slug>`. It can also be delivered as a vendor-neutral package, a hosted API (`/api/agents/…`) or MCP (`/api/mcp`). The injection and operating rules, human tools and gate-verb ban are always added
- Agent workflows (`docs/agent-workflows.md`; platform super admin only): draw on a canvas which agents run after which event and under what conditions (trigger → agents and yes/no conditions → end, stock or studio agents, goals with event fields), dry-run test it, approve, publish and grant it to chosen organisations, where the orchestrator runs it alongside the built-in hand-offs — every agent still starts under the organisation's own switch, autonomy and budget. **Build with chat** drafts the graph and its dry-run tests from a plain description (drafts only; a person still saves, tests, approves, publishes and grants). A go-live check shows per organisation what is missing (AI key, agents switched on, studio grants) on the Organisations tab, in the organisation's Agent settings → Workflows (Switch on shortcut, recent runs) and in the bell until it is ready. Each granted workflow has its own app page (`/w/<id>`: start it, follow each run as its flow, answer its questions and approvals in place) and an API with organisation-issued keys (`/api/workflows/…`)
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
- **Alerts** — multi-window burn-rate alerts (14.4× over 1 h and 5 min → critical; 6× over 6 h and 30 min → serious) are evaluated with the agent health engine on the scheduler tick (`src/server/slo.server.ts`) and go to platform admins by e-mail, the optional signed `PLATFORM_ALERT_WEBHOOK_URL`, an ERROR `slo.burn_alert` log line and `audit_log`. Agent health issues keep their per-organisation alerts and Agent observability page: critical issues e-mail at once (at most once per rule per day), serious ones and agent reminders arrive in one end-of-day summary per person, webhooks fire per issue. Every e-mail carries the organisation's own logo and brand colour (Organisation → E-mail branding).
- **Voice vs text agents** — Agent observability, Agent governance and Agent intelligence each have an All / Voice / Text toggle. Voice agents are the live phone-call agents (screening, scheduling and negotiation calls, listed in `src/lib/agent-modality.ts`); the toggle scopes KPIs, trends, issues, the agent list and the PDF / Excel reports.
- **Ops** — Cloud Monitoring log-based metrics, dashboard and alert policies as code in `infra/monitoring/` (`DEPLOYMENT-GCP.md` §9).

## Documentation

- `docs/testing-guide.md` — step-by-step local test script for the agents, hiring desk, observability and platform console (everything except voice)
- `docs/agentic-plan.md` — the plan for turning ATSIQ into a multi-agent, human-in-the-loop hiring system (requisition → offer release)
- `docs/org-context-agent-plan.md` — the organisation profile and the Organisation context agent that keeps it (O0 built)
- `docs/parallel-hiring-desk-plan.md` — the plan for handling multiple hiring needs in parallel (fan-out threads, shared questions, split-screen supervision)
- `docs/pay-terms-plan.md` — currency, pay basis, kinds of work, pay zones and regional pooling for organisations hiring across countries (built: schema, the pay converter, pay conventions approved by the HR head, requisition pay terms, the screening call and matching in each role's currency, pool and needed-by date, offers with a rate fixed at approval, the negotiation call, JD and job postings, reports in the reporting currency)
- `docs/labour-policy-agent-plan.md` — the Labour law & policy agent: official sources per pay zone, HR-approved updates to the organisation profile, and the offer check before every offer letter (built: sources, quoted findings approved by the HR head, rules in the organisation context, the offer check before approval, the screening call following the rules where the job is)
- `docs/er-diagram.md` — entity-relationship diagram for all tables, generated from `drizzle/schema.ts` (`node scripts/gen-er-diagram.mjs`)
- `docs/deployment-scouts-gcp.md` — DevOps runbook for production on GCP (www.scouts.yavar.ai): infrastructure, secrets, Kubernetes manifests (`infra/gke/`), scheduler jobs and CI/CD (`.github/workflows/deploy-gke.yml`)
- `DEPLOYMENT-GCP.md` and `infra/DEPLOYMENT-HANDOFF.md` — deployment runbooks (earlier z-atsiq setup)
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

`bun install` turns on a pre-commit hook (`.githooks/pre-commit`) that formats staged files with Prettier and runs ESLint on them, so formatting and lint errors are caught before a push instead of in CI. Worktrees share the setting; `git commit --no-verify` skips it once.

```sh
bun run typecheck
bun test
bun run test:e2e
```

Local PostgreSQL is managed by `scripts/local-db.sh` (`bun run db:local init`, then `start`, `stop`, `status`, `migrate`, `backup`, `restore`): PostgreSQL 14 like production, data in a durable per-user folder (never `/tmp`), password auth on 127.0.0.1, verified daily backups. See `docs/runbooks/local-database.md`.

Run the database test suites against a **separate, disposable database**, never the one your dev server uses: some suites delete their own records and `scripts/integration.verify.test.ts` truncates every organisation, user and candidate (it refuses unless the database name contains `test`, `ci`, `verify`, `tmp` or `scratch`). For example: create `atsagent_test`, run `DATABASE_URL=postgres://…/atsagent_test bun scripts/migrate-pg.mjs`, then run the suites with that same `DATABASE_URL`.

The E2E harness under `scripts/local-e2e/` uses a disposable PostgreSQL fixture. Provider-backed AI, email, meeting and job-board operations require an isolated test organisation with its own credentials.

## Roles

Tenant roles are recruiter, hiring manager, department head, HR head, president/CBO and interviewer — a member whose only role is `interviewer` is panel-only: they see just their own rounds on My interviews, and the server refuses them everything else. Organisation ownership and the platform super-admin allowlist are separate controls. Role grants are stored separately from user identity records.
