/**
 * A role's hiring manager as a registered member (docs/interview-panel-plan.md,
 * P1): read it with the people who can be picked, and change it. Anyone in the
 * organisation can read it; the hiring team changes it. Audited.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";

const ReqInput = z.object({ requisitionId: z.string().uuid() });

export const getRoleHiringManager = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => ReqInput.parse(d))
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { roleHiringManagerOf } = await import("./role-hiring-manager.server");
    return roleHiringManagerOf(context.orgId, data.requisitionId);
  });

export const setRoleHiringManager = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => ReqInput.extend({ memberId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { assertRole } = await import("./auth.middleware");
    await assertRole(
      context.userId,
      context.orgId,
      ["recruiter", "department_head", "hr_head", "president_cbo"],
      "Only the recruiter, the department head, the HR head or the CBO can change the hiring manager.",
    );
    const { setRoleHiringManagerCore } = await import("./role-hiring-manager.server");
    return setRoleHiringManagerCore(
      context.orgId,
      context.userId,
      data.requisitionId,
      data.memberId,
    );
  });
