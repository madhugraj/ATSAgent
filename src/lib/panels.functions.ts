/**
 * The people a decider can pick when changing a proposed interview panel
 * (docs/interview-panel-plan.md, P2): the round's eligible interviewers, best
 * first, then the other active members (a person may choose anyone active).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { orgMembers } from "@db/schema";
import { db } from "../server/db";
import { requireOrg } from "./auth.middleware";

export const getPanelChoices = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ requisitionId: z.string().uuid(), level: z.number().int().min(1).max(3) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { eligibleInterviewers } = await import("./panels.server");
    const { people } = await eligibleInterviewers(context.orgId, data.requisitionId, data.level);
    const others = await db
      .select({
        memberId: orgMembers.id,
        name: sql<string>`coalesce(nullif(${orgMembers.fullName}, ''), ${orgMembers.email})`,
      })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, context.orgId), eq(orgMembers.status, "active")));
    return {
      eligible: people.map((p) => ({
        memberId: p.memberId,
        name: p.name,
        note: [
          p.covers.length ? p.covers.join(", ") : "",
          `${p.load} this week${p.cap ? ` of ${p.cap}` : ""}`,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      others: others
        .filter((o) => !people.some((p) => p.memberId === o.memberId))
        .map((o) => ({ memberId: o.memberId, name: o.name })),
    };
  });
