/**
 * Hosted agent API (Agent studio, docs/agent-studio.md). Another application
 * runs a published blueprint here with a platform-issued key:
 *
 *   POST /api/agents/:blueprintId/runs   { "goal": "…" }  → { runId, status }
 *   GET  /api/agents/runs/:runId                       → { runId, status, result, waitingFor }
 *
 * The key resolves to its blueprint, the blueprint's workspace organisation
 * and principal (the super admin who created it, an owner of the workspace);
 * runs act as that person under the workspace's agent policy and AI key, and
 * execute the blueprint's adapted definition. Decisions still go to people in this
 * app. Responses are vendor-neutral: no model or engine fields. Rate limits
 * are applied in src/server.ts before this module is reached.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { agentRuns, agentTasks, type AgentType } from "@db/schema";
import { db } from "../db";
import { log } from "../log";
import { resolveKey, type ResolvedKey } from "./blueprints.server";

export const AGENT_API_PREFIX = "/api/agents/";

export function isAgentApiPath(path: string): boolean {
  return path.startsWith(AGENT_API_PREFIX) || path === "/api/mcp";
}

/** The bearer key on a request, or null. */
export function bearerKey(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const unauthorized = () =>
  new Response(JSON.stringify({ error: "Invalid or revoked key." }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": "Bearer",
      "cache-control": "no-store",
    },
  });

const StartBody = z.object({ goal: z.string().trim().min(5).max(4000) });

export type RunView = {
  runId: string;
  status: string;
  result: string | null;
  /** Open decisions waiting for a person in the organisation. */
  waitingFor: number;
  error: string | null;
};

/** Start a run of the key's blueprint. Throws a plain-language Error when refused. */
export async function startHostedRun(k: ResolvedKey, goal: string): Promise<{ runId: string }> {
  const { ensureAgentsRegistered } = await import("./index");
  ensureAgentsRegistered();
  const { isWorkspaceOwner } = await import("./blueprints.server");
  if (!(await isWorkspaceOwner(k.principalUserId, k.orgId)))
    throw new Error("The person this key acts for is no longer an owner of the workspace.");
  const { loadPolicy } = await import("./policy");
  // The studio agent's own switch in the workspace's Agent settings.
  const policy = await loadPolicy(k.orgId, k.blueprint.typeSlug as AgentType);
  if (!policy.enabled) throw new Error("This agent is switched off in Agent settings.");
  const { resolveAiConfig } = await import("@/lib/ai-gateway.server");
  if (!(await resolveAiConfig(k.orgId)).apiKey)
    throw new Error("The organisation has no AI model key saved.");
  const { startRun } = await import("./runtime.server");
  const { runId } = await startRun({
    orgId: k.orgId,
    agentType: k.blueprint.typeSlug as AgentType,
    principalUserId: k.principalUserId,
    goal,
  });
  const { writeAudit } = await import("../audit");
  await writeAudit({
    actor: `api_key:${k.keyId}`,
    actorUserId: k.principalUserId,
    orgId: k.orgId,
    action: "platform.agent_blueprint.run_started",
    entityType: "agent_run",
    entityId: runId,
    detail: { blueprintId: k.blueprint.id, version: k.blueprint.publishedVersion },
  });
  const { kickAgents } = await import("./orchestrator.server");
  kickAgents(k.orgId);
  return { runId };
}

/** A run started through one of this blueprint's keys, or null. */
export async function hostedRunView(k: ResolvedKey, runId: string): Promise<RunView | null> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      result: agentRuns.result,
      lastError: agentRuns.lastError,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.orgId, k.orgId),
        eq(agentRuns.blueprintId, k.blueprint.id),
      ),
    )
    .limit(1);
  if (!run) return null;
  const open = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, k.orgId),
        eq(agentTasks.runId, run.id),
        inArray(agentTasks.status, ["open"]),
      ),
    );
  return {
    runId: run.id,
    status: run.status,
    result: run.result,
    waitingFor: open.length,
    error: run.status === "failed" ? "The agent could not complete this run." : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** REST handler for /api/agents/*. */
export async function handleAgentApi(request: Request, url: URL): Promise<Response> {
  const key = bearerKey(request);
  const k = key ? await resolveKey(key) : null;
  if (!k) return unauthorized();
  const parts = url.pathname.slice(AGENT_API_PREFIX.length).split("/");

  // POST /api/agents/:exportId/runs
  if (request.method === "POST" && parts.length === 2 && parts[1] === "runs") {
    if (parts[0] !== k.blueprint.id) return json({ error: "This key is for another agent." }, 403);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Send a JSON body with a goal." }, 400);
    }
    const parsed = StartBody.safeParse(body);
    if (!parsed.success) return json({ error: "goal must be 5 to 4000 characters." }, 400);
    try {
      const { runId } = await startHostedRun(k, parsed.data.goal);
      return json({ runId, status: "queued" }, 202);
    } catch (e) {
      log.warn("agent_api.start_refused", { org_id: k.orgId, error: e as Error });
      return json({ error: e instanceof Error ? e.message : "Could not start the run." }, 409);
    }
  }

  // GET /api/agents/runs/:runId
  if (request.method === "GET" && parts.length === 2 && parts[0] === "runs") {
    if (!UUID.test(parts[1]!)) return json({ error: "Not found." }, 404);
    const view = await hostedRunView(k, parts[1]!);
    return view ? json(view) : json({ error: "Not found." }, 404);
  }

  return json({ error: "Not found." }, 404);
}

/* -------------------------------------------------------------------- MCP */

/**
 * Minimal stateless MCP server over streamable HTTP (JSON responses):
 * initialize, ping, tools/list and tools/call. One key is one blueprint, so the
 * server offers two tools: start a run of that agent, and read a run.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

function mcpTools(k: ResolvedKey) {
  return [
    {
      name: "run_agent",
      description: `Start a run of "${k.blueprint.name}". ${k.blueprint.description}`.trim(),
      inputSchema: {
        type: "object",
        properties: { goal: { type: "string", minLength: 5, maxLength: 4000 } },
        required: ["goal"],
      },
    },
    {
      name: "get_run",
      description:
        "Read a run's status and result. waitingFor counts decisions waiting for a person.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
    },
  ];
}

const toolText = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

async function mcpCall(k: ResolvedKey, msg: JsonRpc): Promise<unknown> {
  const p = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "atsiq-agent", version: String(k.blueprint.publishedVersion) },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: mcpTools(k) };
    case "tools/call": {
      if (p.name === "run_agent") {
        const parsed = StartBody.safeParse(p.arguments ?? {});
        if (!parsed.success) return toolText("goal must be 5 to 4000 characters.", true);
        try {
          return toolText(await startHostedRun(k, parsed.data.goal));
        } catch (e) {
          return toolText(e instanceof Error ? e.message : "Could not start the run.", true);
        }
      }
      if (p.name === "get_run") {
        const runId = String(p.arguments?.["runId"] ?? "");
        const view = UUID.test(runId) ? await hostedRunView(k, runId) : null;
        return view ? toolText(view) : toolText("Run not found.", true);
      }
      throw Object.assign(new Error("Unknown tool."), { code: -32602 });
    }
    default:
      throw Object.assign(new Error("Method not found."), { code: -32601 });
  }
}

/** POST /api/mcp — one JSON-RPC message or a batch. */
export async function handleMcp(request: Request): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const key = bearerKey(request);
  const k = key ? await resolveKey(key) : null;
  if (!k) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } },
      400,
    );
  }
  const batch = Array.isArray(body) ? (body as JsonRpc[]) : [body as JsonRpc];
  if (batch.length > 20)
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large." } },
      400,
    );
  const out: unknown[] = [];
  for (const msg of batch) {
    // Notifications (no id) get no response.
    if (msg?.id === undefined || msg.id === null) continue;
    try {
      out.push({ jsonrpc: "2.0", id: msg.id, result: await mcpCall(k, msg) });
    } catch (e) {
      const code = (e as { code?: number }).code ?? -32603;
      out.push({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code, message: code === -32603 ? "Internal error." : (e as Error).message },
      });
    }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
}
