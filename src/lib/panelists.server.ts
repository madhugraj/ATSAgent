/**
 * The panel directory (docs/panel-directory.md): everyone who may sit on an
 * interview panel. Org members are internal entries (kept in step by
 * syncMemberPanelists); people without a login — employees elsewhere in the
 * company, clients, advisors — are added here by HR, either from the Team page
 * or on the Interview coordinator's request in the hiring desk. Whoever types a
 * person in approves them (recorded as self-approved). Every change is audited;
 * every query is scoped to the organisation.
 */
import { and, asc, eq, sql } from "drizzle-orm";

import { orgMembers, panelists } from "@db/schema";
import { db } from "../server/db";

export type PanelistInput = {
  fullName: string;
  email: string;
  kind: "internal" | "external";
  title?: string | null | undefined;
  company?: string | null | undefined;
  areas: string[];
  rounds: number[];
};

export type PanelistRow = {
  id: string;
  kind: "internal" | "external";
  fullName: string;
  email: string;
  title: string | null;
  company: string | null;
  areas: string[];
  rounds: number[];
  active: boolean;
  /** An org member (signs in, scores in the app). */
  member: boolean;
  selfApproved: boolean;
  approvedAt: string | null;
};

/**
 * Add a person to the directory. An e-mail that belongs to an org member makes
 * them that member's internal entry (their details are updated, not duplicated);
 * an e-mail already in the directory for someone else is refused.
 */
export async function addPanelist(
  orgId: string,
  userId: string,
  input: PanelistInput,
  context: { via: "team_page" | "agent_request"; requisitionId?: string; level?: number },
): Promise<{ id: string; kind: "internal" | "external" }> {
  const email = input.email.trim().toLowerCase();
  const rounds = [...new Set(input.rounds)].filter((r) => r >= 1 && r <= 3).sort();
  if (!rounds.length) throw new Error("Pick at least one interview round (L1–L3).");
  // Tidied as interviewer profiles are: trimmed, de-duplicated (any case), at most 20.
  const { cleanAreas } = await import("./interviewers.server");
  const areas = cleanAreas(input.areas);
  const [member] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), sql`lower(${orgMembers.email}) = ${email}`))
    .limit(1);
  if (member && input.kind === "external")
    throw new Error(`${email} belongs to a member of your organisation — add them as internal.`);
  const { syncMemberPanelists } = await import("./panels.server");
  await syncMemberPanelists(orgId);
  const [existing] = await db
    .select({ id: panelists.id, active: panelists.active, memberId: panelists.memberId })
    .from(panelists)
    .where(and(eq(panelists.orgId, orgId), sql`lower(${panelists.email}) = ${email}`))
    .limit(1);
  const now = new Date();
  let id: string;
  if (existing && !existing.memberId && existing.active)
    throw new Error(`${email} is already in the panel directory.`);
  if (existing) {
    // A member's entry gains the rounds and areas typed; an inactive entry is back.
    await db
      .update(panelists)
      .set({
        ...(existing.memberId ? {} : { fullName: input.fullName.trim() }),
        title: input.title?.trim() || null,
        company: input.kind === "external" ? input.company?.trim() || null : null,
        areas,
        rounds,
        active: true,
        approvedBy: userId,
        approvedAt: now,
        selfApproved: true,
        updatedAt: now,
      })
      .where(and(eq(panelists.id, existing.id), eq(panelists.orgId, orgId)));
    id = existing.id;
  } else {
    const [row] = await db
      .insert(panelists)
      .values({
        orgId,
        kind: input.kind,
        fullName: input.fullName.trim(),
        email,
        title: input.title?.trim() || null,
        company: input.kind === "external" ? input.company?.trim() || null : null,
        areas,
        rounds,
        addedBy: userId,
        approvedBy: userId,
        approvedAt: now,
        selfApproved: true,
      })
      .returning({ id: panelists.id });
    id = row!.id;
  }
  const kind = existing?.memberId ? "internal" : input.kind;
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId,
    action: "panelist.added",
    entityType: "panelist",
    entityId: id,
    detail: {
      email,
      kind,
      company: input.company ?? null,
      rounds,
      selfApproved: true,
      via: context.via,
      ...(context.requisitionId
        ? { requisitionId: context.requisitionId, level: context.level }
        : {}),
    },
  });
  return { id, kind };
}

/** The directory, members first, then by name. */
export async function listPanelists(orgId: string): Promise<PanelistRow[]> {
  const { syncMemberPanelists } = await import("./panels.server");
  await syncMemberPanelists(orgId);
  const rows = await db
    .select()
    .from(panelists)
    .where(eq(panelists.orgId, orgId))
    .orderBy(asc(panelists.kind), asc(panelists.fullName));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    fullName: r.fullName,
    email: r.email,
    title: r.title,
    company: r.company,
    areas: r.areas,
    rounds: r.rounds,
    active: r.active,
    member: Boolean(r.memberId),
    selfApproved: r.selfApproved,
    approvedAt: r.approvedAt?.toISOString() ?? null,
  }));
}

/** Take a directory entry off (or back on) the panel list. Members are managed on the Team page. */
export async function setPanelistActive(
  orgId: string,
  userId: string,
  id: string,
  active: boolean,
): Promise<void> {
  const [p] = await db
    .select({ email: panelists.email, memberId: panelists.memberId })
    .from(panelists)
    .where(and(eq(panelists.id, id), eq(panelists.orgId, orgId)))
    .limit(1);
  if (!p) throw new Error("Panellist not found.");
  if (p.memberId)
    throw new Error("Org members are taken on or off panels with their interviewer profile.");
  await db
    .update(panelists)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(panelists.id, id), eq(panelists.orgId, orgId)));
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId,
    action: active ? "panelist.reactivated" : "panelist.deactivated",
    entityType: "panelist",
    entityId: id,
    detail: { email: p.email },
  });
}
