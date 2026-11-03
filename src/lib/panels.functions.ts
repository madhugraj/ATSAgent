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

/** Each round's approved panel for a role (the hiring plan editor). */
export const getRolePanels = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ requisitionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { approvedPanel } = await import("./panels.server");
    const out: Record<number, { memberId: string; name: string; kind: string }[]> = {};
    for (const level of [1, 2, 3]) {
      const p = await approvedPanel(context.orgId, data.requisitionId, level);
      out[level] = (p?.members ?? []).map((m) => ({
        memberId: m.memberId,
        name: m.name,
        kind: m.kind,
      }));
    }
    return out;
  });

/**
 * Set a round's panel from the hiring plan editor — a person's decision, as when
 * they approve or change the coordinator's proposal: the role's hiring manager,
 * the HR head, the department head or the CBO (or an owner). Audited.
 */
export const saveRolePanel = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid(),
        level: z.number().int().min(1).max(3),
        memberIds: z.array(z.string().uuid()).min(1).max(3),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { assertRequisitionInOrg } = await import("../server/guards");
    await assertRequisitionInOrg(data.requisitionId, context.orgId);
    const { assertRole } = await import("./auth.middleware");
    const { requisitions, orgMembers } = await import("@db/schema");
    const [hm] = await db
      .select({ userId: orgMembers.userId })
      .from(requisitions)
      .innerJoin(orgMembers, eq(orgMembers.id, requisitions.hiringManagerMemberId))
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, context.orgId)))
      .limit(1);
    if (hm?.userId !== context.userId)
      await assertRole(
        context.userId,
        context.orgId,
        ["hr_head", "department_head", "president_cbo"],
        "Only the role's hiring manager, the HR head, the department head or the CBO can set its panels.",
      );
    const { planFor } = await import("./interview-plan.server");
    const { roundOf } = await import("./interview-plan");
    const round = roundOf((await planFor(context.orgId, data.requisitionId)).plan, data.level);
    if (!round) throw new Error(`This role's interview plan has no round L${data.level}.`);
    if (new Set(data.memberIds).size > round.panelSize)
      throw new Error(
        `Round L${data.level} has a panel of ${round.panelSize}; raise the panel size first.`,
      );
    const { savePanel } = await import("./panels.server");
    const saved = await savePanel(
      context.orgId,
      context.userId,
      data.requisitionId,
      data.level,
      data.memberIds,
      true,
    );
    return saved.members.map((m) => ({ memberId: m.memberId, name: m.name, kind: m.kind }));
  });
