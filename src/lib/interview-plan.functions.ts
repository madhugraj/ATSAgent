/**
 * Read and change a role's interview plan (rounds, rubric, panel size, verdict
 * policy). Anyone in the organisation can read it; the hiring team edits it —
 * recruiter, hiring manager, department head, HR head, CBO (or the owner).
 * Changes are audited; "reset" goes back to the default from the must-haves.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { requisitions } from "@db/schema";
import { requireOrg } from "./auth.middleware";

const ReqInput = z.object({ requisitionId: z.string().uuid() });

export const getInterviewPlan = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => ReqInput.parse(d))
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { planFor } = await import("./interview-plan.server");
    return planFor(context.orgId, data.requisitionId);
  });

export const saveInterviewPlan = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => ReqInput.extend({ plan: z.unknown().nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { assertRole } = await import("./auth.middleware");
    await assertRole(
      context.userId,
      context.orgId,
      ["recruiter", "hiring_manager", "department_head", "hr_head", "president_cbo"],
      "Only the hiring team can change the interview plan.",
    );
    const { savePlan, planFor } = await import("./interview-plan.server");
    if (data.plan === null) {
      await db
        .update(requisitions)
        .set({ interviewPlan: null })
        .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, context.orgId)));
    } else {
      await savePlan(context.orgId, data.requisitionId, data.plan);
    }
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "requisition.interview_plan_updated",
      entityType: "requisition",
      entityId: data.requisitionId,
      detail: { reset: data.plan === null },
    });
    return planFor(context.orgId, data.requisitionId);
  });
