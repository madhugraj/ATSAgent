/**
 * Agent workflows inside an organisation (docs/agent-workflows.md): the
 * manual (hiring-need) workflows the platform granted it, its workflow runs,
 * and their reports. Org-scoped; starting one and reading reports need the
 * HR head or President / CBO (owner passes). Agents act for the person who
 * starts the run.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  agentWorkflowGrants,
  agentWorkflows,
  agentWorkflowVersions,
  workflowRuns,
} from "@db/schema";
import { db } from "../server/db";
import { requireOrg } from "./auth.middleware";

const ROLES = ["hr_head", "president_cbo"] as const;

async function assertRoles(ctx: { userId: string; orgId: string }) {
  const { assertRole } = await import("./auth.middleware");
  await assertRole(ctx.userId, ctx.orgId, [...ROLES]);
}

export type OrgWorkflowsView = {
  startable: { id: string; name: string; description: string }[];
  runs: {
    id: string;
    workflow: string;
    status: string;
    createdAt: string;
    need: string | null;
    lastNote: string | null;
    error: string | null;
  }[];
};

export const orgWorkflows = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<OrgWorkflowsView> => {
    await assertRoles(context);
    const startable = await db
      .select({
        id: agentWorkflows.id,
        name: agentWorkflows.name,
        description: agentWorkflows.description,
      })
      .from(agentWorkflows)
      .innerJoin(
        agentWorkflowGrants,
        and(
          eq(agentWorkflowGrants.workflowId, agentWorkflows.id),
          eq(agentWorkflowGrants.orgId, context.orgId),
          isNull(agentWorkflowGrants.revokedAt),
        ),
      )
      .innerJoin(
        agentWorkflowVersions,
        and(
          eq(agentWorkflowVersions.workflowId, agentWorkflows.id),
          eq(agentWorkflowVersions.version, agentWorkflows.publishedVersion),
          eq(agentWorkflowVersions.triggerEvent, "manual"),
        ),
      )
      .where(inArray(agentWorkflows.status, ["draft", "tested", "approved", "published"]));
    const runs = await db
      .select({ r: workflowRuns, name: agentWorkflows.name })
      .from(workflowRuns)
      .innerJoin(agentWorkflows, eq(agentWorkflows.id, workflowRuns.workflowId))
      .where(eq(workflowRuns.orgId, context.orgId))
      .orderBy(desc(workflowRuns.createdAt))
      .limit(50);
    return {
      startable,
      runs: runs.map(({ r, name }) => {
        const ctx = r.context as { payload?: { need?: unknown } };
        return {
          id: r.id,
          workflow: name,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          need: typeof ctx.payload?.need === "string" ? ctx.payload.need : null,
          lastNote: r.history[r.history.length - 1]?.note ?? null,
          error: r.error,
        };
      }),
    };
  });

const StartInput = z.object({
  workflowId: z.string().uuid(),
  need: z.string().trim().min(5).max(4000),
});

/** Start a granted manual workflow with a hiring need; its agents act for the caller. */
export const startOrgWorkflow = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => StartInput.parse(d))
  .handler(async ({ data, context }): Promise<{ runId: string }> => {
    await assertRoles(context);
    const { ensureAgentsRegistered } = await import("../server/agents");
    ensureAgentsRegistered();
    const { resolveAiConfig } = await import("./ai-gateway.server");
    if (!(await resolveAiConfig(context.orgId)).apiKey)
      throw new Error("Add your organisation's AI model key in Integrations first.");
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
      action: "agent_workflow.started",
      entityType: "workflow_run",
      entityId: r.runId,
      detail: { workflowId: data.workflowId },
    });
    return r;
  });

const ReportInput = z.object({ runId: z.string().uuid() });

/** A workflow run's report data in this organisation (rendered as PDF or Excel in the browser). */
export const orgWorkflowReport = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) => ReportInput.parse(d))
  .handler(async ({ data, context }) => {
    await assertRoles(context);
    const { workflowRunReport } = await import("../server/agents/workflows.server");
    const r = await workflowRunReport(data.runId, context.orgId);
    if (!r) throw new Error("Run not found.");
    return r;
  });
