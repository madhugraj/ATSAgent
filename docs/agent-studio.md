# Agent studio

**Platform super admin only** (Platform → Agent studio, `/platform-agent-studio`). Not offered for sale to
organisations. Server functions: `src/lib/platform-agent-studio.functions.ts` (all `requirePlatformAdmin`);
core: `src/server/agents/blueprints.server.ts`; tests: `src/server/agents/studio-test.server.ts`.

## What a studio agent is

An agent built in the app — **adapted** from a stock agent or **new** — that runs inside the app for the
organisations the super admin grants it to, and can be delivered to external applications. Its runtime type is
`studio:<slug>` (fixed on first save).

| Built in the studio                                                        | Locked (always added, never editable)                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Name, description, responsibility                                          | Injection rules and operating rules, prepended to the instructions |
| Instructions (stock text pre-filled when adapted)                          | Human tools `ask_human` / `request_approval`                       |
| Must-never list, risk tier, accountable role                               | Gate-verb ban on every tool name, renamed ones included            |
| Human decisions it may ask for (kinds the stock agents use)                | Each tool's input contract and its own checks                      |
| Tools from the **catalogue** (any stock agent's), renamed and re-described | The organisation's switch, autonomy, budget                        |
| Steps between human decisions (≤ stock, or ≤ 30 for new agents)            | Audit                                                              |

The catalogue leaves out identity-bound tools (silent panel L1–L3, live AI calls, the Voice Guard). Building
blocks (Phase 2: questionnaire with fixed scoring, structured result, L4 rounds) join it as code tools under
the same protocol as stock tools.

## Lifecycle — same protocol as code agents

`draft → tested → approved → published`, per version. Saving creates a new draft version; a published version
keeps running until another is published.

1. **Test with sample data** (Test tab). Up to 5 tests: a goal, sample data per tool (`{"tool_name": result}`),
   expected tools in order, and whether it must ask a person. Tests run in an organisation the super admin
   owns, on its own AI key. Every tool is a **stand-in** with the real contract that returns the sample data —
   nothing real is read, sent or changed. Approvals are approved and questions answered by the test. All tests
   passing makes the version **tested**.
2. **Approve** — only a tested version whose own tests passed. The approver is recorded (self-approval is
   allowed after passing tests and flagged in the audit).
3. **Publish** — writes the immutable manifest (`studio_agent_versions`) with its test result and approval.
4. **Grant** (Organisations tab) — the agent appears in that organisation's Agent settings, off until they
   switch it on. Withdrawing refuses new runs and cancels open ones.

Runs pin the version they started on. Health rule `definition.studio_agent_failing` flags a studio agent that
fails in most of its runs in an organisation.

## Inside the app

Granted organisations see it in Agent settings with a Studio chip: Enabled, autonomy, monthly budget, run
limits, and **Start a run** (HR head / CBO) with a goal. (Phase 3 workflows will trigger it from events.)

## Delivery

- **Package** — `<name>-v<version>.agent.json` (`ats-agent-package/2`) of the published version: identity,
  `lockedRules`, full `instructions`, renamed tools with their real JSON-schema inputs, human tools,
  implementation notes. Vendor-neutral.
- **Hosted API / MCP** — pick a **workspace**: an organisation you own that holds a grant. Create a key (shown
  once; only a hash is stored). Runs execute there as `studio:<slug>`, under its Agent settings and AI key.

```
POST /api/agents/:agentId/runs   Authorization: Bearer atsk_…   {"goal": "…"}   → 202 {runId}
GET  /api/agents/runs/:runId     Authorization: Bearer atsk_…                    → {status, result, waitingFor}
POST /api/mcp                    Authorization: Bearer atsk_…   (initialize · tools/list · run_agent · get_run)
```

## Audit

`platform.studio_agent.created|saved|tested|approved|published|granted|revoked|duplicated|archived|downloaded|workspace_set|key_created|key_revoked`,
and `platform.agent_blueprint.run_started` for hosted runs.
