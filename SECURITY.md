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
- HR copilot data is role-filtered on the server (`src/lib/copilot-scope.ts`,
  `src/server/copilot/data.server.ts`): recruiters receive no pay or budget figures, hiring
  managers and department heads only their own roles and approvals at their stage, governance
  (audit log, agent issues, AI usage by feature) only leadership; tools outside a scope are not
  offered to the model, so a prompt cannot widen access. Candidate names from pool lookups are
  fenced as untrusted. A proposed agent hand-off is stored server-side and started only by the
  person's click (claimed once); the client never supplies the goal.
- Secrets: `SECRET_ENCRYPTION_KEY` encrypts stored credentials (AES-256-GCM); OAuth state
  is HMAC-signed with required secrets; no secret values are committed. Every organisation supplies
  its own AI provider key, and no deployment-level AI key is used as a fallback. That includes the
  AI voice for phone screening: the organisation's Google API key or a Vertex AI service-account key
  it uploads (validated, stored encrypted, reported to the browser only as "stored"; saving and
  removing it are audited `ai.voice_credential.save` / `.remove`). The PBX extension the voice
  worker dials from (`SIP_*`) is deployment configuration; phone numbers are never logged.
  On a call the assistant says it is an AI; nothing is recorded before the candidate consents, the
  transcript is kept only after consent (no audio is stored), answers are accepted only for the kit's
  questions, and what it may write about the candidate is notice period and availability — the
  schema refuses pay fields (audited `compensation.recorded`, actor `agent:screening_call`).
  A candidate who asks not to be called by the AI assistant (on a call, or told to the team) is
  never requested, dialled or retried again — checked when a call is asked for, when it is claimed
  and just before dialling — and calls already waiting are cancelled (audited
  `candidate.ai_call_opt_out`; only TA, the HR head or the CBO can clear it, audited
  `candidate.ai_call_opt_in`).
  Silent panel agent (docs/silent-panel-agent-plan.md): only when the HR head switches it on
  (audited `panel_agent.settings_changed`) are a round's online meeting's own transcription
  switched on and its transcript read back, with the organisation's own meeting credentials (the
  extra read-transcript permission is asked for at connect time only then). The provider's meeting
  reference is read from the join link on the server, never taken from the browser; Zoom's
  transcript download is checked to be a Zoom host and fetched through `safeFetch`. The candidate's
  invite says the call is transcribed; a candidate who declines has it switched off and any stored
  transcript deleted (audited `interview.transcription_declined`). Transcripts are candidate data:
  org-scoped (`interview_transcripts`) and deleted with the application and the candidate.
  The L1–L3 panel agents never see a transcript or their own score: their tools read the
  transcript, send it to the AI gateway only inside `untrusted(...)` with `INJECTION_RULES`
  (features `panel_assess`, `panel_summary`, zod-validated), store the view hidden in
  `panel_assessments` and return counts only — so no approval card, run log or message carries the
  score. Each agent's tools refuse rounds of another level. Quotes are kept only if they are in the
  transcript, and any summary sentence carrying a score, verdict or recommendation is dropped
  before the panel's e-mail is sent.
  The agent's view is compared with the panel's only after every panellist has scored, by a
  fixed rule in code; the HR head's review card is built by the system (the agent cannot write
  it), and the decision runs as the HR head with `assertRole` — no agent moves a candidate.
  Reconciliations and decisions are audited (`panel_review.reconciled`, `panel_review.decided`).
  A scheduling call books only the e-mailed times or up to three alternates checked free when it
  is arranged — by number, never a free-form time — through the same booking core as the
  candidate's link (one booking per offer); a person approves each call (audited
  `scheduling_call.requested`).
  Staff are confidential to candidates: the interview invite e-mail, its calendar file and the
  time-choice page say only who an interview is with ("the hiring team" / "a panel of N from the
  hiring team", `src/lib/interview-with.ts`), never a name; and on calls neither voice agent names or describes the hiring manager,
  recruiters or the interview panel — the call's facts carry only how many interviewers there are,
  and the only contact given is the organisation's mailbox. Each voice agent's dos and don'ts are
  one charter (`src/server/voice/charter.ts`, `docs/voice-agents-charter.md`), printed into every
  call and the source of its must-never list.
- Voice Guard (docs/voice-guard.md): every answered AI phone call is reviewed after it ends,
  observe-and-report only. The agent has two tools: read one call, and file its review. It has no
  tool that touches a call, a candidate or a decision. Candidates are told the call "is checked
  for quality", and their consent is refused in code until that was said. Without consent nothing
  they said is kept, and only the call's line stats (no words) are reviewed, by the system. The
  transcript reaches the Voice Guard as untrusted data. Its findings must quote the transcript; a
  quote not in the named turn is dropped. Reviews quote transcripts that carry stated pay, so
  Call reviews is for TA, the HR head, the CBO and owners only. Marking a review is audited
  (`call_review.acknowledged`, `call_review.requeued`). Reviews and the call's stored brief and
  line stats are erased with the call. The Voice Guard cannot be switched off while an AI phone
  agent is on.
- Rate limiting on all public HTTP routes and server-function RPCs (`src/server.ts`), a tighter
  budget on `/api/auth` mutations (sign-in, registration, password reset), shared across
  instances through Postgres when `RATE_LIMIT_STORE=postgres` (production).
- CSRF guard on every mutating server-function RPC and `/api/auth` call (Fetch-Metadata
  `sec-fetch-site` plus an origin allowlist — the session cookie is `SameSite=None` for the
  browser companion, so the browser alone cannot be the boundary); HSTS on every response and a
  `default-src 'self'` content-security policy (2026-11 audit N-5).
- SSRF connect pinning: after `safeFetch` vets a user-supplied host, the connection is pinned to
  the vetted address with an undici dispatcher, so a DNS rebinding between the check and the
  connect cannot retarget the socket (2026-11 audit N-2; Bun's fetch ignores dispatchers, where
  the pre-connect vetting remains the guard).
- Step-up re-authentication: releasing an offer and rejecting candidates in bulk (directly, or by
  approving an agent's offer release or rejection batch) need the password re-entered in that
  session within 10 minutes; audited `auth.step_up` / `auth.step_up_failed`, locked after five
  wrong passwords in 15 minutes.
- Sandboxed document parsing: with `PARSER_URL` set, uploaded and mailed documents are parsed by a
  separate service with no network egress, no roles and IAM-only invocation, never in the app
  process; an unreachable parser yields no text (`infra/network/parser-sandbox.sh`).
- SSRF gate: server-side fetches of user-supplied URLs go through `src/server/safe-fetch.ts`.
- Auditing: privileged actions append to `audit_log` (`src/server/audit.ts`), including member
  invites (`member.invited`) and interviewer-profile changes (`member.interviewer_profile.set`,
  owner, CBO or HR head only), a role's hiring manager (`requisition.hiring_manager_set`, an active
  member only) interview-plan changes (`requisition.interview_plan_updated`) and approved interview panels
  (`role_panel.approved`, decided by the role's hiring manager or the HR head — agents only propose
  with `propose_panel`, a proposal tool that always opens a person's decision), stand-ins for one
  candidate's round (`round_substitute.approved`, same deciders, proposed with `propose_substitute`)
  and interviewers saying they cannot make a round (`interview.interviewer_unavailable`, only
  someone on that round, before it starts).
- Observability data: request logs, metrics and SLO tables hold ids, route templates (ids replaced
  by `:id`), status, durations and counts only — never request bodies, candidate content, prompts,
  tokens from URLs or vendor/model names. Metric labels are a fixed low-cardinality set
  (`route_group`, `method`, `status_class`). `/metrics` is off unless `METRICS_TOKEN` is set, then
  requires it as a bearer token (constant-time compare) and is rate-limited like other public paths.
  The Service health page and its server function are platform-admin only; SLO alert webhooks are
  HMAC-signed and sent through `safeFetch`; SLO alert notifications are audited. Incoming
  `traceparent` headers are validated and only their ids are reused.
- AI safety (full reference: `docs/guardrails.md`): untrusted CV, JD, profile and mail text is
  fenced with `untrusted()` before prompting, and every fence look-alike (any case, spacing,
  attributes, full-width brackets, invisible characters) is stripped so the fence cannot be closed
  early. Structured model responses are schema-validated before use, including the CV scorer.
  A deterministic tripwire checks CV text at intake and scoring alongside the model's own flag; a
  flagged candidate is never recommended "select" and never auto-advances. An agent run whose tool
  output tripped the tripwire is tainted: every later write or outbound action waits for a person,
  whatever the autonomy level. Text hidden in a CV (white, tiny, invisible, hidden Word runs)
  is removed and replaced by a marker that flags the candidate; the public apply page fences and
  validates the applicant's CV text. Strings in model output that repeat the system prompt's
  instructions are redacted. The organisation profile has a two-person rule (author ≠ approver,
  self-approval only when no other approver exists, audited) and a score-drift health rule.
  Organisations can cap monthly AI tokens and daily automatic scorings per role (gateway-enforced,
  audited `ai.limits.save`). Switching an agent to Autonomous needs a passed model safety check —
  red-team probes against the organisation's own model, valid 30 days for that model, audited
  `ai.safety_check.run` (`docs/red-team.md`). AI decisions retain evidence and permit audited
  human override.
- AI usage ledger: every provider request is recorded in `ai_usage_events`
  (organisation, feature, provider, model, token counts, attempt, latency, outcome) directly from
  the gateway. The ledger is read-only to platform super admins via `/platform-ai-usage` and gives
  per-tenant AI visibility without exposing model identities to tenant users — vendor and model
  names stay inside the organisation's own integrations settings.
- Files: CVs and screening recordings remain private in S3-compatible storage and are served through
  authorised application paths rather than public object URLs.
- CI: typecheck, lint, `bun audit --level high`, gitleaks, integration tests (`.github/workflows/ci.yml`).
  Actions are pinned by commit SHA and base images by digest; Dependabot proposes updates; the CI
  token is read-only; deployed images carry an SBOM and SLSA provenance and are deployed by digest.

## Data and dependency boundaries

PostgreSQL is the operational system of record. Authentication, files, AI providers, meeting services,
email and job boards are external trust boundaries with narrowly scoped credentials. Public capture,
webhook, OAuth callback and scheduler endpoints validate callers, validate payloads and are rate limited.

The candidate's offer page (`/offer/<token>`) is public in the same way: a 64-hex token set when the
offer is released (a revision gets a new one), showing only that offer's role, CTC, joining date and
letter; it records one answer (accept, decline, ask for changes) on a released offer — claimed in the
update itself — and its server functions are rate-limited with all other RPCs.

The candidate's pay & availability page (`/pay/<token>`) is public in the same way: a 64-hex token per
request, showing only the candidate's first-party view (name, role, organisation, due date) — never
any amount, not even their own after submitting. It records one submission (claimed in the update
itself; expected CTC, notice period and consent are required and range-checked), refuses closed,
cancelled or expired links, and its server functions are rate-limited with all other RPCs. The
answers are readable only by TA, the HR head, the CBO and owners (role-checked server-side); audit
entries and thread messages record that details changed, never the amounts.

Deleting a hiring-desk chat is limited to chats still gathering details (their starter, or the HR
head / CBO / owner) or holding only an unused draft requisition (HR head / CBO / owner, with a reason);
the server enforces the stage and role. Deletions are audited, hidden at once and restorable by an
owner for 30 days, then purged; agent runs and the audit log are kept.

Requisition scoring weights decide how every candidate is ranked, so they are role- and stage-checked
on the server: a draft by its raiser or the HR head / CBO, an approved role by the HR head / CBO only,
never while in approval (send it back for changes instead) or once closed; they must total 100 and every
change is audited with its before and after values. Sending a requisition back for changes is limited to
the current approver, its raiser and HR leadership, and is recorded on its approval trail.

The candidate's pay discussion page (`/negotiate/<token>`) is public in the same way: a 64-hex token
issued only when a person approved the message, showing that message, the proposed figure and its
levers; it records one answer (accept, another figure, a call) — claimed in the update itself —
refuses closed links, and its server functions are rate-limited with all other RPCs. The message is
never sent without a person's approval, whatever the agent's autonomy (the tool has no pre-approvable
template), and no figure above the approved ceiling can be agreed.

The AI pay call (Negotiation call agent, docs/negotiator-voice-agent.md) never holds the ceiling or
band: its prompt carries no figure, and no in-call tool takes an amount — `state_offer` hands back the
words for the approved proposal or the one improved figure (above the proposal, at or under the
ceiling, checked by the database). An agent's request for the call is never pre-approved (the HR
head approves every one); TA / HR arranging it need a pay role. The call writes only what it heard
(`offer_negotiations.call_outcome`); "agreed" is still set only by a person through
`recordNegotiationOutcome` (role-checked, ceiling-guarded). Audit entries and thread posts carry no
amounts.

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

Job distribution (`docs/job-distribution-research.md`) never logs into a job portal or reads a
portal's CV database — every portal's terms forbid automated access; channels without an
integration are posted by a person. The public job feeds (`/api/public/feeds/<token>/<format>`)
are rate-limited with every `/api/public` route and list only approved roles the HR head put on
that feed, never roles hired for a client, and only what a candidate may see (no budget, band,
weights or approval trail); the feed token is 24 random bytes stored with `encryptSecret` and a
SHA-256 lookup hash, replaceable by the HR head (audited). Google for Jobs structured data is
built server-side from the same candidate-facing fields and escaped for an inline script; the
Indexing API is called only at Google's two fixed endpoints with a platform service account.
CVs a portal hands over under terms that limit them to the role they were for (Naukri, Internshala,
Job Hai — `candidates.pool_use = 'role_only'`, migration 0045) are never added to another role,
searched, matched, invited or shown through a consortium pool share, and are erased 30 days after
their roles are over — only after the HR head approves the Distribution agent's request, even for
an Autonomous agent (audited `candidate.erase_role_limited`, counts only; health rule
`distribution.role_limited_retention` flags any kept a week longer). The ATSIQ Capture companion posts on portals with no integration (Internshala, Apna) only in the
person's own signed-in browser and only when they press it: it fills the form and never submits,
never stores or sends a portal password or session, and records a posting
(`/api/public/distribution`, authenticated with a token derived from the capture key so a
key visible to a portal cannot be replayed against candidate capture, rate-limited,
CORS-allowlisted) only with a
listing link on that portal's own domain. Tracked apply links keep only known channel names (`?src=`), so a link cannot invent a source.
Including a role on a feed, recording a hand posting and switching Google listing are
`hr_head`-gated and audited.

The organisation profile (`org_profiles`, `org_profile_versions`, migration 0054) is written by the
HR head, CBO or owner and approved, sent back or declined only by the HR head or an owner
(`assertRole('hr_head')`, which the owner passes), server-side — from the Profile page or an
agent's approval card (gate subject `org_profile`), never by an agent. Before anything is saved,
lines carrying a pay figure (a money amount, LPA/CTC, lakh/crore/k or a percentage next to a pay
word) or a staff member's name, e-mail or phone number (organisation members and HRMS employees)
are refused with the reason; the audit entry records the reasons, not the text. Text that reads
like instructions to an AI is flagged to the approver. Approved versions are never edited; every
draft, edit, submission, decision and change to the "require an approved profile" setting is
audited (`org_profile.*`). That setting is enforced in `createRequisitionCore`, so the requisition
page, the hiring desk and the Requisition agent are all refused alike.

Agent telemetry leaves the platform only to destinations an organisation configures (HR head /
CBO / owner, audited as `agent.telemetry.updated`): OpenTelemetry trace export and alert webhooks
are sent through `safeFetch` (https only, private ranges blocked), collector header values and the
webhook signing secret are stored with `encryptSecret` and never returned to the browser, and
alert webhooks are signed with HMAC-SHA256 (`X-ATSAgent-Signature: sha256=<hex>`). Exported spans
and alerts carry ids, rule names, statuses, timings and token counts only — no goals, prompts,
candidate content or model names.

## Organisation agreements

An organisation cannot be created without its registering signatory accepting the current Terms of
Service, Privacy Policy and Data Processing Agreement (`src/lib/legal/`): `createOrganization`
validates the acceptance and refuses versions that are not current, and every acceptance is stored in
`org_agreements` (migration 0052) with the signatory's user, name, title, work email and time, and is
audited as `org.agreement.accepted`. The request IP is kept only as an HMAC-SHA256 keyed with
`SESSION_SECRET`, never in the clear. Re-acceptance of a new version is owner-only
(`requireOrgOwner`) and scoped to the owner's organisation; until it is done the workspace shows a
blocking step (owner) or a waiting screen (members). The cross-tenant view is `requirePlatformAdmin`.
Rows are deleted with the organisation; the audit entries remain.

## Training data

`training_inferences` and `training_feedback` hold prompts and outputs that
include candidate personal data, so they are treated like the candidate record:
written only for organisations whose owner agreed (off by default, audited),
deleted with the candidate or organisation, after the retention period, or on
an owner's request, and exported only pseudonymised and audited
(`scripts/training-export.ts`). Model and vendor names in these tables never
reach the client. See docs/agentic-plan.md §14.

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
