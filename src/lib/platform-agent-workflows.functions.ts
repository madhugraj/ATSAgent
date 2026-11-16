/**
 * Agent workflow builder server functions — platform super admin only
 * (`requirePlatformAdmin`; docs/agent-workflows.md). Workflows are drawn,
 * dry-run tested, approved, published as immutable versions and granted to
 * the organisations the super admin picks. Every change is audited
 * (`platform.agent_workflow.*`).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  agentWorkflowGrants,
  agentWorkflows,
  agentWorkflowVersions,
  organizations,
  workflowRuns,
  type WorkflowGraph,
  type WorkflowTestResult,
  type WorkflowTestScenario,
} from "@db/schema";
import { db } from "../server/db";
import { requirePlatformAdmin } from "./auth.middleware";

async function audit(
  userId: string,
  action: string,
  entityId: string,
  detail: unknown,
  orgId: string | null = null,
) {
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId,
    action: `platform.agent_workflow.${action}`,
    entityType: "agent_workflow",
    entityId,
    detail,
  });
}

const wf = () => import("../server/agents/workflows.server");

/** Every agent a workflow may use: stock agents and published studio agents. */
async function agentPalette(): Promise<{ type: string; name: string; studio: boolean }[]> {
  const { ensureAgentsRegistered } = await import("../server/agents");
  ensureAgentsRegistered();
  const { listAgents } = await import("../server/agents/registry");
  const { agentBlueprints } = await import("@db/schema");
  const published = (
    await db
      .select({
        type: agentBlueprints.typeSlug,
        name: agentBlueprints.name,
        status: agentBlueprints.status,
        publishedVersion: agentBlueprints.publishedVersion,
      })
      .from(agentBlueprints)
  ).filter((r) => r.type && r.publishedVersion != null && r.status !== "archived");
  return [
    ...listAgents()
      .filter((d) => !d.type.startsWith("studio:"))
      .map((d) => ({ type: d.type as string, name: d.name, studio: false })),
    ...published.map((r) => ({ type: r.type!, name: r.name, studio: true })),
  ];
}

export type WorkflowRow = {
  id: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
  testScenarios: {
    name: string;
    payloadJson: string;
    subjectType: string;
    outcomesJson: string;
    expectEnd: string;
  }[];
  lastTest: WorkflowTestResult | null;
  status: "draft" | "tested" | "approved" | "published" | "archived";
  version: number;
  publishedVersion: number | null;
  grants: string[];
  updatedAt: string;
};

export type WorkflowRunRow = {
  id: string;
  workflowId: string;
  orgName: string;
  version: number;
  status: string;
  currentNode: string | null;
  history: { node: string; at: string; note: string }[];
  error: string | null;
  createdAt: string;
};

export type WorkflowBuilderView = {
  /** Ready-made workflows to start from (src/lib/workflow-templates.ts). */
  templates: { id: string; name: string; description: string; steps: number; trigger: string }[];
  events: readonly string[];
  agents: { type: string; name: string; studio: boolean }[];
  organisations: { id: string; name: string; status: string }[];
  workflows: WorkflowRow[];
  runs: WorkflowRunRow[];
};

export const workflowBuilder = createServerFn({ method: "GET" })
  .middleware([requirePlatformAdmin])
  .handler(async (): Promise<WorkflowBuilderView> => {
    const { AGENT_EVENT_TYPES } = await import("../server/agents/events");
    const rows = await db
      .select()
      .from(agentWorkflows)
      .where(inArray(agentWorkflows.status, ["draft", "tested", "approved", "published"]))
      .orderBy(desc(agentWorkflows.updatedAt));
    const ids = rows.map((r) => r.id);
    const [grants, orgs, runs] = await Promise.all([
      ids.length
        ? db
            .select()
            .from(agentWorkflowGrants)
            .where(
              and(
                inArray(agentWorkflowGrants.workflowId, ids),
                isNull(agentWorkflowGrants.revokedAt),
              ),
            )
        : [],
      db
        .select({ id: organizations.id, name: organizations.name, status: organizations.status })
        .from(organizations)
        .orderBy(organizations.name),
      ids.length
        ? db
            .select({ r: workflowRuns, orgName: organizations.name })
            .from(workflowRuns)
            .innerJoin(organizations, eq(organizations.id, workflowRuns.orgId))
            .where(inArray(workflowRuns.workflowId, ids))
            .orderBy(desc(workflowRuns.createdAt))
            .limit(100)
        : [],
    ]);
    const { WORKFLOW_TEMPLATES } = await import("./workflow-templates");
    return {
      templates: WORKFLOW_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        steps: t.graph.nodes.length,
        trigger: t.graph.nodes.find((x) => x.kind === "trigger")?.data.event ?? "",
      })),
      events: AGENT_EVENT_TYPES,
      agents: await agentPalette(),
      organisations: orgs,
      workflows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        graph: r.graph,
        testScenarios: r.testScenarios.map((t: WorkflowTestScenario) => ({
          name: t.name,
          payloadJson: JSON.stringify(t.payload ?? {}, null, 2),
          subjectType: t.subjectType,
          outcomesJson: JSON.stringify(t.outcomes ?? {}, null, 2),
          expectEnd: t.expectEnd ?? "",
        })),
        lastTest: r.lastTest ?? null,
        status: r.status,
        version: r.version,
        publishedVersion: r.publishedVersion,
        grants: grants.filter((g) => g.workflowId === r.id).map((g) => g.orgId),
        updatedAt: r.updatedAt.toISOString(),
      })),
      runs: runs.map(({ r, orgName }) => ({
        id: r.id,
        workflowId: r.workflowId,
        orgName,
        version: r.version,
        status: r.status,
        currentNode: r.currentNode,
        history: r.history,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

const Node = z.object({
  id: z.string().min(1).max(60),
  kind: z.enum(["trigger", "agent", "condition", "end"]),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  data: z.object({
    label: z.string().max(80).optional(),
    event: z.string().max(60).optional(),
    agentType: z.string().max(80).optional(),
    goal: z.string().max(2000).optional(),
    field: z.string().max(120).optional(),
    op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists"]).optional(),
    value: z.string().max(200).optional(),
  }),
});
const Edge = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(60),
  target: z.string().min(1).max(60),
  branch: z.enum(["yes", "no"]).optional(),
});
const Scenario = z.object({
  name: z.string().max(80),
  payloadJson: z.string().max(20_000),
  subjectType: z.string().max(40),
  outcomesJson: z.string().max(20_000),
  expectEnd: z.string().max(60),
});
const SaveInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().max(80),
  description: z.string().max(500),
  graph: z.object({ nodes: z.array(Node).max(40), edges: z.array(Edge).max(80) }),
  testScenarios: z.array(Scenario).max(5),
});

export type SaveWorkflowInput = z.infer<typeof SaveInput>;

function parseJson(what: string, json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error(`${what} is not valid JSON.`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error(`${what} must be an object.`);
  return v as Record<string, unknown>;
}

/** Save the canvas as a new draft version; testing and approval start again. */
export const saveWorkflow = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    if (!data.name.trim()) throw new Error("Give the workflow a name.");
    const scenarios: WorkflowTestScenario[] = data.testScenarios.map((t) => {
      const outcomes = parseJson(`Test "${t.name}": agent outcomes`, t.outcomesJson);
      for (const [k, v] of Object.entries(outcomes)) {
        const o = v as { status?: unknown };
        if (o?.status !== "done" && o?.status !== "failed")
          throw new Error(`Test "${t.name}": outcome for ${k} needs status done or failed.`);
      }
      return {
        name: t.name.trim() || "Test",
        payload: parseJson(`Test "${t.name}": event payload`, t.payloadJson),
        subjectType: t.subjectType || "requisition",
        outcomes: outcomes as WorkflowTestScenario["outcomes"],
        ...(t.expectEnd ? { expectEnd: t.expectEnd } : {}),
      };
    });
    const now = new Date();
    const fields = {
      name: data.name.trim(),
      description: data.description.trim(),
      graph: data.graph as WorkflowGraph,
      testScenarios: scenarios,
    };
    if (data.id) {
      const [cur] = await db
        .select({ version: agentWorkflows.version, status: agentWorkflows.status })
        .from(agentWorkflows)
        .where(eq(agentWorkflows.id, data.id))
        .limit(1);
      if (!cur || cur.status === "archived") throw new Error("Workflow not found.");
      const version = cur.version + 1;
      await db
        .update(agentWorkflows)
        .set({
          ...fields,
          status: "draft",
          version,
          approvedBy: null,
          approvedAt: null,
          updatedAt: now,
        })
        .where(eq(agentWorkflows.id, data.id));
      await audit(context.userId, "saved", data.id, { version, nodes: data.graph.nodes.length });
      return { id: data.id };
    }
    const [row] = await db
      .insert(agentWorkflows)
      .values({ ...fields, createdBy: context.userId })
      .returning({ id: agentWorkflows.id });
    await audit(context.userId, "created", row!.id, {});
    return { id: row!.id };
  });

const IdInput = z.object({ id: z.string().uuid() });

async function load(id: string) {
  const [w] = await db.select().from(agentWorkflows).where(eq(agentWorkflows.id, id)).limit(1);
  if (!w || w.status === "archived") throw new Error("Workflow not found.");
  return w;
}

/** Check the graph, then dry-run every test. All passing makes the version "tested". */
export const testWorkflow = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }): Promise<WorkflowTestResult & { problems: string[] }> => {
    const w = await load(data.id);
    const { graphProblems, runTests } = await wf();
    const known = new Set((await agentPalette()).map((a) => a.type));
    const problems = graphProblems(w.graph, (t) => known.has(t));
    if (!w.testScenarios.length) problems.push("Add at least one test.");
    const result: WorkflowTestResult = problems.length
      ? { version: w.version, passed: false, at: new Date().toISOString(), runs: [] }
      : runTests(w.graph, w.testScenarios, w.version);
    await db
      .update(agentWorkflows)
      .set({
        lastTest: result,
        ...(result.passed && w.status === "draft" ? { status: "tested" } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(agentWorkflows.id, w.id), eq(agentWorkflows.version, w.version)));
    await audit(context.userId, "tested", w.id, { version: w.version, passed: result.passed });
    return { ...result, problems };
  });

export const approveWorkflow = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    const w = await load(data.id);
    const problem = (await wf()).approveProblem(w);
    if (problem) throw new Error(problem);
    const now = new Date();
    await db
      .update(agentWorkflows)
      .set({ status: "approved", approvedBy: context.userId, approvedAt: now, updatedAt: now })
      .where(and(eq(agentWorkflows.id, w.id), eq(agentWorkflows.version, w.version)));
    await audit(context.userId, "approved", w.id, {
      version: w.version,
      selfApproved: w.createdBy === context.userId,
    });
    return { ok: true };
  });

export const publishWorkflow = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    const w = await load(data.id);
    const { publishProblem, triggerOf, graphHash } = await wf();
    const problem = publishProblem(w);
    if (problem || !w.lastTest || !w.approvedAt) throw new Error(problem ?? "Not approved.");
    const trigger = triggerOf(w.graph)?.data.event;
    if (!trigger) throw new Error("The workflow has no trigger.");
    await db.transaction(async (tx) => {
      await tx.insert(agentWorkflowVersions).values({
        workflowId: w.id,
        version: w.version,
        triggerEvent: trigger,
        graph: w.graph,
        hash: graphHash(w.graph),
        test: w.lastTest!,
        approvedBy: w.approvedBy,
        approvedAt: w.approvedAt!,
        publishedBy: context.userId,
      });
      await tx
        .update(agentWorkflows)
        .set({ status: "published", publishedVersion: w.version, updatedAt: new Date() })
        .where(eq(agentWorkflows.id, w.id));
    });
    await audit(context.userId, "published", w.id, { version: w.version, trigger });
    return { ok: true };
  });

const GrantInput = z.object({ id: z.string().uuid(), orgId: z.string().uuid() });

/**
 * Run the published workflow in an organisation. Every studio agent it uses
 * must be granted there too.
 */
export const grantWorkflow = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => GrantInput.parse(d))
  .handler(async ({ data, context }) => {
    const w = await load(data.id);
    if (w.publishedVersion == null) throw new Error("Publish the workflow first.");
    const [v] = await db
      .select({ graph: agentWorkflowVersions.graph })
      .from(agentWorkflowVersions)
      .where(
        and(
          eq(agentWorkflowVersions.workflowId, w.id),
          eq(agentWorkflowVersions.version, w.publishedVersion),
        ),
      );
    const { publishedStudioAgent, hasGrant } = await import("../server/agents/blueprints.server");
    for (const n of v?.graph.nodes ?? []) {
      if (n.kind !== "agent" || !n.data.agentType?.startsWith("studio:")) continue;
      const p = await publishedStudioAgent(n.data.agentType);
      if (!p || !(await hasGrant(p.blueprintId, data.orgId)))
        throw new Error(
          `Grant the studio agent "${n.data.label || n.data.agentType}" to that organisation first.`,
        );
    }
    const [existing] = await db
      .select({ id: agentWorkflowGrants.id })
      .from(agentWorkflowGrants)
      .where(
        and(
          eq(agentWorkflowGrants.workflowId, w.id),
          eq(agentWorkflowGrants.orgId, data.orgId),
          isNull(agentWorkflowGrants.revokedAt),
        ),
      )
      .limit(1);
    if (existing) return { ok: true };
    await db
      .insert(agentWorkflowGrants)
      .values({ workflowId: w.id, orgId: data.orgId, grantedBy: context.userId });
    await audit(context.userId, "granted", w.id, { version: w.publishedVersion }, data.orgId);
    return { ok: true };
  });

/** Stop running it in an organisation; its live runs are cancelled. */
export const revokeWorkflow = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => GrantInput.parse(d))
  .handler(async ({ data, context }) => {
    await db
      .update(agentWorkflowGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(agentWorkflowGrants.workflowId, data.id),
          eq(agentWorkflowGrants.orgId, data.orgId),
          isNull(agentWorkflowGrants.revokedAt),
        ),
      );
    const cancelled = await (await wf()).cancelWorkflowRuns(data.id, data.orgId);
    await audit(context.userId, "revoked", data.id, { cancelled }, data.orgId);
    return { ok: true };
  });

export const archiveWorkflow = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    const now = new Date();
    await db
      .update(agentWorkflows)
      .set({ status: "archived", updatedAt: now })
      .where(eq(agentWorkflows.id, data.id));
    await db
      .update(agentWorkflowGrants)
      .set({ revokedAt: now })
      .where(
        and(eq(agentWorkflowGrants.workflowId, data.id), isNull(agentWorkflowGrants.revokedAt)),
      );
    const cancelled = await (await wf()).cancelWorkflowRuns(data.id);
    await audit(context.userId, "archived", data.id, { cancelled });
    return { ok: true };
  });

const TemplateInput = z.object({ templateId: z.string().max(80) });

/** A draft copy of a ready-made workflow (with its tests), to customise. */
export const createWorkflowFromTemplate = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => TemplateInput.parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const { WORKFLOW_TEMPLATES } = await import("./workflow-templates");
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === data.templateId);
    if (!t) throw new Error("Template not found.");
    const [row] = await db
      .insert(agentWorkflows)
      .values({
        name: t.name,
        description: t.description,
        graph: structuredClone(t.graph),
        testScenarios: structuredClone(t.tests),
        createdBy: context.userId,
      })
      .returning({ id: agentWorkflows.id });
    await audit(context.userId, "created", row!.id, { template: t.id });
    return { id: row!.id };
  });
