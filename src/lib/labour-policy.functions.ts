/**
 * Labour & hiring policy (docs/labour-policy-agent-plan.md): the approved sources
 * and the findings, for the Organisation page. Reading needs a member; changing
 * the source list needs the HR head, the CBO or an owner (checked in the core,
 * audited). Findings are decided in the approvals inbox.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";

const actorOf = (c: { orgId: string; userId: string; memberEmail: string }) => ({
  orgId: c.orgId,
  userId: c.userId,
  memberEmail: c.memberEmail,
});

export const getLabourPolicy = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { listSources, listFindings } = await import("./labour-policy.server");
    const { assertRole } = await import("./auth.middleware");
    const canDecide = await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"])
      .then(() => true)
      .catch(() => false);
    const findings = await listFindings(context.orgId);
    const { loadPolicy } = await import("../server/agents/policy");
    const { db } = await import("../server/db");
    const { agentRuns } = await import("../../drizzle/schema");
    const { and, desc, eq } = await import("drizzle-orm");
    const [lastRun] = await db
      .select({ status: agentRuns.status, at: agentRuns.createdAt, result: agentRuns.result })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, context.orgId), eq(agentRuns.agentType, "labour_policy")))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    return {
      canDecide,
      agentOn: (await loadPolicy(context.orgId, "labour_policy")).enabled,
      lastRun: lastRun
        ? {
            status: lastRun.status,
            at: lastRun.at.toISOString(),
            result: typeof lastRun.result === "string" ? lastRun.result : null,
          }
        : null,
      sources: await listSources(context.orgId),
      findings: findings.map((f) => ({
        ...f,
        createdAt: f.createdAt.toISOString(),
      })),
    };
  });

export const seedPolicySources = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { seedSourcesCore } = await import("./labour-policy.server");
    return seedSourcesCore(actorOf(context));
  });

export const addPolicySource = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z
      .object({
        url: z.string().url().max(500),
        label: z.string().trim().min(3).max(160),
        country: z
          .string()
          .regex(/^[A-Za-z]{2}$/)
          .nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { addSourceCore } = await import("./labour-policy.server");
    return addSourceCore(actorOf(context), data);
  });

export const setPolicySourceActive = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ id: z.string().uuid(), active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { setSourceActiveCore } = await import("./labour-policy.server");
    await setSourceActiveCore(actorOf(context), data);
    return { ok: true };
  });

/** Start a policy check now (HR head, CBO or owner; audited). */
export const checkPolicyNow = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { checkNowCore } = await import("./labour-policy.server");
    return checkNowCore(actorOf(context));
  });

/** Remove a source added by mistake (HR head, CBO or owner; audited). */
export const deletePolicySource = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { deleteSourceCore } = await import("./labour-policy.server");
    await deleteSourceCore(actorOf(context), data);
    return { ok: true };
  });
