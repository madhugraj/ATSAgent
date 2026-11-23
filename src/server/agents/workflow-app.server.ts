/**
 * Workflow app and API (docs/agent-workflows.md § Workflow app and API).
 *
 * An organisation runs a workflow the platform granted it from its own
 * workflow app page (/w/:workflowId) or from its other systems with its own
 * key:
 *
 *   POST /api/workflows/:workflowId/runs  { "need": "…" }   → RunView (201)
 *   GET  /api/workflows/:workflowId/runs                   → { runs: RunView[] }
 *   GET  /api/workflows/runs/:runId                        → RunView
 *
 * A key is issued for one workflow in one organisation by its HR head, CBO or
 * owner; only its hash is stored and runs act as that person — every agent
 * step keeps the organisation's switch, autonomy, budget and AI key, and every
 * decision still goes to people (answered in the workflow app). Responses are
 * vendor-neutral and carry no request text (that stays in the app). Rate
 * limits are applied in src/server.ts before this module is reached.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  agentWorkflowGrants,
  agentWorkflows,
  orgMembers,
  workflowApiKeys,
  workflowRuns,
} from "@db/schema";
import { db } from "../db";
import { log } from "../log";

export const WORKFLOW_API_PREFIX = "/api/workflows/";
const KEY_PREFIX = "atsw_";

export function hashWorkflowKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A new key: the full value (shown once) and what is stored. */
export function newWorkflowKey(): { key: string; prefix: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 6), hash: hashWorkflowKey(key) };
}

export type ResolvedWorkflowKey = {
  keyId: string;
  orgId: string;
  workflowId: string;
  principalUserId: string;
};

/**
 * The live key and its workflow, or null: refused when revoked, when the
 * workflow is archived or no longer granted to the organisation, or when the
 * person who issued it is no longer an active member. Records last use.
 */
export async function resolveWorkflowKey(key: string): Promise<ResolvedWorkflowKey | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 100) return null;
  const [k] = await db
    .select()
    .from(workflowApiKeys)
    .where(
      and(eq(workflowApiKeys.keyHash, hashWorkflowKey(key)), isNull(workflowApiKeys.revokedAt)),
    )
    .limit(1);
  if (!k) return null;
  const [ok] = await db
    .select({ id: agentWorkflowGrants.id })
    .from(agentWorkflowGrants)
    .innerJoin(agentWorkflows, eq(agentWorkflows.id, agentWorkflowGrants.workflowId))
    .innerJoin(
      orgMembers,
      and(
        eq(orgMembers.orgId, agentWorkflowGrants.orgId),
        eq(orgMembers.userId, k.principalUserId),
        eq(orgMembers.status, "active"),
      ),
    )
    .where(
      and(
        eq(agentWorkflowGrants.workflowId, k.workflowId),
        eq(agentWorkflowGrants.orgId, k.orgId),
        isNull(agentWorkflowGrants.revokedAt),
      ),
    )
    .limit(1);
  if (!ok) return null;
  await db
    .update(workflowApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(workflowApiKeys.id, k.id));
  return {
    keyId: k.id,
    orgId: k.orgId,
    workflowId: k.workflowId,
    principalUserId: k.principalUserId,
  };
}

export type WorkflowRunApiView = {
  runId: string;
  workflowId: string;
  status: string;
  /** The step it is on, by its name in the workflow. */
  currentStep: string | null;
  /** Plain words: "<agent> is waiting for you — 1 question", "<agent> is working", … */
  waitingOn: {
    kind: "person" | "agent" | "event" | "stopped";
    text: string;
    requests: number;
  } | null;
  steps: { step: string; at: string; note: string }[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Where people answer its questions and approvals. */
  appPath: string;
};

/** One run as the API and app show it (org-scoped by the caller). */
export async function workflowRunApiView(
  orgId: string,
  runId: string,
  workflowId?: string,
): Promise<WorkflowRunApiView | null> {
  const [r] = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.id, runId),
        eq(workflowRuns.orgId, orgId),
        workflowId ? eq(workflowRuns.workflowId, workflowId) : undefined,
      ),
    )
    .limit(1);
  if (!r) return null;
  return (await toViews([r]))[0]!;
}

async function toViews(rows: (typeof workflowRuns.$inferSelect)[]): Promise<WorkflowRunApiView[]> {
  const { waitingOnFor, runVersionGraph } = await import("./workflows.server");
  const waits = await waitingOnFor(rows);
  const out: WorkflowRunApiView[] = [];
  for (const r of rows) {
    const graph = await runVersionGraph(r.workflowId, r.version);
    const name = (id: string | null) => {
      if (!id) return null;
      const n = graph?.nodes.find((x) => x.id === id);
      return n ? n.data.label || n.data.agentType || n.kind : id;
    };
    const w = waits.get(r.id);
    out.push({
      runId: r.id,
      workflowId: r.workflowId,
      status: r.status,
      currentStep: r.status === "waiting" || r.status === "running" ? name(r.currentNode) : null,
      waitingOn: w ? { kind: w.kind, text: w.text, requests: w.requests } : null,
      steps: r.history.map((h) => ({ step: name(h.node) ?? h.node, at: h.at, note: h.note })),
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      appPath: `/w/${r.workflowId}?run=${r.id}`,
    });
  }
  return out;
}

/** The latest runs of a workflow in an organisation. */
export async function workflowRunApiViews(
  orgId: string,
  workflowId: string,
  limit = 20,
): Promise<WorkflowRunApiView[]> {
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.orgId, orgId), eq(workflowRuns.workflowId, workflowId)))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit);
  return toViews(rows);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const workflowUnauthorized = () =>
  new Response(JSON.stringify({ error: "Invalid or revoked key." }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": "Bearer",
      "cache-control": "no-store",
    },
  });

const StartBody = z.object({ need: z.string().trim().min(5).max(4000) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The public workflow API (the key is already resolved and rate-limited). */
export async function handleWorkflowApi(
  request: Request,
  url: URL,
  key: ResolvedWorkflowKey,
): Promise<Response> {
  const rest = url.pathname.slice(WORKFLOW_API_PREFIX.length).split("/").filter(Boolean);
  // GET /api/workflows/runs/:runId
  if (rest[0] === "runs" && rest.length === 2 && request.method === "GET") {
    if (!UUID.test(rest[1]!)) return json({ error: "Not found." }, 404);
    const v = await workflowRunApiView(key.orgId, rest[1]!, key.workflowId);
    return v ? json(v) : json({ error: "Not found." }, 404);
  }
  // /api/workflows/:workflowId/runs
  if (rest.length === 2 && rest[1] === "runs") {
    if (rest[0] !== key.workflowId)
      return json({ error: "This key is for another workflow." }, 403);
    if (request.method === "GET")
      return json({ runs: await workflowRunApiViews(key.orgId, key.workflowId) });
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Send JSON: { "need": "…" }.' }, 400);
      }
      const parsed = StartBody.safeParse(body);
      if (!parsed.success) return json({ error: "need must be 5–4000 characters." }, 400);
      const { startWorkflowManually } = await import("./workflows.server");
      let runId: string;
      try {
        ({ runId } = await startWorkflowManually({
          workflowId: key.workflowId,
          orgId: key.orgId,
          userId: key.principalUserId,
          need: parsed.data.need,
        }));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Could not start." }, 409);
      }
      const { writeAudit } = await import("../audit");
      await writeAudit({
        actor: `workflow-key:${key.keyId}`,
        actorUserId: key.principalUserId,
        orgId: key.orgId,
        action: "workflow.run.started_by_api",
        entityType: "workflow_run",
        entityId: runId,
        detail: { workflowId: key.workflowId },
      });
      log.info("workflow_api.started", { org_id: key.orgId, workflow_run_id: runId });
      return json(await workflowRunApiView(key.orgId, runId, key.workflowId), 201);
    }
    return json({ error: "Method not allowed." }, 405);
  }
  return json({ error: "Not found." }, 404);
}
