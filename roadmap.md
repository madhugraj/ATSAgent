# Roadmap

## Lovable decoupling (2026-10-05)

ATSAgent builds, runs and deploys with no Lovable packages, routes, env vars or hosted services.

- [x] Build — `@lovable.dev/vite-tanstack-config` replaced by an explicit `vite.config.ts` (TanStack Start, Tailwind, tsconfig paths, React, Nitro `node-server` on build); `bun.lock` resolves from the public npm registry
- [x] Email — SMTP (`SMTP_URL`) is the only transport; `@lovable.dev/email-js`, `@lovable.dev/webhooks-js`, the `/lovable/email/*` routes and the four auth templates only they rendered are gone
- [x] Careers inbox — the Gmail reader behind Lovable's connector gateway is retired; mail arrives only through each organisation's careers address (signed inbound webhook), and `/api/public/inbox-sync` now scores what arrived
- [x] Leftovers — `@supabase/supabase-js`, the unused Supabase clients, editor-preview auth/error hooks, `.lovable/`, `supabase/` and `drizzle/migrations/` removed; DB types live in `src/lib/database.types.ts`, cron auth in `src/server/cron-auth.ts`
- [x] Config — `LOVABLE_CRON_SECRET(_PREVIOUS)` renamed to `CRON_SECRET(_PREVIOUS)`; migration `0023` moves `ai_settings` off the `'lovable'` provider default to `openai` / `gpt-5.5`

## HR quick wins (2026-10-01)

- [x] Requisition cards surface JD state at a glance — latest-version JD chip (draft / pending DH / approved / changes requested / no JD yet) plus a "Waiting N days — \<approver\>" line derived from the approval trail; flips live via `["jd_statuses"]` invalidation on every JD write
- [x] ⌘K command palette on every page — role-scoped navigation, quick actions and redaction-aware live search over candidates (slim projection, partner-pool rows never expose email/CTC and can't be probed by email) and requisitions
- [x] "Needs you today" dashboard strip — role-filtered counts, each landing where the action completes: approvals awaiting you, rounds awaiting scheduling, screening calls waiting (count-only `screeningQueueCounts` sharing the queue's CTEs so numbers can't diverge), SLA breaches, offers awaiting approval (exec); all-clear state; the four stat tiles are now links

## Screening triage queue (2026-09-30)

The recruiter never waits and never wonders: screening questions are prepared in the background the moment someone is shortlisted, and `/screening` is a role-scoped triage queue that stays seamless at 1000+ CVs.

- [x] Background preparation — migration `0022` (`screening_prep_jobs`, one job per application, upsert-on-shortlist), enqueue hook on the shared stage-transition choke point (covers recruiter moves, bulk moves and autoscore), backfill + retry worker (`screening-prep.server.ts`, ≤100/run, lease-reclaim, ≤3 attempts, vendor-neutral failure copy) and the `/api/public/screening-prep` cron route (devops registers it in Cloud Scheduler)
- [x] Matching-engine audit-trail fix — `persistMatchResult`'s auto-shortlist now journals the stage transition (and sends the shortlisted email) like autoscore and manual shortlists always did; first bulk scoring run after deploy emails every auto-shortlisted candidate
- [x] Slim queue endpoints — `listScreeningQueue` (50-row joined pages, true per-bucket counts under the current filters, no resume text or rationale on the wire) and `getScreeningCandidate` (single-candidate pane data, `resume_text` dropped); org-wide `listScreeningKits` retired
- [x] The queue UI — buckets with live counts (To call / Questions ready / Screened / All), seamless infinite scroll, split-pane triage with the ScreeningPanel embedded, CV download, match evidence, StageMover in place, keyboard triage (j/k/a/s/r), live pulse while background prep completes
- [ ] Register `/api/public/screening-prep` in Cloud Scheduler (devops; see infra/DEPLOYMENT-HANDOFF.md §7)

## Enterprise job-board connections (2026-09-29)

LinkedIn, Indeed and Naukri wired end-to-end on the existing integration-credential and cron primitives: connection setup, job-posting syndication and application ingestion. Every vendor path is partner-contract-gated, so adapters are capability-driven and the UI reports contract gaps honestly instead of pretending a happy path.

- [x] Connection foundations — migration `0018` (`requisition_board_postings`, `board_webhook_events`, `board_sync_state`, per-connection webhook tokens), per-org seeding of `source_integrations` rows (new orgs at creation, existing orgs backfilled), Indeed credentials moved to client id/secret/employer id
- [x] Adapter layer (`src/server/boards/`) — per-board `capabilities / publishPosting / closePosting / pollApplications / verifyDelivery / mapApplication`, all outbound calls via safeFetch, config-driven partner paths for Naukri/Indeed, LinkedIn reuse of the org OAuth connection + capability probes
- [x] Publishing — `publishToBoard` / `closeBoardPosting` (hr_head, audited, approved-requisitions only) with a "Job boards" panel on the requisition page; closing a requisition takes its postings down
- [x] Ingestion — per-connection webhook URL (token in path, Indeed `X-Indeed-Signature` HMAC verified timing-safe) + `/api/public/board-sync` cron (5th scheduler job) for polling backfill, stuck-event retries and 30-day event retention; intake reuses the shared candidate-intake core so dedupe, ack mail and scoring match the apply page
- [x] Connection-completion UX — enterprise checklist per board card on Integrations (credentials → test → webhook → contract capabilities → postings/applications), webhook rotate, "add missing board connections" fallback
- [x] One-press connect for Naukri/Indeed (2026-10-01) — connect panel on each card mirroring the LinkedIn one: Connect saves the pasted partner keys and verifies them against the board's token endpoint (`token_path`-aware, matching the adapters) in one press, Disconnect is the same audited credential removal, "What this connection can do" surfaces the adapter's honest contract detail, and each panel ships a ready-to-send request note for the board's account manager
- [ ] Live vendor verification — LinkedIn Job Posting/RSC contract, Indeed Apply registration and signed deliveries from Indeed itself, Naukri endpoint pack (all capability-gated until the partner paperwork lands)

## HRMS integrations (2026-09-29)

Study in `docs/hrms-integrations-study.md`: vendor API landscape (Keka, greytHR, Workday buildable today; Darwinbox, ZingHR, Adrenalin partnership-gated), recommended connector architecture reusing the existing integration-credential, outbox and cron primitives, and the phased plan below.

- [x] P0: connector foundations — "hrms" category on Integrations, adapter interface, sync engine + cron job, employee-master cache, field mappings
- [ ] P1: read connectors for Keka and greytHR (public APIs): employee and department sync
- [ ] P2: outbound platform — signed webhooks with delivery outbox and retries, scoped public REST API keys
- [ ] P3: on-hire push to Keka (incl. preboarding) and greytHR, hooked at the stage-transition choke point
- [ ] P4: Workday read via OAuth + RaaS/REST with a per-customer ISU setup guide; partnership track in parallel
- [ ] P5: CSV import/export templates for partnership-gated HRMS (Darwinbox, ZingHR, Adrenalin); direct adapters as vendor specs arrive; evaluate a unified-API aggregator behind a DPIA

## AI governance and spend visibility (2026-09-28)

- [x] AI usage ledger (`ai_usage_events`): one row per provider request — organisation, module, provider, model, prompt/completion/total tokens, retry attempt, latency, outcome — written fire-and-forget from the gateway; OpenAI/Anthropic/Gemini usage frames harvested, transcription included, missing frames recorded as zero (never estimated)
- [x] Platform super-admin AI usage console (`/platform-ai-usage`): totals, daily stacked tokens, spend per module/organisation/model, filterable request log with pagination, CSV export
- [x] Vendor/model abstraction: AI provider and model names removed from the landing page, product catalogue (page and PDF/XLSX export), user manual, toasts/cards and all server-to-client payloads; a one-time migration (`0016`) scrubbed model ids already persisted in candidate activity trails. The organisation's own Integrations → AI model settings keeps provider and model choice (BYO keys)
- [x] Usage attribution fixes: careers-inbox CV parsing and Talent Brain AI now carry the organisation id so every ledger row resolves to a tenant

## Candidate communications (2026-09-27)

- [x] Candidate email outbox with queued delivery, retries and suppression
- [x] Four automatic email types: application acknowledgment, stage update, interview invitation and offer notification
- [x] Per-organisation toggles, reply-to address and timezone on Integrations → Candidate emails; platform SMTP relay does delivery

## Account security (2026-09-28)

- [x] One password policy everywhere (8–128 characters with upper, lower and digit) enforced server-side on registration, reset and change; new password must differ from current; show/hide toggles and a visible policy hint on every password field

## First-login guidance

- [x] Add a first-login, replayable integration-to-offer journey in the HR copilot and share its steps with the user manual

## Landing film + visual polish

- [x] Remove the landing-film explainer sentence and add an animated Talent Brain graph sequence
- [x] Render enterprise brand film and place it on the landing page
- [x] Remove the "Who pays for AI" note from integrations
- [x] Polish the dashboard shell, KPI band and panels
- [x] Polish the Talent Brain knowledge graph
- [x] Repair first-party sign-in and verify session persistence
- [x] Expand the film with CHRO dashboard, RoI and capability highlights
- [x] Review the dashboard and Talent Brain in the signed-in application

## Return on Individual (RoI) semantic layer — CHRO

- [x] RoI model: capability per hire from match evidence, scarcity, impact, innovation, trajectory, breadth
- [x] Cost anchor with honest fallback (offer where released, requisition budget otherwise)
- [x] RoI index normalised against the organisation's own median hire cost
- [x] Capability-to-goal engine: 10 programme blueprints, team readiness vs pool readiness, named contributors
- [x] Organisation strength / exposure readings, incl. single-person dependencies and dormant capability
- [x] Department rollups and individual-by-individual evidence view
- [x] Super-admin organisation switcher on the RoI page
- [x] Executive band on the dashboard answering the question up front
- [x] Review the accepted-offer test cohort in the authenticated preview

- [x] Replace landing film with a glossy real-page/data narrative
- [x] Verify RoI cards are computed from organisation evidence, not mock records
- [x] Harden interview scheduling, scorecard progression and audit trails
- [x] Add an explicitly labelled 50-person accepted-offer test cohort

## Pre-onboarding document validation

- [x] onboarding_documents table, private storage and org-scoped access
- [x] Extraction agent for ID, experience letters, payslips and certificates on the org's own AI key
- [x] Careers-inbox routing of offer-stage candidate documents
- [x] HR validation screen: original document beside the agent's reading, validate / reject / re-read
- [x] Offer release gated on validated mandatory documents
- [x] User manual and repository documentation updated

## Release validation and documentation

- [ ] Restore the database to immediately before 2026-09-22 22:13 UTC and reconcile all business-record counts (blocked: provider point-in-time recovery required)
- [ ] Run authenticated and public end-to-end workflow tests (blocked until database recovery)
- [x] Refresh repository product, deployment, security and verification documents
- [x] Refresh the in-app user manual and copilot knowledge source
- [x] Update the technical architecture document to the current implementation
- [x] Update and visually inspect the investor product document
- [ ] Run current security checks and resolve release blockers (basic scan passed; dependency scan parser blocked by URL-pinned xlsx package)
- [ ] Publish and verify the production release (blocked until database recovery and revalidation)
- [x] Pre-onboarding: per-employer salary breakup captured verbatim; multi-page, scanned, merged and zipped uploads read as individual documents
