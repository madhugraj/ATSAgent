# Agent workflows

**Platform super admin only** (Platform → Agent workflows, `/platform-agent-workflows`). Server functions:
`src/lib/platform-agent-workflows.functions.ts` (all `requirePlatformAdmin`); engine:
`src/server/agents/workflows.server.ts`.

A workflow says which agents run, in what order, and under what conditions — drawn on a canvas, tested,
approved, published, and granted to the organisations the super admin picks. It runs alongside the
built-in hand-offs (the orchestrator's own chain is unchanged).

## Steps on the canvas

| Step                           | Properties                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Trigger** (one per workflow) | The domain event that starts it (`AGENT_EVENT_TYPES` in `events.ts`, e.g. `application.shortlisted`)                                                                                 |
| **Agent**                      | A stock agent or a published studio agent, and its goal. The goal may use `{{payload.<field>}}`, `{{subject_type}}`, `{{last.result}}`                                               |
| **Condition**                  | `field` (`payload.<field>`, `subject_type`, `last.status`, `last.result`), comparison (equals, is not, contains, >, ≥, <, ≤, is present) and value; two ways out, **yes** and **no** |
| **End**                        | Stops the flow                                                                                                                                                                       |

Drag steps from the palette, connect them by dragging between handles, select a step to edit it,
press Delete to remove it. Rules: exactly one trigger with a real event; every step connected to the
trigger; one way out of each step except conditions (one yes, one no); no loops; agents must exist;
goals not empty; at most 40 steps.

## Build with chat

**Build with chat** in the editor opens a chat panel: describe the flow ("when candidates are shortlisted,
screen them; if screening fails, have the follow-up agent remind the team") and the assistant draws the graph
and writes its dry-run tests onto the canvas. Ask for changes in the same chat ("add a wait for JD approval") —
it edits the current canvas. Server: `assistWorkflow` (`requirePlatformAdmin`); engine:
`src/server/agents/workflow-assistant.server.ts`.

- **Drafts only.** Nothing is saved; **Save draft** (marked • while unsaved) then Test → Approve → Publish →
  Grant as usual. It cannot approve, publish or grant.
- **Checked like Test.** The draft is checked with the same graph rules and dry run; when it fails, the
  assistant gets one repair turn with the problems. The reply says whether its tests pass.
- **AI key.** Keys are per organisation, so the chat uses the key of an organisation the super admin owns
  (picked in the panel when they own several). The call goes through `aiJson` with feature
  `workflow_assistant`; messages enter the prompt as untrusted data and the model's JSON is zod-validated.
- Each turn is audited as `platform.agent_workflow.assisted`.

## Going live in an organisation

A workflow runs in an organisation only when it is **published**, **granted** there, and the organisation
can run it. The go-live check (`workflowReadiness` in `workflows.server.ts`) says what is missing:

- **AI key** — the organisation's own key (Integrations → AI model).
- **Every agent the flow starts switched on** there (Agent settings); shows its autonomy when on.
- **Studio agents granted** to the organisation.

Where it shows:

- **Platform → Agent workflows → Organisations** — each organisation with _Ready_ / _Not ready_ and the items.
  Granting a not-ready organisation is allowed, with a warning.
- **The organisation's Agent settings → Workflows** (HR head, President / CBO, owner;
  `src/lib/org-workflows.functions.ts`, read-only) — every granted workflow, what starts it, _Live_ / _Not
  ready_, a **Switch on** shortcut for each missing agent (normal `saveAgentPolicy`, autonomy Suggest) and its
  latest runs.
- **The bell** — owners and HR heads see "Workflow … is not running yet" until it is ready (derived live, so
  it disappears by itself).

## What a run is waiting for — and deciding it in place

A waiting run says why, in plain words (`waitingOnFor` in `workflows.server.ts`): **"<agent> is waiting for
you — 1 question"**, **"<agent> is working"**, or **"Waiting for <event>"** ("An earlier <agent> run" when it
waits behind one). Each run on the Runs tab is drawn as its flow: steps done, the step it is on, and what comes
next up to the next condition.

A run's open requests (questions, approvals, gates) are answered **inside the workflow window** — under the run
on the Runs tab (for organisations the super admin belongs to) and in the organisation's Agent settings →
Workflows — with the same card and decision path as Waiting for you (`listWorkflowRunTasks` returns only that
run's agents' requests, org-scoped, same visibility; `decideAgentTask` records the decision, step-up included).

## Workflow app and API

**Sharing with HR and TA.** Once a workflow is published and granted, the platform admin presses **Copy link**
next to the organisation (Builder → Organisations) and sends it to that organisation's HR or TA. The link opens
**`/desk?workflow=<workflowId>`**: the hiring desk lists every shared workflow under **Workflows** in its
sidebar (with a count of live runs, amber when one needs a person), and the workflow opens inline there.
HR head, CBO, owner and recruiters (TA) start runs and retry or skip a stopped step; API keys stay with the
HR head, CBO and owner. A finished run shows the end it reached ("Workflow completed", "Stopped early").
When a run waits on a requisition approval, the approver at that step answers it in the run's thread: the card
shows the requisition summary and offers **Approve**, **Edit** (the approver corrects role, openings, location,
experience, CTC band, skills or responsibilities; it stays at its step and the change goes on the approval trail
and audit log) and **Ask for changes** (sent back to draft with the reason). A send-back goes to the Requisition agent, which
makes the change and resubmits or asks in the thread. A declined requisition can be **reopened with changes** (the
person who raised it, the HR head or the CBO): back to draft with the change, handed to the same agent.

Each granted workflow has its own app page in the organisation: **`/w/<workflowId>`** (Agent settings →
Workflows → **Open**). It shows only that workflow: what starts it, whether it is Live, a **Start** box for a
hiring need (HR head / CBO / owner), and every run as its flow with its questions and approvals answered in
place. Visible to the HR head, CBO, owner, department heads, hiring managers and recruiters; each request
still shows only to the people it is for. Server: `src/lib/org-workflows.functions.ts`
(`orgWorkflowApp`, `startOrgWorkflowRun`).

**API** — the HR head / CBO / owner issues a key for one workflow on the app page (shown once; only its
SHA-256 hash is stored, `workflow_api_keys`, migration `0087`; issue and revoke are audited as
`workflow.api_key.issued|revoked`). Runs started with a key act as the person who issued it; the key stops
working when revoked, when the workflow is withdrawn or archived, or when that person leaves.

| Call                                                      | Does                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /api/workflows/<workflowId>/runs` `{ "need": "…" }` | Start a hiring-need workflow → the run (201)                       |
| `GET /api/workflows/<workflowId>/runs`                    | Latest 20 runs                                                     |
| `GET /api/workflows/runs/<runId>`                         | One run: status, current step, what it waits for, steps, `appPath` |

`Authorization: Bearer atsw_…`. Responses are vendor-neutral and carry no request text — people answer
questions and approvals in the app (`appPath`). Rate-limited per caller and per key in `src/server.ts`
(`src/server/agents/workflow-app.server.ts`). Started runs are audited as `workflow.run.started_by_api`.

## More steps: hiring need, wait for, report

- **Hiring need (manual) trigger** — the flow starts by hand with the need's text (`{{payload.need}}`): super
  admin with **Run now** (Runs tab) in an organisation they own. Its agents act for whoever starts it.
- **Wait for** — pauses until an event happens **on the flow's own role**, then continues; gives up after the
  timeout (hours, default 72, max 720). **Only when** (optional) keeps waiting until the event's payload matches,
  e.g. `requisition.status_changed` only when `payload.to` equals `approved`. Afterwards `wait.status` is
  `happened` or `timed_out` (use a condition), and the event's fields are merged into `payload`.
  The flow learns its role from the trigger, or from the first event one of its own agents causes (e.g. the
  Requisition agent drafting a requisition).
- **Report** — marks where the run report is ready. Every run (Runs tab, and the organisation's Agent
  workflows page) downloads as **PDF** or **Excel**: summary, the hiring need, every step, each agent's
  status / result / tokens, and every decision people made (who, when, outcome).

## Lifecycle — same protocol as agents

`draft → tested → approved → published`, per version. Saving makes a new draft; the published version
keeps running.

1. **Test** — the graph is checked against the rules, then every test is a **dry run**: a sample event
   payload and, for each agent step, how it ends (`{"<step id>": {"status": "done", "result": "…"}}`).
   The path taken is shown; a test may require the flow to end at a chosen step. No AI, no runs,
   nothing real. All passing makes the version **tested**.
2. **Approve** — only a tested version whose own tests passed (self-approval recorded).
3. **Publish** — an immutable version (`agent_workflow_versions`) with its trigger, graph hash and test.
4. **Grant** (Organisations tab) — every studio agent the flow uses must be granted to that organisation
   first. Withdrawing a grant cancels its live runs; archiving withdraws every grant.

## How it runs

When an organisation holding a grant has an event matching the trigger, the orchestrator starts a
**workflow run** (`workflow_runs`, one per workflow and event) and walks the graph:

- **Agent** — started through `startRun` like the orchestrator's own dispatch: the organisation's switch
  must be on (otherwise the flow stops with the reason), a run the same event already started on the
  subject (e.g. the built-in hand-off) is joined rather than duplicated; an older run of that agent still open
  on the role (only one may be open per agent and role) is waited for, then the step starts its own run with
  its own goal; it acts for the role's owner (else the person who caused the event), and
  autonomy, budget and every human decision inside the agent are unchanged. The flow waits until the run
  finishes, then records `last.status` / `last.result`.
- **Hand-offs and the role** — an agent that hands the work back ("Handed off: …") ends with `last.status = handed_off`, not `done`, so a check on `done` takes the _no_ way out. The flow learns its role from its agents' runs and the events they caused (e.g. the Requisition agent drafting one), checked again before every agent step, and passes it to later agents.
- **What each step knows** — every agent step starts with its own goal plus the hiring need and the previous
  step's result (`stepGoal`), so it never starts blind. **Aditi (the copilot) cannot be a step**: it hands work
  to other agents on its own, which would happen outside the flow — start a hiring need with the Requisition
  agent. A step whose run ended without the flow hearing about it (e.g. a restart) moves on at the next
  scheduler tick (`resumeFinishedRunWaits`). A step whose agent **stopped at its run limit** (turns or tokens) does not fail the flow: it pauses with "<agent> stopped at its run limit — Retry or Skip". **Retry** (HR head / CBO / owner, in the workflow app or the Runs tab) starts the step's agent again with the same goal, told to pick up what the stopped run already did; **Skip** treats the step as failed and follows the flow (`resolveStoppedStep`, audited as `workflow.step.retried|skipped`). A **wait** first looks back over the run's lifetime: if its event already happened on the role (e.g. people approved the requisition while the agent was still working), it moves straight on; the tick repeats that look-back for waits whose event was missed.
- **Condition** — evaluated on the event and the last agent's outcome.
- **End** (or no next step) — the run is done.

Each step is recorded in the run's history (Runs tab). Workflows never approve, reject or decide anything
themselves.

## Audit

`platform.agent_workflow.created|saved|assisted|tested|approved|published|granted|revoked|archived`.

## Ready-made workflows

**Start from a template** on the Agent workflows page creates a draft copy (with passing tests) to customise —
swap in studio agents, edit goals and conditions, add steps. Templates live in `src/lib/workflow-templates.ts`
and are checked by `scripts/agent-workflows.test.ts` (real stock agents, graph rules, every branch tested).

| Template                                        | Trigger                      | Flow                                                                        |
| ----------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| Shortlisted → screening, follow up if it stalls | `application.shortlisted`    | Screening agent → finished? yes: end · no: Follow-up agent reminds the team |
| Role approved → draft the JD                    | `requisition.status_changed` | `payload.to` = approved? yes: JD agent · no: end                            |
| JD approved → publish → advertise               | `jd.approved`                | Publishing agent → published? yes: Distribution agent · no: end             |
| Final-round scorecard → evaluation              | `scorecard.submitted`        | `payload.finalRound` = true? yes: Evaluation agent · no: end                |

Event fields the templates use: `application.shortlisted` → `payload.applicationIds`;
`requisition.status_changed` → `payload.from`, `payload.to`; `scorecard.submitted` → `payload.applicationId`,
`payload.level`, `payload.verdict`, `payload.finalRound`; `jd.approved` → `payload.requisitionId`.

## Try it with real agents — sample scenario

Template **Shortlisted → screening, follow up if it stalls**, in an organisation with its own AI key
(locally: **Yavar**, role **REQ-2026-001 Head of AI**, candidates at _AI screened_). Real runs use real tokens.

**Set up (super admin)**

1. Platform → Agent workflows → **Use** on the template. Open **Tests** → **Test v1** → **Approve** →
   **Publish**.
2. **Organisations** → tick the organisation.

**Set up (the organisation's HR head)**

3. Agent settings → **Screening agent**: on, autonomy **Suggest** (every candidate email then waits for
   your approval — at Autonomous it emails candidates on its own). **Follow-up agent**: on.

**Run — the "yes" branch**

4. Open the role → move **one or two candidates to Shortlisted**.
5. Platform → Agent workflows → the workflow → **Runs**: _Started by application.shortlisted → Agent
   started_ (status _waiting_).
6. In the organisation: **Agent activity** shows the Screening run; **Waiting for you** shows its approvals
   (assessment emails, screening kits) — approve or decline them.
7. When the Screening agent finishes, **Runs** shows _Agent done → Yes → Ended_ at **Screened**.

**Run — the "no" branch**

8. Shortlist **another** candidate (each event starts the workflow once).
9. In **Agent activity**, **stop** the new Screening run.
10. **Runs**: _Agent cancelled → No → Agent started_ (Follow-up agent) → when it finishes, _Ended_ at
    **Reminded**. The Follow-up agent's reminders appear for the people it chased.

**Also check**

- Switch the Screening agent **off** and shortlist again → the run fails with _screening is switched off_.
- The built-in hand-off also starts screening on a shortlist; the workflow starts it first and the built-in
  chain sees the run already working, so there is never a duplicate.

**Clean up** — untick the organisation (live runs are cancelled) or archive the workflow, and put the agents'
autonomy back.

## Try it with real agents — a hiring need end to end

Template **Hiring need → requisition → JD → screening → report**, in an organisation with its own AI key
(locally **Yavar**). Real runs use real tokens; it takes as long as the people deciding.

1. Super admin: **Use** the template → **Tests** → **Test** → **Approve** → **Publish** → **Organisations**:
   tick the organisation.
2. HR head of that organisation, **Agent settings**: switch on the Requisition, JD, Publishing and Screening
   agents (autonomy **Suggest**, so every external step waits for approval).
3. Super admin: Runs tab → **Run now** → type the need (e.g. _We need two AI engineers in Chennai, hybrid, by
   March_).
4. The Requisition agent drafts the role (approve its questions in **Waiting for you**) and submits it. The run
   waits for _requisition approved_.
5. Approve the requisition as the approvers would. The run resumes: the JD agent drafts the JD; approve it.
6. The Publishing agent posts the role (approve the posts). The run waits for _candidates shortlisted_.
7. Shortlist one or two candidates on the role. The Screening agent screens them; approve its assessments.
8. The run reaches **Run report** → **Done**. Download **PDF** or **Excel** from the organisation's Agent
   workflows page or the builder's Runs tab.

Try the other paths: leave the requisition unapproved past the timeout (set a short one, e.g. 1 hour, in a
draft) and the run goes straight to the report with _timed out_.
