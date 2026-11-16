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
