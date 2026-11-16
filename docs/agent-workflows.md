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

## More steps: hiring need, wait for, report

- **Hiring need (manual) trigger** — the flow starts by hand with the need's text (`{{payload.need}}`): HR head
  / CBO on **Agent administration → Agent workflows** in their organisation, or the super admin with **Run now**
  (Runs tab) in an organisation they own. Its agents act for whoever starts it.
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
  must be on (otherwise the flow stops with the reason), a run already working on the same subject is
  joined rather than duplicated, it acts for the role's owner (else the person who caused the event), and
  autonomy, budget and every human decision inside the agent are unchanged. The flow waits until the run
  finishes, then records `last.status` / `last.result`.
- **Condition** — evaluated on the event and the last agent's outcome.
- **End** (or no next step) — the run is done.

Each step is recorded in the run's history (Runs tab). Workflows never approve, reject or decide anything
themselves.

## Audit

`platform.agent_workflow.created|saved|tested|approved|published|granted|revoked|archived`.

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
3. **Agent administration → Agent workflows** → the workflow → type the need (e.g. _We need two AI engineers in
   Chennai, hybrid, by March_) → **Start**. (Or super admin: Runs tab → **Run now**.)
4. The Requisition agent drafts the role (approve its questions in **Waiting for you**) and submits it. The run
   waits for _requisition approved_.
5. Approve the requisition as the approvers would. The run resumes: the JD agent drafts the JD; approve it.
6. The Publishing agent posts the role (approve the posts). The run waits for _candidates shortlisted_.
7. Shortlist one or two candidates on the role. The Screening agent screens them; approve its assessments.
8. The run reaches **Run report** → **Done**. Download **PDF** or **Excel** from the organisation's Agent
   workflows page or the builder's Runs tab.

Try the other paths: leave the requisition unapproved past the timeout (set a short one, e.g. 1 hour, in a
draft) and the run goes straight to the report with _timed out_.
