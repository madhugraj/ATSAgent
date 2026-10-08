# ATSAgent — local test guide (agents, everything except voice)

A step-by-step script for testing the agentic hiring flow on your own machine:
hiring desk, agents and decisions, autonomy, observability, replay, alerts,
trace export and the platform console. **The voice agent (Phase 6b) is not
covered** — screening and scheduling calls are not built yet.

Each test has an ID, the steps, and what you should see. Tick them off as you
go; when something is wrong, note the ID and see [Reporting a problem](#reporting-a-problem).

---

## 0. One-time setup

### 0.1 Prerequisites

- Bun, Node 22+, PostgreSQL 16 running locally.
- An AI provider key (OpenAI, Anthropic or Google) **for a test organisation** —
  every agent step and every hiring-desk message uses it.
- Optional: [Mailpit](https://mailpit.axllent.org/) (or any local SMTP catcher)
  to see the emails agents send.

### 0.2 Environment (`.env.local`, never committed)

| Variable                | Value                                                                            |
| ----------------------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`          | your local database, e.g. `postgres://postgres:postgres@127.0.0.1:5432/atsagent` |
| `SESSION_SECRET`        | any random string of 32+ characters                                              |
| `PUBLIC_SITE_URL`       | `http://localhost:8080`                                                          |
| `CRON_SECRET`           | any random string — the scheduler loop below sends it                            |
| `SECRET_ENCRYPTION_KEY` | `openssl rand -base64 32` — so the AI key is stored encrypted                    |
| `SMTP_URL` (optional)   | `smtp://127.0.0.1:1025` when Mailpit is running                                  |

Without `SMTP_URL`, emails are queued and then marked failed in the outbox;
everything else still works.

**Real delivery through Resend (optional).** ATSAgent sends only through
`SMTP_URL`; it does not have the in-app Resend transport of the production
ATSIQ app. Resend's SMTP relay works with it unchanged:

```
SMTP_URL=smtps://resend:<RESEND_TEST_API_KEY>@smtp.resend.com:465
EMAIL_FROM=ATSIQ <noreply@your-verified-domain>
```

- Use a **separate test key** (Sending access, restricted to your domain) —
  never the production key.
- The seeded candidates have fake addresses (`@demo-candidate.test`); sending
  to them through your domain bounces and harms its reputation. Use Mailpit
  for bulk testing, and switch to Resend only for delivery checks addressed to
  your own inbox or `delivered@resend.dev`.
- With Resend set, every email an agent sends (after your approval where
  required) is delivered for real.

### 0.3 Database, demo data, app

```bash
set -a; source .env.local; set +a
bun install
bun run db:migrate
bun scripts/seed-agent-demo.ts
bun run dev
```

Open `http://localhost:8080` and sign in with the demo login written at the
top of `scripts/seed-agent-demo.ts` (organisation owner of "Agent Demo Org").

The seed creates: requisitions REQ-2026-104 (waiting for the department head)
and REQ-2026-098 (approved, with candidates), sample agent runs and requests,
14 days of activity for the dashboards, open health issues, and two hiring-desk
threads. **Re-running the seed deletes and recreates the demo organisation and
signs you out.**

### 0.4 The agent scheduler (keep it running in a second terminal)

Agents pick up most work immediately, but sweeps, retries, health checks and
alerts need the scheduler tick. Locally, run this loop:

```bash
set -a; source .env.local; set +a; while true; do curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:8080/api/public/agent-tick; echo; sleep 60; done
```

Each line it prints is one tick (`claimed`, `done`, `awaiting`, …). To send
queued emails to Mailpit, run the same loop against
`/api/public/process-email-outbox`.

### 0.5 In the app

1. **Integrations → AI model**: choose the provider, paste the key, Save. The
   key is never shown again (only that one is saved).
2. **Agent settings**: switch on the agents you want to test (all of them for a
   full run). Leave autonomy at **Suggest** unless a test says otherwise.
3. Close the HR copilot panel if it opens on first login.

> Note: the demo user is the **organisation owner**, who passes every role
> check (department head, HR head, CBO). That lets one person walk the whole
> flow. To test that approvals reach the right roles, invite colleagues in
> Users & roles with those roles (needs `SMTP_URL` for the invitation mail).

---

## 1. Hiring desk (Phase 6a)

Open **Hiring desk** in the left menu.

| ID  | Steps                                                                                                                                                         | Expected                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Click **New hiring need**, type _"Hey, I need a candidate for Full stack, Chennai"_, Send.                                                                    | A new thread; the desk asks **one** question (e.g. years of experience). The title becomes "Full Stack Developer · Chennai".                                                                |
| D2  | Answer the questions as they come (e.g. _"3 to 6 years, React and Node are a must"_).                                                                         | One question per turn until role, location, experience, openings and must-have skills are known. Then "Got it: …" with a summary and a **similar roles** card.                              |
| D3  | Change a detail mid-way (_"make it 2 openings"_).                                                                                                             | The summary reflects the change; nothing else is lost.                                                                                                                                      |
| D4  | On the card, click **Create a new role**.                                                                                                                     | "Created draft REQ-… for …" with an **Open REQ-…** link; the requisition exists as a draft created by you. "I've asked the Requisition agent …" follows.                                    |
| D5  | Wait (or let one tick run).                                                                                                                                   | Requisition agent requests appear in the thread as cards (under Suggest every change asks first). Approve them in the thread. It adds the pay band and weights and submits the requisition. |
| D6  | Approve the requisition through the chain (thread card, Agent decisions, or the requisition page).                                                            | Status moves pending DH → HR → CBO → approved. The JD agent starts and its JD comes back for **department head approval** as a card.                                                        |
| D7  | Approve the JD.                                                                                                                                               | "The job description is approved…" and the Intake & matching agent starts. When it finishes: its summary and a **ranked candidate table** (score, fit, strengths / gaps).                   |
| D8  | Type _"talk to the first 2"_.                                                                                                                                 | "Screening 2 candidate(s): …" in rank order; the Screening agent starts and prepares screening kits. (No calls — voice is Phase 6b.)                                                        |
| D9  | Tick two other candidates in the table and click **Screen selected (2)**.                                                                                     | Same as D8 for the ticked candidates.                                                                                                                                                       |
| D10 | New thread for a role similar to REQ-2026-098 (_"Platform SRE in Bengaluru, 4–8 years, Kubernetes and Go, one person"_). On the card click **Use this role**. | "Continuing with REQ-2026-098 …" — since it is approved, matching starts (or the JD agent, if it has no approved JD).                                                                       |
| D11 | Create a role similar to one whose JD is approved and click **New role, reuse this JD**; approve the new requisition.                                         | On approval: "…the approved job description of REQ-… has been reused" — no new JD approval. The audit log shows `jd.reused`.                                                                |
| D12 | In Agent settings switch the **Intake & matching agent** off, then repeat D7 on a new role.                                                                   | The thread says the agent is switched off instead of waiting silently. Switch it back on afterwards.                                                                                        |
| D13 | Remove the AI key (Integrations), send a desk message, then restore the key.                                                                                  | A clear message to add the AI key; nothing is created.                                                                                                                                      |
| D14 | Open the seeded **Platform SRE · Bengaluru** thread.                                                                                                          | Full history, similar-role card ("Role settled"), ranked table, and an open approval card with Approve / Decline.                                                                           |

## 2. Agent decisions and autonomy

Open **Agent decisions**.

| ID  | Steps                                                                                              | Expected                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | **Waiting for you**: approve an action request unchanged.                                          | It disappears from the list; the agent continues (next tick at the latest).                                                                      |
| A2  | Edit the proposed details (JSON) of another request, then approve.                                 | The agent acts with your edited values; the run trail shows the edit.                                                                            |
| A3  | Decline a request with a reason.                                                                   | The agent is told and carries on without that action.                                                                                            |
| A4  | Answer a question card.                                                                            | The run resumes with your answer.                                                                                                                |
| A5  | Agent settings: set the Screening agent to **Act and notify**; trigger screening (D8).             | Internal changes run without asking; the bell shows "Agents acted for you"; **Acted for you** tab lists them; **Mark all seen** clears the bell. |
| A6  | Set it to **Autonomous** and repeat.                                                               | Same changes run, **no** notification; they still appear in Agent activity.                                                                      |
| A7  | Under Act and notify, try a candidate email that is **not** pre-approved (e.g. assessment invite). | It still waits for your approval. Tick the template under "Pre-approved candidate emails" and it sends on its own next time.                     |
| A8  | **Pause all agents** in Agent settings, start something, then un-pause.                            | Nothing runs while paused; work continues after.                                                                                                 |
| A9  | Set a small **monthly token budget** (e.g. 1000) on an agent and give it work.                     | Runs pause at the budget; the bell and observability show it. Clear the budget to resume (next hourly re-check or a new month).                  |
| A10 | Agent settings: read the **recommendation** on each switched-on agent; click **Apply** on one.     | The evidence line (decided, unchanged, edited, rejected, errors, days at level) and a reason; Apply changes the level and is audited.            |
| A11 | **Agent activity** tab: open **Steps** on a run, then **Export trail (JSON)**.                     | Step-by-step trail; the export downloads a JSON file with the run, its definition, steps, decisions, audit and AI requests (no model names).     |
| A12 | Stop a running or waiting run with **Stop**.                                                       | It shows Stopped; its open requests are cancelled.                                                                                               |

## 3. The rest of the pipeline (agents beyond the desk)

These use the seeded REQ-2026-098 or a role you created in section 1.

| ID  | Steps                                                                                            | Expected                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | Move a screened candidate to an interview round (e.g. L1) on the candidate / screening pages.    | The Interview coordinator proposes a panel and slot and asks to book; on approval it books the round and emails the invite. No video link unless a meeting provider is connected; **no calendar free/busy check**. |
| P2  | Submit an interview scorecard for that round.                                                    | The Evaluation agent writes a debrief, flags disagreements, runs the parity check and sends a **hiring decision** to the hiring manager (you).                                                                     |
| P3  | Approve the decision as **select**.                                                              | The Offer agent drafts the offer **inside the band**, generates the letter and requests HR head then CBO approval.                                                                                                 |
| P4  | Approve the offer twice (HR head, CBO).                                                          | The Pre-onboarding agent requests documents from the candidate (email), then asks HR to validate as documents arrive.                                                                                              |
| P5  | Upload / receive the candidate's documents, validate them, then approve the **release** request. | Release is only offered once every required document is verified; the release email goes out.                                                                                                                      |
| P6  | Leave an approval untouched for a while (or use the seeded overdue question).                    | The Follow-up agent nudges the approver once a day (member reminder email); the 48 h SLA issue appears in observability.                                                                                           |

## 4. Observability, health and alerts

Open **Agent observability** (Governance).

| ID  | Steps                                                                                                                                  | Expected                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Load the page.                                                                                                                         | Health summary, KPI tiles with sparklines, 14-day charts (runs by outcome, tokens, human-in-the-loop, tool calls, wait vs SLA, AI latency, runs by agent), issues, agent cards.       |
| O2  | Hover the charts.                                                                                                                      | Tooltips with the day's values.                                                                                                                                                       |
| O3  | Click a row on an agent card (e.g. **Tools**).                                                                                         | The detail drawer opens on that tab: assigned tools with risk, input contract, 7-day calls / errors, last error. Check the other tabs too.                                            |
| O4  | **Acknowledge** an issue.                                                                                                              | Marked acknowledged; it leaves the bell but stays listed until the condition clears.                                                                                                  |
| O5  | Stop the scheduler loop (0.4) for 6 minutes, reload.                                                                                   | "Agents are not picking up work" / scheduler stopped, and a bell alert. Restart the loop.                                                                                             |
| O6  | Agent settings → **Trace export and alerts**: tick e-mail alerts; with Mailpit running, create a serious issue (e.g. let 3 runs fail). | Within ~5 minutes of the issue opening, the owner / HR heads / CBOs get one alert email; a second evaluation does not send it again.                                                  |
| O7  | Optional: set an alert webhook / trace collector address **you control** (https), save, use **Send a test …**.                         | Success or a clear error (HTTP status). Header values and the secret are never shown again after saving.                                                                              |
| O8  | Agent activity → **Replay** on a finished run, then **Compare** on the new "Dry-run replay".                                           | The replay runs under the current definition; changes, emails and questions are **simulated** (nothing changes, nobody is asked). Compare shows both runs and the tool-sequence diff. |

## 5. Platform console (super admin)

The platform console is for the product owner. Locally, make the demo user a
super admin with:

```bash
set -a; source .env.local; set +a; psql "$DATABASE_URL" -c "insert into platform_admins (email) values ('agent-demo@test.local')"
```

| ID  | Steps                     | Expected                                                                                                                                                               |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Open **Platform agents**. | Scheduler status, totals, per-organisation, per-agent cost and latency, per-model table (model names are allowed here), recent failed runs. 24 h / 7 / 30 days switch. |
| S2  | Open **AI usage**.        | Every AI request, including the hiring desk (`hiring_desk`) and agent steps.                                                                                           |

Remove the grant afterwards: same command with
`delete from platform_admins where email = 'agent-demo@test.local'`.

## 6. Safety checks (spot-check while testing)

| ID  | Check                                                                                                                      | Expected                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| X1  | Look for AI vendor or model names anywhere outside Integrations → AI model and the platform console.                       | None.                                                             |
| X2  | Try to approve a requisition / offer / release from an agent request without the role (invite a recruiter-only user).      | Refused with a permission message; the request stays open.        |
| X3  | Agents never approve requisitions, JDs or offers, reject candidates, make hiring decisions or release offers on their own. | Each of these always waits for a person, at every autonomy level. |
| X4  | A second recruiter (invited) opens Hiring desk.                                                                            | They see only their own threads; HR head / CBO / owner see all.   |

---

## Reporting a problem

For each failure note: the test ID, what you did, what you expected, what
happened, and the time. Also attach:

- the **run** (Agent activity → Steps → Export trail (JSON)) if an agent was
  involved;
- the scheduler terminal output around that time;
- the `bun run dev` terminal output (server logs are one JSON line each; look
  for `"severity":"ERROR"` or `"WARN"`).

## Known limits in this build

- Voice calls (screening, scheduling, pre-offer) are not built — Phase 6b.
- Interview scheduling has no calendar free/busy check.
- Acceptance links, pre-joining check-ins, HRMS handoff and closure mails are
  planned (Phase 6d–6e), not built.
- The demo organisation has no AI key until you add one (0.5).
