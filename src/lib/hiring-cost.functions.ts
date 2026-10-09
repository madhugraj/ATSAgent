/**
 * Hiring cost in AI tokens (and money at the organisation's own rate): per
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
