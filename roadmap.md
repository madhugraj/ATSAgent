# Roadmap

## Autonomy and job-board posting (2026-10-08)

- [x] Any member can ask the Publishing agent for a LinkedIn / Naukri / Indeed post; the HR head approves it (with its text) and it is published as that HR head (Publishing agent v1.3.0); tools can name an approver role
- [x] Autonomous now differs from Act and notify: every candidate message template sends on its own (Screening v1.3.0, Interview coordinator v1.2.0), and job-board posts go out on their own on boards the HR head pre-approved (per board, Autonomous only); decisions always stay with people
- [x] Publishing agent v1.4.0 checks every channel first (`list_publish_channels`: internal posting, apply link, careers inbox, and per board connected / switched on / may post — with the reason — / already live), posts only where a board can, ends every post with the apply link, and hands the person a ready post + apply link + inbox address where no board can post
- [x] New applicants from any channel are scored within minutes (scheduler sweep, at most one intake run per role per 10 minutes) and announced in the role's desk thread by channel
- [x] Sourcing agent (new, v1.0.0): watches supply by channel, tops up starving roles from the talent pool, invites strong past candidates to apply (`role_invite` email, approved unless pre-approved; consent, 30-day no-repeat), recommends channels; started daily for starving roles or from the desk; health rule `sourcing.no_supply`; eval scenario; lock covers 12 agents
- [x] Cost per candidate: every AI request carries the role / candidate it was made for (attribution scope around candidate work, agent runs about a candidate, CV reads labelled once the candidate is saved; migration 0035); the requisition page shows the role's total, shared work, each candidate's direct cost by hiring stage and cost per hire; the candidate page shows their own cost — tokens always, money at the organisation's token prices
- [x] Offer answers and negotiation: the released-offer email carries a private link (/offer/<token>) to accept, decline (with a reason) or ask for changes (expected CTC, joining date, note); each is recorded once on the offer and the stage and told to the desk; a request for changes ("countered") reaches the Offer agent (1.1.0), which revises inside the band (`revise_offer`), regenerates the letter and takes the next revision through HR head → CBO approval again; health rule `offer.negotiation_loop`
- [x] Hiring cost across the organisation (/hiring-cost): spend, cost per hire, month by month, by role, by hiring stage and by outcome (hired / not hired / in progress), in money at the model's published list price (or the organisation's own rates), unpriced models shown as tokens; price on file shown in AI model settings
- [x] Not-approved paths: an offer declined at the HR head / CBO step goes back to draft with the reason (Offer agent 1.2.0 revises it; Send back on the Offers page); rejected documents are re-requested with the reason (Pre-onboarding 1.2.0); closed / on-hold roles stop agents and withdraw time links; rejected candidates get a kind final email; declined or expired interview times are re-offered (coordinator 1.7.0, capped at three); expired assessments close; immediate verdict policy debriefs only; declining in the inbox asks why; offers for one- and two-round roles
- [x] Polish: ₹1.1 Cr no longer shows as ₹1 Cr; Indian digit grouping on agent cards; confirm before accepting an offer; budget / band position stated on offer approvals; ids kept out of agent text; duplicate document uploads skipped; requests waiting in a thread are pinned above the composer
- [x] Full-journey E2E fixes: interview rounds are offered only after the candidate's earlier round ends (Interview coordinator 1.6.0); the released-offer email (letter PDF + answer link) now goes out under Node too (jsPDF named import; failures logged as `offer.release_email_failed`); the Pre-onboarding agent (1.1.0) never re-requests documents received or not yet due and gets the offer id it needs for release; tools can refuse pointless calls before a person is asked (`precheck`); single-candidate coordinator runs and document reads count in the candidate's hiring cost; events are never dropped by an empty agent registry
- [x] Screening is not skipped silently: moving a candidate into an interview round with no screening on record needs a written reason (recorded as "Screening skipped"); the Interview coordinator (1.5.0) only plans rounds for screened candidates
- [x] Interview plans, panels and decisions: per-role plan (1–3 rounds, rubric from the must-haves, panel size, verdict policy) shown and edited on the requisition page; panels of up to 3 with times that suit everyone and a brief for each; one scorecard per interviewer, the round completes when all have scored; interviewer holds / rejects are recommendations by default; the hiring decision (select → offer) only after the final round — enforced by the runtime (Evaluation agent 1.2.0); no-shows / cancellations recorded, the desk told, new times offered (Interview coordinator 1.4.0); scorecards chased per interviewer (Follow-up 1.3.0); health rule `interview.no_shows`; migration 0034
- [x] Interviews: the interviewer gets their own invite and brief on every booking (calendar file, meeting link, candidate summary, match and screening highlights, profile and scorecard links); the Interview coordinator (v1.3.0) finds real free times from the connected Google / Microsoft 365 calendar (free/busy only), offers three, and the candidate picks one at a private link — booked once with invites to both; "none of these work" and expiry reach the desk thread; health rule `interview.slots_unanswered`; migration 0033
- [x] New CV → open roles: a person who joins the talent pool without a role is checked once against every approved open role (same evidence ranking as the pool search); a strong match joins that role's pipeline as "talent pool match", is scored within minutes and announced in the desk thread (Sourcing agent switched on; audited; migration 0032)
- [x] Desk after JD approval: what happens next (Intake / Publishing / Sourcing, on or off) with **Switch on and start**; a later JD version offers **Re-score** of candidates scored against the earlier one
- [x] "Show the JD" in the desk posts the saved job description (code, version, status, template, full text in a scrolling card, link to the requisition) instead of a summary
- [x] Desk: a job description under review can be sent back for changes from the chat ("use the Yavar template", "make it shorter") — the real "changes requested" step, role-checked; a template asked for by name is used by the JD agent (`templateName`, JD agent 1.3.0), templates are found by name or by what they contain ("the Yavar template" finds the one with "About Yavar" sections), a template already used is not re-requested, template questions are answered from the record (the desk knows the org's JD templates and which one the current JD used) and only ever go to the JD agent, and a template that does not exist is said plainly with the ones that do; an agent paused on its monthly budget shows tokens used / budget with **Raise to N and continue** (HR head / CBO / owner, audited), and any budget change releases parked runs at once; agent results in the thread never show internal ids
- [x] Talk to the agents through the desk: a change asked in chat ("more weight for experience") returns the pending request to its agent as **Changes requested** with the person's words; the agent revises and asks again; answers to agent questions are passed on; approval gates are never decided from chat; a desk reply that took no action says "Nothing was sent to the agents"; the re-proposed request is marked **Revised after your change** with each value before → after (or says plainly that nothing changed); every decision handed to an agent (changes requested, declined, answered, gate approved) is a `decision` step of its run with the exact words the agent was told, shown as "person → agent" in the run trail and in the desk's live activity
- [x] Hiring desk shows its thinking ("How I read that": understood, still missing, next) and researches what the person delegates ("as per market", "you decide"): skills, experience and pay as a proposal with sources, labelled live web research or estimate; "ok" / **Use these** applies it, editing the details supersedes it; the desk never promises an action it is not taking
- [x] Hiring desk follows the requisition: closing / rejecting a role (anywhere) stops its agents and ends the thread with who and why; "close this role" in the chat; the desk answers from live facts and the app's real rules; request cards show who they wait for

## Utilisation & efficiency, smarter matching, deeper JDs (2026-10-08)

- [x] Agent observability → Utilisation & efficiency: day-wise tokens (or cost at the organisation's own token prices — never assumed) by agent, day-wise agent working time vs time waiting for people, per-agent efficiency (tokens and cost per run, agent minutes, median wait, approvals per run, tokens wasted on failed runs, repeated reads), and "How to optimise" recommendations with evidence and estimated weekly savings (wasted spend, rubber-stamp approvals → Act and notify, waiting, long re-sent conversations, repeated lookups, dominant AI skill, slow turns, token growth, budget run-out date); migration `0031` (`agent_cost_rates`)
- [x] Hiring desk: one question for a deeper JD (responsibilities, reporting line, 12-month success, education — or "research it"); the JD agent picks the default / only / closest-named template and says which in the thread; a seniority-aware JD prompt
- [x] Talent-pool search by meaning (equivalent terms, CV text, whole words, experience band, location) with a reason per match; Intake agent v1.3.0
- [x] "Bring candidates in" when fewer than 3 match: upload CVs in the thread (parsed, added, scored), publish the role, or open the inbox / pool; "Why this score?" on every ranked candidate
- [x] Fixes: approving a JD no longer erases its full text; budget-paused agents are shown as paused in the journey; Send works with a one-character answer; switching an agent on resumes waiting threads; live agent activity and approval details in the thread

## Agent mode / Manual mode (2026-10-07)

- [x] A switch in the top bar separates the two ways of working: Agent mode shows Hiring desk, Waiting for you, Agent activity and agent administration; Manual mode shows the pipeline, sourcing and intelligence pages; dashboard, My interviews, administration and help show in both
- [x] Remembered per user in the browser; opening a page of the other mode switches the menu; switching away from a page of the other mode goes to that mode's start page (Hiring desk / Requisitions)
- [x] Hiring desk progress tracker: Need › Requisition approval › Job description › Candidates › Screening › Interviews › Hiring decision › Offer › Pre-onboarding & joining, with the next step, the responsible agent's state (working / waiting / stopped / switched off), **Try again** for a stopped run and **Switch it on** for a switched-off agent
- [x] Plain, vendor-neutral reasons when a thread's agent stops; a thread message when the next agent is switched off; approval chains labelled "Approval n of 3 · role", decided cards collapsed and a repeated brief hidden
- [x] Fix: Gemini thinking models — the gateway now keeps each tool call's `thoughtSignature` and sends it back (agents on Gemini failed on their second turn)
- [x] "Ask the agents" renamed "Give the agents a task" (for existing roles) and points new hiring needs to the Hiring desk; the HR copilot is labelled "Help and questions" with a link to the Hiring desk

## Agentic platform — Phase 6a: hiring desk (2026-10-07)

- [x] Hiring desk (`/desk`): one chat thread per hiring need; the desk asks one short question at a time until role, location, experience, openings and must-have skills are known, then shows similar roles as cards
- [x] Continue with an open role, create a new role (drafted as the person, then completed and submitted by the Requisition agent), or reuse an earlier role's approved JD (applied on approval, audited as `jd.reused`)
- [x] Runs working for a thread post their results, approval / decision / question cards (decidable in the thread) and, after matching, a ranked candidate list
- [x] "Talk to the first 5" or ticked candidates start the Screening agent; switched-off agents are reported in the thread
- [x] Migration `0030` (`hiring_conversations`, `hiring_messages`, `agent_runs.conversation_id`); `hiring_desk` AI ledger slug; `scripts/agent-phase6a.test.ts` (12 tests) in CI; user manual section; local demo seed includes two desk threads
- [ ] Next: 6b voice agent integration (screening calls) once the in-house voice API is available

## Agentic platform — Phase 5: hardening and scale (2026-10-06)

- [x] "Act and notify" now notifies: actions run without approval are listed for the person the agent works for (bell + Agents → "Acted for you") until marked seen; "autonomous" runs them silently (still in activity and audit)
- [x] Autonomy recommendations in Agent settings — per agent, measured over 30 days (decided requests, approved unchanged, edited, rejected, reported actions, tool errors, failed runs, open issues, days at the level), raise / lower / hold with the reason and an Apply button; template pre-approval hints; never applied automatically, saves audited with `viaRecommendation`
- [x] Dry-run replay of a finished run (HR head / CBO / owner): current definition, reads for real, writes / external / human steps simulated, no tasks or audit side effects; side-by-side comparison with a tool-sequence diff
- [x] Prompt-injection tripwire on untrusted tool output (step flag, audit, new `tools.injection` health rule — 12 rules)
- [x] Alert channels: e-mail to owner / HR heads / CBOs and an optional HMAC-signed webhook, once per serious or critical issue, audited
- [x] OpenTelemetry trace export (OTLP/HTTP JSON) to the org's own collector — ids, steps, timings and token counts only; encrypted headers; back-off; test buttons
- [x] Platform agent console (`/platform-agents`, super admins): scheduler, totals, per-organisation, per-agent cost and latency (run and model-turn p50 / p95, tokens per run, tool error and edit rates), per-model, recent failures
- [x] Migration `0029` (`agent_runs.mode / replay_of / otel_exported_at`, `agent_steps.notify_state / injection_suspected`, `agent_issues.notified_at`, `agent_telemetry_settings`); `scripts/agent-phase5.test.ts` (17 tests) in CI
- [x] Agent observability redesign: overall health summary, KPI tiles with 14-day sparklines, 14-day trend charts (runs by outcome, token usage, human-in-the-loop requested vs decided, tool calls succeeded vs failed, wait for a person against the SLA, AI p95 latency against the health threshold, runs by agent) and compact per-agent cards whose element rows open the detail drawer; the local demo seed now carries 14 days of history
- [ ] Not built: one-click undo of notified actions; per-replay model choice and a separate sandbox organisation; automatic cost / latency tuning

## Agentic platform — Phase 4: offer → pre-onboarding → release (2026-10-06)

- [x] Shared cores: `createOfferCore` (agents start at `draft`), `advanceOfferCore` (emits `offer.status_changed`; agent actions marked `via: "agent"` in the trail), `generateOfferLetterCore`, `reviewOnboardingDocCore`; a `onboarding.document_received` event when documents are filed
- [x] Offer agent — reads the candidate's compensation, the requisition band, the recorded hiring decision and internal parity (same role, last 12 months); drafts the offer **inside the approved band** (outside the band it must ask a person), generates the letter, submits it, and requests HR head then CBO approval with a brief
- [x] Pre-onboarding & release agent — readiness and extracted documents, compensation cross-check, document request email to the candidate (pre-approvable; catalogue types only), HR validation request, and the release request once every required document is verified
- [x] Inbox gates: offer approval (HR head → CBO, performed as the decider), document validation (approve verifies, decline rejects with the reason the candidate sees), offer release (HR head; refused until pre-onboarding is complete; moves the candidate to offer released); decisions on the Offers page close matching inbox requests
- [x] Orchestrator: hiring decision → Offer agent; offer approved → Pre-onboarding agent; a document arriving after approval → Pre-onboarding agent
- [x] New candidate email: pre-onboarding document request (offer email toggle)
- [x] Human-in-the-loop contracts changed again, so every existing agent moved one version under change control; lock covers 11 agents
- [x] `scripts/agent-phase4.test.ts` (8 tests) and real-agent evals for both new agents in CI

## Agentic platform — observability and health (2026-10-06)

- [x] Agent health engine (`src/server/agents/health.server.ts`, migration `0027`): 11 rules across harness (stuck runs, failure bursts), human-in-the-loop (requests past the 48 h SLA, serious after 120 h; high decline rate), tools (error rate), AI skills (error rate, p95 latency), budget (paused), definition (churn under running work), audit (write / external action without its audit entry) and orchestrator (failed or stale lifecycle events); evaluated every 5 minutes by the scheduler; issues open, re-see, escalate and auto-resolve; opened / resolved / acknowledged are audited
- [x] Scheduler heartbeat — a stopped scheduler is reported on read (it cannot report itself) in the observability page and the bell
- [x] Serious and critical issues reach the HR head / CBO / owner in the notification bell until acknowledged
- [x] Agent observability page (Governance → Agent observability): scheduler status, 7-day KPIs, detected issues with the rule that fired and its plain-language condition, and a panel per agent with every element's status and metrics (identity & definition, harness, human-in-the-loop, tools, AI skills, evals, budget, audit, orchestration), a 14-day runs chart and busiest tools
- [x] Fix: `candidate_notes.org_id` now cascades on organisation delete (migration `0028`) — deleting an organisation with notes failed, including platform tenant deletion
- [x] `scripts/agent-health.test.ts` (8 tests) in CI; `scripts/seed-agent-demo.ts` seeds observability activity locally
- [x] Agent detail drawer — click an agent (or any element on its card): identity & settings, every assigned tool with its risk, input contract, 7-day usage and last error, AI skills with the tools that use them, the harness limits / autonomy matrix / human-in-the-loop tools / instructions and recent runs, open and decided human requests, evals, audit events, and open and resolved issues

## Agentic platform — Phase 3: interviews → evaluation (2026-10-06)

- [x] Shared cores: `scheduleInterviewCore` (round, stage, candidate invite with calendar file) and `createMeetingLinkCore`
- [x] Interview coordinator — books the next round for candidates who advanced: panel limited to active members (prior interviewers first, then hiring managers / department heads), proposed working-hours slot, optional Zoom / Meet / Teams link; the candidate invite is reviewed unless the interview invitation is pre-approved. No calendar free/busy integration yet — slots are proposals a person reviews
- [x] Evaluation agent — debrief across match, screening, assessment and every scorecard (disagreements surfaced), organisation-wide selection-parity check, and a hiring decision request
- [x] Hiring decisions as inbox gates for the hiring manager — approving a reject or hold moves the candidate as the decider; approving a select records the decision and emits `hiring.selected` for the Offer agent (Phase 4); declining changes nothing; stale proposals cannot be decided
- [x] Orchestrator: advancing into a round (by a verdict, not by booking) starts the coordinator; each submitted scorecard starts one evaluation per candidate
- [x] Follow-up agent v1.1.0 also chases interviews that ended without a scorecard; human-in-the-loop tool contracts are now part of every manifest hash (all agents bumped to v1.1.0 under change control)
- [x] `scripts/agent-phase3.test.ts` (9 tests) and real-agent evals for both new agents in CI
- [ ] Calendar free/busy integration for slot finding

## Agentic platform — governance hardening (2026-10-06)

- [x] Agent manifests (`src/server/agents/definitions.ts`): identity, version, accountable owner, responsibility, permission scope, must-never list, gates, risk tier, evals; tools declare the AI skills they call
- [x] Version per run — `agent_definitions` stores each manifest version once by content hash (migration `0026`); runs record the definition they executed under; mid-run definition changes recorded and audited
- [x] Change control — `scripts/agents.lock.json` (`bun run agents:lock`); CI fails on a manifest change without a version bump and on any live agent without a real-agent eval
- [x] AI attribution — `ai_usage_events.agent_run_id` for every request inside a run, including AI calls inside tools
- [x] Monthly token budget enforced — over-budget agents pause (re-checked hourly, resets monthly), audited once, surfaced in the notification bell
- [x] Run lifecycle audit — started / completed / failed / definition changed / budget paused / exported
- [x] Real-agent eval scenarios for all seven live agents (`scripts/evals/scenarios.ts`); governance suite `scripts/agent-governance.test.ts`
- [x] Agent register (Governance → Agent register) and per-run trail export (JSON, vendor-neutral)

## Agentic platform — Phase 2: intake → match → screen (2026-10-06)

- [x] Pipeline cores (`src/lib/pipeline.server.ts`) shared by the screens and agent tools — stage moves, adding talent-pool candidates (now verifies the candidates belong to the organisation, closing a gap in `addApplicationsToRequisition`), candidate notes; `createAssessmentCore`
- [x] Rejection batches as inbox decisions — the Intake agent proposes rejections with a reason per candidate tied to the requisition's requirements; approving rejects them as the decider (anyone who moved meanwhile is skipped), declining rejects nobody; agents cannot reject on their own
- [x] Intake & matching agent (score new applications, review held candidates, shortlist / reserve with reasons, propose rejections, top up from the talent pool), Screening agent (screening kits, assessments with email invite and reminder, proceed / hold notes), Follow-up agent (daily overdue sweep: approvals, JD reviews, unanswered agent requests, incomplete assessments; reminders to members)
- [x] New emails: candidate assessment invitation (pre-approvable for agents) and internal member reminder
- [x] Orchestrator: shortlists start the Screening agent; sweeps start Intake for approved roles with unscored or held applications (6 h cooldown) and one Follow-up per organisation per day — only for switched-on agents
- [x] `scripts/agent-phase2.test.ts` (11 tests) in CI

## Agentic platform — Phase 1: requisition → JD → publish (2026-10-06)

- [x] Lifecycle cores (`src/lib/requisitions.server.ts`) shared by the screens and agent tools; every requisition / JD change emits a domain event (`agent_events`); trails mark agent actions `via: "agent"`; migration `0025` records who raised each requisition
- [x] Orchestrator v1 — requisition approved → JD agent; JD changes requested → JD agent (with the reviewer's comment); JD approved → Publishing agent; never duplicates an active run; inline best-effort kick after events and decisions, scheduler tick remains the source of truth
- [x] Requisition agent (similar roles → draft → market band with sources → scoring weights → submit → approval brief through DH → HR → CBO), JD agent (draft / revise → DH review), Publishing agent (internal posting, LinkedIn draft, board publish always reviewed by a person and only for an HR-head principal), Copilot (plans, `start_agent` confirmation)
- [x] Inbox gates tied to real records — approving or declining a requisition / JD request in the Decisions inbox performs the real approval step as the decider, with their role checked; decisions made on the regular pages close the matching inbox request
- [x] Agents are opt-in (off until switched on in Agent settings); "Ask the agents" on `/agents`; "Request changes" on a pending JD
- [x] `scripts/agent-phase1.test.ts` (real tools, cores and orchestrator; scripted model) in CI
- [ ] Live model verification with an organisation key (`bun run eval:agents`)
- [x] SLA chasing of approvers — delivered by the Follow-up agent (Phase 2)

## Agentic platform — Phase 0 foundations (2026-10-06)

Plan: `docs/agentic-plan.md`.

- [x] Gateway tool calling — `aiAgentStep` in `src/lib/ai-gateway.server.ts`: one provider-neutral agent turn (transcript + tool specs → text, tool calls, stop reason, usage) for OpenAI, Anthropic and Gemini native tool-calling dialects; org key only, every call in the `ai_usage_events` ledger under an `agent_*` slug, tool arguments returned unvalidated for the registry to check; `toolParameters` turns zod v4 schemas into tool JSON Schema; unit-tested with stubbed providers (`scripts/agent-gateway.test.ts`, in CI)
- [x] Agent tables and runtime — migration `0024` (`agent_policies`, `agent_events`, `agent_runs`, `agent_steps`, `agent_tasks`, `agent_metrics_daily`) and `src/server/agents/`: registry (agents list their tools; tools carry a zod v4 input, a read / write / external risk, optional template id and untrusted-output flag), autonomy policy (`suggest` / `act_and_notify` / `autonomous`, org-wide `'*'` pause), and the runtime — transcript-as-checkpoint runs on behalf of a human principal, lease/claim with reclaim, per-tick turn cap, step/token budgets, built-in `ask_human` / `request_approval` / `handoff`, approval tasks with edit-then-approve, role- or assignee-checked `resolveTask`, `cancelRun`, untrusted() fencing of third-party tool output, audit of every write/external action and decision; `/api/public/agent-tick` cron route; runtime suite against Postgres in CI (`scripts/agent-runtime.test.ts`)
- [x] Tool registry with agent identity in `audit_log` — runs act on behalf of a human principal; every write/external tool call is audited as `agent:<type>:<runId>` with `on_behalf_of`, every human decision as the deciding user
- [x] Agent settings page (`/agents/settings`, Governance) — org-wide pause, per-agent enable, autonomy (default `suggest`), pre-approved candidate emails (acknowledgement, stage update, interview invite — never the offer release mail) and monthly token budget; HR head / CBO / owner only, audited; agents not yet built are labelled "Not live yet"
- [x] Decisions inbox (`/agents`) — gates, action approvals (edit-then-approve, decline with reason) and questions routed by role or assignee (owner sees all); agent activity list with stop; agent requests in the notification bell and the dashboard "Needs you today" strip; provider error text never reaches the client; `scripts/seed-agent-demo.ts` seeds a local demo
- [x] Observability foundation — `src/server/log.ts` structured JSON logger (OpenTelemetry field names, `LOG_LEVEL`), runtime logs every run turn, crash and tool error with `trace_id` / `run_id`; `agent_steps` are the trace spans; `rollupAgentMetrics` (each tick, today + yesterday, idempotent) fills `agent_metrics_daily`; Agent activity shows 30-day tiles (runs, tokens, decisions, edited-before-approval rate, average wait for a person) and a per-run step inspector with the trace id; model-call error text stays server-side
- [x] Eval harness — `src/server/agents/eval.server.ts` runs a scenario (goal, fake tools, scripted human responses, expectations on tool order, forbidden tools, gate routing, result text and step budget) through the real runtime in a throwaway org; `scripts/evals/scenarios.ts` (requisition completion + department-head gate; prompt injection inside a CV ignored) runs with scripted replies in CI and live via `bun run eval:agents` (`EVAL_PROVIDER` / `EVAL_API_KEY` / `EVAL_MODEL`, local DB only); registry gate guard refuses any tool that would approve, release, reject, hire, revoke, decline or accept (only `propose_` / `request_` / `submit_`)

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
