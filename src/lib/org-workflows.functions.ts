/**
 * Agent workflows inside an organisation (docs/agent-workflows.md § Going
 * live): the workflows the platform granted it, what each needs before it can
 * run here (AI key, agents switched on, studio agents granted) and its recent
 * runs. Read-only and org-scoped; HR head or President / CBO (owner passes).
 * Switching agents on stays in Agent settings (`saveAgentPolicy`).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray } from "drizzle-orm";

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
  }[];
};

export const orgWorkflows = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<OrgWorkflowRow[]> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"]);
    const { grantedWorkflows, workflowReadiness } =
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
          })),
      })),
    );
  });
