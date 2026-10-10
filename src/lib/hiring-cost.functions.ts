/**
 * Hiring cost in AI tokens and money (the organisation's own rate, else the model's list price): per
 * role — shared work, each candidate, cost per hire — and per candidate.
 * Org-scoped reads; no vendor or model names leave the server.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";

export const getRoleCost = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ requisitionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { roleCost } = await import("../server/agents/hiring-cost.server");
    return roleCost(context.orgId, data.requisitionId);
  });

export const getCandidateCost = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ applicationId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { candidateCost } = await import("../server/agents/hiring-cost.server");
    return candidateCost(context.orgId, data.applicationId);
  });

/** Hiring cost across every role, month by month — HR head, CBO or owner. */
export const getOrgHiringCost = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ months: z.number().int().min(1).max(24).default(6) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head", "president_cbo"],
      "Hiring cost across the organisation is for the HR head, the CBO or an owner.",
    );
    const { orgHiringCost } = await import("../server/agents/hiring-cost.server");
    return orgHiringCost(context.orgId, { months: data.months });
  });
