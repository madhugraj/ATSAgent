/**
 * The people a decider can pick when changing a proposed interview panel
 * (docs/interview-panel-plan.md, P2): the round's eligible interviewers, best
 * first, then everyone else in the panel directory — internal or external (a
 * person may choose anyone active).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { panelists } from "@db/schema";
import { db } from "../server/db";
import { requireOrg } from "./auth.middleware";

export const getPanelChoices = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z.object({ requisitionId: z.string().uuid(), level: z.number().int().min(1).max(3) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { eligibleInterviewers } = await import("./panels.server");
    const { people } = await eligibleInterviewers(context.orgId, data.requisitionId, data.level);
    // Everyone else in the panel directory who may sit on a panel now.
    const { panelPeople } = await import("./panels.server");
    const all = await db
      .select({ id: panelists.id })
      .from(panelists)
      .where(and(eq(panelists.orgId, context.orgId), eq(panelists.active, true)));
    const others = (
      await panelPeople(
        context.orgId,
        all.map((r) => r.id),
      )
    ).map((p) => ({
      memberId: p.memberId,
      name: p.kind === "external" ? `${p.name} (external)` : p.name,
    }));
    return {
      eligible: people.map((p) => ({
        memberId: p.memberId,
        name:
          p.kind === "external"
            ? `${p.name} (external${p.company ? `, ${p.company}` : ""})`
            : p.name,
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
