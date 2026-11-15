# Agent studio — customise and export agents

Agent administration → Agent studio (`src/routes/agents.studio.tsx`). HR head and President / CBO edit;
other governance members can view.

## What an export is

A customised copy of a stock hiring agent (`agent_exports`, migration 0080) for use **outside** ATSIQ.
It can only narrow the stock agent:

| Field              | Rule                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| Name, description  | Free text                                                                              |
| Extra instructions | Appended after the stock instructions, under a heading saying they never override them |
| Tools              | A subset of the stock agent's tools                                                    |
| Must never         | Added to the stock list                                                                |
| Steps              | At most the stock limit                                                                |

The stock instructions, injection and operating rules, gates and the registry's gate-verb ban always
apply (`effectiveDefinition`, `exportProblem` in `src/server/agents/exports.server.ts`). Every save bumps
the export's `version` and re-bases it on the current stock agent; the list shows **Agent updated** when
the stock manifest changed since.

**In-app runs never use exports.**

## Portable package

**Download package** returns `<name>-v<version>.agent.json` (`ats-agent-package/1`):

- `agent` — identity, responsibility, owner, risk tier, must-never, scope, human decisions, limits, `basedOn` (stock type, version, hash)
- `instructions` — the full system prompt (injection rules + operating rules + stock + extra)
- `tools` — names, descriptions, risk, `needsPersonApproval`, JSON-schema inputs
- `humanTools` — `ask_human` / `request_approval` contracts
- `evals`, `implementationNotes`

The receiving application implements the tools on its own data. No AI vendor, model or feature fields.

## Hosted API

Publish the export, then create a key on its **Hosted API** tab (shown once; only a hash is stored).

```
POST /api/agents/:exportId/runs      Authorization: Bearer atsk_…   {"goal": "…"}
  → 202 {"runId": "…", "status": "queued"}
GET  /api/agents/runs/:runId         Authorization: Bearer atsk_…
  → {"runId", "status", "result", "waitingFor", "error"}
```

Runs act as the key's creator under the organisation's agent policy (the agent must be switched on in
Agent settings) and execute the export's narrowed definition (`agent_runs.export_id`, `export_version`).
Decisions (`waitingFor`) go to people in ATSIQ's inbox. 401 for unknown/revoked keys or unpublished
exports, 409 when the run is refused, 429 over the limit (60/min per caller and path, 30/min per key).

## MCP

`POST /api/mcp` with the same bearer key — stateless streamable HTTP with JSON responses. Methods:
`initialize`, `ping`, `tools/list`, `tools/call`. Tools: `run_agent {goal}` and `get_run {runId}`.

## Audit

`agent.export.created|saved|archived|downloaded|key_created|key_revoked|run_started`.
