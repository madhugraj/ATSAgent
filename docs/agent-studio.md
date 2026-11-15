# Agent studio — platform blueprints

**Platform super admin only** (Platform → Agent studio, `/platform-agent-studio`). Organisations never
see it; it is not offered for sale. Server functions: `src/lib/platform-agent-studio.functions.ts`
(all `requirePlatformAdmin`); core: `src/server/agents/blueprints.server.ts`.

## What a blueprint is

A stock hiring agent adapted to another domain for use in other applications — for example the Labour
law agent rewritten as an environmental-compliance agent. Blueprints belong to the platform, not to an
organisation (`agent_blueprints`, migration 0080).

| Editable                                                    | Locked (always added, never editable)                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Name, description, responsibility                           | Injection rules and operating rules, prepended to the instructions |
| Full instructions (stock text pre-filled, "Reset to stock") | Human tools `ask_human` / `request_approval`                       |
| Must-never list (at least one rule)                         | Gate-verb ban on every tool name, renamed ones included            |
| Which stock tools to keep                                   | Only the stock agent's own tools                                   |
| Each kept tool's name and description                       | Each tool's input contract (shown read-only)                       |
| Step limit (≤ stock)                                        | Approval, pre-approval and policy checks of the real tool          |

Renamed tools must be `[a-z][a-z0-9_]{2,60}`, unique, not a human-tool name, and keep (or not add) a
`propose_` / `request_` / `submit_` prefix exactly as the real tool has it. Saving re-bases a blueprint on
the current stock agent and bumps its version; the list shows **Agent updated** when the stock agent has
changed since. **Duplicate** makes a draft copy (e.g. one law per blueprint).

## Package

Delivery → **Download package**: `<name>-v<version>.agent.json` (`ats-agent-package/2`) — the agent's
identity, responsibility, must-never, human decisions and limits, `lockedRules`, the full `instructions`
(locked rules first), the renamed tools with their real JSON-schema inputs and `needsPersonApproval`, the
human tools, and implementation notes. The other application implements the tools on its own data. No AI
vendor, model or feature fields.

## Hosted API and MCP

Delivery → **Hosted workspace**: an organisation the super admin owns (typically a dedicated one). Hosted
runs execute there — its data (e.g. the legal sources on its Labour policy page), its own AI key and its
agent settings (the agent must be switched on). Changing the workspace revokes the blueprint's keys.

Publish, pick a workspace, then **Create key** (shown once; only a hash is stored). Runs act as the key's
creator, who must still own the workspace.

```
POST /api/agents/:blueprintId/runs   Authorization: Bearer atsk_…   {"goal": "…"}
  → 202 {"runId": "…", "status": "queued"}
GET  /api/agents/runs/:runId         Authorization: Bearer atsk_…
  → {"runId", "status", "result", "waitingFor", "error"}
POST /api/mcp                        Authorization: Bearer atsk_…   (JSON-RPC)
  initialize · ping · tools/list · tools/call run_agent {goal} · tools/call get_run {runId}
```

The model sees the renamed tools; the runtime runs the real ones (`agent_runs.blueprint_id`,
`blueprint_version`). Decisions (`waitingFor`) go to people in the workspace organisation's inbox.
401 for unknown or revoked keys, unpublished blueprints or a changed workspace; 409 when a run is refused;
429 over the limit (60/min per caller and path, 30/min per key). In-app runs never use blueprints.

## Audit

`platform.agent_blueprint.created|saved|duplicated|archived|downloaded|workspace_set|key_created|key_revoked|run_started`.
