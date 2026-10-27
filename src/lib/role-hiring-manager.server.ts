/**
 * A role's hiring manager as a registered member (docs/interview-panel-plan.md,
 * P1), server side: read it with the people who can be picked, and change it.
 * Every query is scoped to the organisation; changes are audited.
 */
import { and, eq, sql } from "drizzle-orm";

import { orgMembers, requisitions } from "@db/schema";
import { db } from "../server/db";

/** The role's hiring manager and the active members who can be picked (managers first). */
export async function roleHiringManagerOf(orgId: string, requisitionId: string) {
  const [r] = await db
    .select({ memberId: requisitions.hiringManagerMemberId, name: requisitions.hiringManager })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!r) throw new Error("Requisition not found.");
  const options = (await db.execute(sql`
    select m.id as "memberId", coalesce(nullif(m.full_name, ''), m.email) as name, m.email,
      exists (select 1 from user_roles u where u.user_id = m.user_id and u.org_id = m.org_id
        and u.role in ('hiring_manager', 'department_head')) as manager
    from org_members m
    where m.org_id = ${orgId} and m.status = 'active'
    order by manager desc, name`)) as unknown as {
    memberId: string;
    name: string;
    email: string;
    manager: boolean;
  }[];
  return { memberId: r.memberId, name: r.name, options };
}

/** Set the role's hiring manager to a member of the organisation (the caller checked the role). Audited. */
export async function setRoleHiringManagerCore(
  orgId: string,
  actorUserId: string,
  requisitionId: string,
  memberId: string,
) {
  const [m] = await db
    .select({
      id: orgMembers.id,
      email: orgMembers.email,
      name: sql<string>`coalesce(nullif(${orgMembers.fullName}, ''), ${orgMembers.email})`,
    })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.id, memberId),
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, "active"),
      ),
    )
    .limit(1);
  if (!m) throw new Error("Pick an active member of your organisation.");
  const done = await db
    .update(requisitions)
    .set({ hiringManagerMemberId: m.id, hiringManager: m.name })
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .returning({ id: requisitions.id });
  if (!done.length) throw new Error("Requisition not found.");
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${actorUserId}`,
    actorUserId,
    orgId,
    action: "requisition.hiring_manager_set",
    entityType: "requisition",
    entityId: requisitionId,
    detail: { member: m.email },
  });
  return { memberId: m.id, name: m.name };
}
