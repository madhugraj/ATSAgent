/**
 * Agent workflows inside an organisation (docs/agent-workflows.md § Going
 * live): the workflows the platform granted it, what each needs before it can
 * run here (AI key, agents switched on, studio agents granted) and its recent
 * runs. Read-only and org-scoped; HR head or President / CBO (owner passes).
 * Switching agents on stays in Agent settings (`saveAgentPolicy`).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { workflowRuns } from "@db/schema";
import { db } from "../server/db";
import { requireOrg } from "./auth.middleware";

export type OrgWorkflowRow = {
  id: string;
  name: string;
  description: string;
  version: number;
  /** The event that starts it, or "manual" (started by the platform with Run now). */
  trigger: string;
  ready: boolean;
  items: { key: string; label: string; ok: boolean; detail: string }[];
  runs: {
    id: string;
    status: string;
    createdAt: string;
    lastNote: string | null;
    error: string | null;
    /** What a waiting run waits for; a person's request links to Waiting for you. */
    waitingOn: {
      kind: "person" | "agent" | "event" | "stopped";
      text: string;
      first: { kind: string; title: string; body: string } | null;
    } | null;
  }[];
};

export const orgWorkflows = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<OrgWorkflowRow[]> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"]);
    const { grantedWorkflows, workflowReadiness, waitingOnFor } =
      await import("../server/agents/workflows.server");
    const granted = await grantedWorkflows(context.orgId);
    if (!granted.length) return [];
    const runs = await db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.orgId, context.orgId),
          inArray(
            workflowRuns.workflowId,
            granted.map((g) => g.id),
          ),
        ),
      )
      .orderBy(desc(workflowRuns.createdAt))
      .limit(50);
    const waits = await waitingOnFor(runs, true);
    return Promise.all(
      granted.map(async (g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        version: g.version,
        trigger: g.trigger,
        ...(await workflowReadiness(context.orgId, g.graph)),
        runs: runs
          .filter((r) => r.workflowId === g.id)
          .slice(0, 5)
          .map((r) => ({
            id: r.id,
            status: r.status,
            createdAt: r.createdAt.toISOString(),
            lastNote: r.history.at(-1)?.note ?? null,
            error: r.error,
            waitingOn: (() => {
              const w = waits.get(r.id);
              return w ? { kind: w.kind, text: w.text, first: w.first ?? null } : null;
            })(),
          })),
      })),
    );
  });

/* ------------------------------------------------------- workflow app (/w/:id) */

const VIEW_ROLES = [
  "hr_head",
  "president_cbo",
  "department_head",
  "hiring_manager",
  "recruiter",
] as const;
const MANAGE_ROLES = ["hr_head", "president_cbo"] as const;
/** Who runs a shared workflow from the hiring desk: HR and TA (recruiters). */
const RUN_ROLES = ["hr_head", "president_cbo", "recruiter"] as const;

async function hasRole(userId: string, orgId: string, roles: readonly string[]) {
  const { assertRole } = await import("./auth.middleware");
  try {
    await assertRole(userId, orgId, [...roles] as Parameters<typeof assertRole>[2]);
    return true;
  } catch {
    return false;
  }
}

const WorkflowIdInput = z.object({ workflowId: z.string().uuid() });

export type OrgWorkflowAppView = {
  orgName: string;
  workflow: {
    id: string;
    name: string;
    description: string;
    version: number;
    trigger: string;
    graph: import("@db/schema").WorkflowGraph;
  };
  ready: boolean;
  items: { key: string; label: string; ok: boolean; detail: string }[];
  /** HR head / CBO / owner: manage API keys. */
  canManage: boolean;
  /** HR and TA: start runs (manual workflows), retry or skip a stopped step. */
  canStart: boolean;
  runs: AppRun[];
};

export type AppRun = {
  id: string;
  status: string;
  currentNode: string | null;
  history: { node: string; at: string; note: string }[];
  error: string | null;
  createdAt: string;
  need: string | null;
  waitingOn: { kind: "person" | "agent" | "event" | "stopped"; text: string } | null;
  /** The graph of the version this run ran. */
  graph: import("@db/schema").WorkflowGraph | null;
  /** The role the run is working on, once it has one. */
  /** agentBusy: an agent is working on it right now (e.g. applying a send-back). */
  requisition: { id: string; code: string; status: string; agentBusy: boolean } | null;
};

/** Everything the workflow app shows: the workflow, whether it can run here, and its runs. */
export const orgWorkflowApp = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) => WorkflowIdInput.parse(d))
  .handler(async ({ data, context }): Promise<OrgWorkflowAppView> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...VIEW_ROLES]);
    const { grantedWorkflows, workflowReadiness, runVersionGraph } =
      await import("../server/agents/workflows.server");
    const g = (await grantedWorkflows(context.orgId)).find((x) => x.id === data.workflowId);
    if (!g) throw new Error("This workflow is not available to your organisation.");
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.orgId, context.orgId), eq(workflowRuns.workflowId, g.id)))
      .orderBy(desc(workflowRuns.createdAt))
      .limit(20);
    const { waitingOnFor } = await import("../server/agents/workflows.server");
    const waits = await waitingOnFor(rows);
    const { organizations } = await import("@db/schema");
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, context.orgId))
      .limit(1);
    const canManage = await hasRole(context.userId, context.orgId, MANAGE_ROLES);
    const canStart = await hasRole(context.userId, context.orgId, RUN_ROLES);
    const { requisitions } = await import("@db/schema");
    const reqIds = [
      ...new Set(
        rows
          .map((r) => (r.context as { subject?: { id?: string; type?: string } } | null)?.subject)
          .filter((x) => x?.type === "requisition" && x.id)
          .map((x) => x!.id!),
      ),
    ];
    const reqs = reqIds.length
      ? await db
          .select({ id: requisitions.id, code: requisitions.code, status: requisitions.status })
          .from(requisitions)
          .where(and(eq(requisitions.orgId, context.orgId), inArray(requisitions.id, reqIds)))
      : [];
    const { agentRuns } = await import("@db/schema");
    const busy = reqIds.length
      ? await db
          .select({ id: agentRuns.subjectId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.orgId, context.orgId),
              eq(agentRuns.subjectType, "requisition"),
              inArray(agentRuns.subjectId, reqIds),
              inArray(agentRuns.status, ["queued", "running"]),
            ),
          )
      : [];
    const busyIds = new Set(busy.map((b) => b.id));
    const reqById = new Map(reqs.map((x) => [x.id, { ...x, agentBusy: busyIds.has(x.id) }]));
    const graphs = new Map<number, import("@db/schema").WorkflowGraph | null>();
    for (const r of rows)
      if (!graphs.has(r.version)) graphs.set(r.version, await runVersionGraph(g.id, r.version));
    return {
      orgName: org?.name ?? "",
      workflow: {
        id: g.id,
        name: g.name,
        description: g.description,
        version: g.version,
        trigger: g.trigger,
        graph: g.graph,
      },
      ...(await workflowReadiness(context.orgId, g.graph)),
      canManage,
      canStart,
      runs: rows.map((r) => {
        const w = waits.get(r.id);
        const need = (r.context as { payload?: { need?: unknown } } | null)?.payload?.need;
        return {
          id: r.id,
          status: r.status,
          currentNode: r.currentNode,
          history: r.history,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          need: typeof need === "string" ? need : null,
          waitingOn: w ? { kind: w.kind, text: w.text } : null,
          graph: graphs.get(r.version) ?? null,
          requisition:
            reqById.get((r.context as { subject?: { id?: string } } | null)?.subject?.id ?? "") ??
            null,
        };
      }),
    };
  });

const StartInput = z.object({
  workflowId: z.string().uuid(),
  need: z.string().trim().min(5).max(4000),
});

/** Start a hiring-need workflow from the app. Its agents act for the person who starts it. */
export const startOrgWorkflowRun = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => StartInput.parse(d))
  .handler(async ({ data, context }): Promise<{ runId: string }> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...RUN_ROLES]);
    const { startWorkflowManually } = await import("../server/agents/workflows.server");
    const r = await startWorkflowManually({
      workflowId: data.workflowId,
      orgId: context.orgId,
      userId: context.userId,
      need: data.need,
    });
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "workflow.run.started",
      entityType: "workflow_run",
      entityId: r.runId,
      detail: { workflowId: data.workflowId },
    });
    return r;
  });

export type WorkflowKeyView = {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/** The organisation's live API keys for one workflow (never the key itself). */
export const listWorkflowKeys = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) => WorkflowIdInput.parse(d))
  .handler(async ({ data, context }): Promise<WorkflowKeyView[]> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...MANAGE_ROLES]);
    const { workflowApiKeys } = await import("@db/schema");
    const { isNull } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(workflowApiKeys)
      .where(
        and(
          eq(workflowApiKeys.orgId, context.orgId),
          eq(workflowApiKeys.workflowId, data.workflowId),
          isNull(workflowApiKeys.revokedAt),
        ),
      )
      .orderBy(desc(workflowApiKeys.createdAt));
    return rows.map((k) => ({
      id: k.id,
      label: k.label,
      prefix: k.keyPrefix,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    }));
  });

const IssueInput = z.object({
  workflowId: z.string().uuid(),
  label: z.string().trim().max(80),
});

/** Issue a key for one granted workflow; the full key is returned once. Audited. */
export const issueWorkflowKey = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => IssueInput.parse(d))
  .handler(async ({ data, context }): Promise<{ key: string; prefix: string }> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...MANAGE_ROLES]);
    const { grantedWorkflows } = await import("../server/agents/workflows.server");
    if (!(await grantedWorkflows(context.orgId)).some((g) => g.id === data.workflowId))
      throw new Error("This workflow is not available to your organisation.");
    const { newWorkflowKey } = await import("../server/agents/workflow-app.server");
    const { workflowApiKeys } = await import("@db/schema");
    const k = newWorkflowKey();
    const [row] = await db
      .insert(workflowApiKeys)
      .values({
        workflowId: data.workflowId,
        orgId: context.orgId,
        label: data.label,
        keyPrefix: k.prefix,
        keyHash: k.hash,
        principalUserId: context.userId,
      })
      .returning({ id: workflowApiKeys.id });
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "workflow.api_key.issued",
      entityType: "workflow_api_key",
      entityId: row!.id,
      detail: { workflowId: data.workflowId, prefix: k.prefix, label: data.label },
    });
    return { key: k.key, prefix: k.prefix };
  });

/** Revoke a key at once. Audited. */
export const revokeWorkflowKey = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ keyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...MANAGE_ROLES]);
    const { workflowApiKeys } = await import("@db/schema");
    const done = await db
      .update(workflowApiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(workflowApiKeys.id, data.keyId), eq(workflowApiKeys.orgId, context.orgId)))
      .returning({ id: workflowApiKeys.id });
    if (!done.length) throw new Error("Key not found.");
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "workflow.api_key.revoked",
      entityType: "workflow_api_key",
      entityId: data.keyId,
    });
    return { ok: true };
  });

const ResolveInput = z.object({
  workflowRunId: z.string().uuid(),
  action: z.enum(["retry", "skip"]),
});

/** Retry or Skip a step paused at its agent's run limit. Audited. */
export const resolveWorkflowStep = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => ResolveInput.parse(d))
  .handler(async ({ data, context }) => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...RUN_ROLES]);
    const { resolveStoppedStep } = await import("../server/agents/workflows.server");
    await resolveStoppedStep({
      workflowRunId: data.workflowRunId,
      orgId: context.orgId,
      userId: context.userId,
      action: data.action,
    });
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: `workflow.step.${data.action === "retry" ? "retried" : "skipped"}`,
      entityType: "workflow_run",
      entityId: data.workflowRunId,
    });
    return { ok: true };
  });

export type DeskWorkflow = {
  id: string;
  name: string;
  description: string;
  ready: boolean;
  /** Runs still going (running or waiting). */
  live: number;
  /** Runs waiting on a person or a stopped step. */
  needsYou: number;
};

/** The workflows shared with this organisation, for the hiring desk. */
export const deskWorkflows = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<DeskWorkflow[]> => {
    if (!(await hasRole(context.userId, context.orgId, VIEW_ROLES))) return [];
    const { grantedWorkflows, workflowReadiness, waitingOnFor } =
      await import("../server/agents/workflows.server");
    const granted = await grantedWorkflows(context.orgId);
    if (!granted.length) return [];
    const live = await db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.orgId, context.orgId),
          inArray(workflowRuns.status, ["running", "waiting"]),
        ),
      );
    const waits = await waitingOnFor(live);
    const out: DeskWorkflow[] = [];
    for (const g of granted) {
      const mine = live.filter((r) => r.workflowId === g.id);
      out.push({
        id: g.id,
        name: g.name,
        description: g.description,
        ready: (await workflowReadiness(context.orgId, g.graph)).ready,
        live: mine.length,
        needsYou: mine.filter((r) => {
          const k = waits.get(r.id)?.kind;
          return k === "person" || k === "stopped";
        }).length,
      });
    }
    return out;
  });
