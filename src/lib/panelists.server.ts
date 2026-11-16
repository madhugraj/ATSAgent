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

import { orgMembers, panelists, userRoles } from "@db/schema";
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
  /** Invited to sign in, not joined yet. */
  invited: boolean;
  /** A member whose only access is the panel view — managed here, not on the Team page. */
  panelOnly: boolean;
  selfApproved: boolean;
  approvedAt: string | null;
};

/**
 * Who may interview: an active org member, else an active entry of the panel
 * directory (internal without a login, or external). Null when neither — the
 * one check slot offers, agent bookings and manual scheduling share.
 */
export async function activeInterviewer(
  orgId: string,
  email: string,
): Promise<{ name: string | null; email: string } | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const [member] = await db
    .select({ name: orgMembers.fullName, email: orgMembers.email })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, "active"),
        sql`lower(${orgMembers.email}) = ${e}`,
      ),
    )
    .limit(1);
  if (member) return { name: member.name ?? null, email: member.email.toLowerCase() };
  const [listed] = await db
    .select({ name: panelists.fullName, email: panelists.email })
    .from(panelists)
    .where(
      and(
        eq(panelists.orgId, orgId),
        eq(panelists.active, true),
        sql`lower(${panelists.email}) = ${e}`,
      ),
    )
    .limit(1);
  return listed ? { name: listed.name ?? null, email: listed.email.toLowerCase() } : null;
}

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
): Promise<{ id: string; kind: "internal" | "external"; invited: boolean }> {
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
  // An internal panellist without a login is invited to sign in with the
  // Interviewer role only; anyone the invite rules refuse scores by link.
  const invited =
    kind === "internal" && !member
      ? await invitePanelOnly(orgId, userId, email, input.fullName, input.title)
      : false;
  return { id, kind, invited };
}

/**
 * Invite an internal panellist into the organisation with the Interviewer role
 * only (panel view). False when they cannot be invited — another domain or a
 * personal address — or already have a place in the organisation; they then
 * score through private links. Audited by the invite (member.invited).
 */
export async function invitePanelOnly(
  orgId: string,
  inviterUserId: string,
  email: string,
  fullName: string,
  title?: string | null,
): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const { registrableDomain, workEmailProblem } = await import("./work-email");
  if (workEmailProblem(e)) return false;
  const [owner] = await db
    .select({ email: orgMembers.email })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.isOwner, true)))
    .limit(1);
  if (owner?.email && registrableDomain(owner.email) !== registrableDomain(e)) return false;
  const [already] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), sql`lower(${orgMembers.email}) = ${e}`))
    .limit(1);
  if (already) return false;
  const { inviteMemberCore } = await import("./org.functions");
  await inviteMemberCore(orgId, inviterUserId, {
    email: e,
    role: "interviewer",
    title: title?.trim() ?? "",
    fullName: fullName.trim(),
  });
  // The invite's directory entry is this one (syncMemberPanelists claims it).
  const { syncMemberPanelists } = await import("./panels.server");
  await syncMemberPanelists(orgId);
  return true;
}

/**
 * Whether a member's only access is the panel: not the owner, and every role
 * is interviewer (or, before they join, the invited role is).
 */
async function panelOnlyMember(orgId: string, memberId: string) {
  const [m] = await db
    .select({
      id: orgMembers.id,
      userId: orgMembers.userId,
      email: orgMembers.email,
      isOwner: orgMembers.isOwner,
      invitedRole: orgMembers.invitedRole,
    })
    .from(orgMembers)
    .where(and(eq(orgMembers.id, memberId), eq(orgMembers.orgId, orgId)))
    .limit(1);
  if (!m || m.isOwner) return null;
  if (!m.userId) return m.invitedRole === "interviewer" ? m : null;
  const roles = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, m.userId), eq(userRoles.orgId, orgId)));
  return roles.length && roles.every((r) => r.role === "interviewer") ? m : null;
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
  const memberIds = rows.map((r) => r.memberId).filter((x): x is string => Boolean(x));
  const status = new Map<string, { invited: boolean; panelOnly: boolean }>();
  for (const id of memberIds) {
    const [m] = await db
      .select({ status: orgMembers.status })
      .from(orgMembers)
      .where(and(eq(orgMembers.id, id), eq(orgMembers.orgId, orgId)))
      .limit(1);
    status.set(id, {
      invited: m?.status === "invited",
      panelOnly: Boolean(await panelOnlyMember(orgId, id)),
    });
  }
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
    invited: r.memberId ? (status.get(r.memberId)?.invited ?? false) : false,
    panelOnly: r.memberId ? (status.get(r.memberId)?.panelOnly ?? false) : false,
    selfApproved: r.selfApproved,
    approvedAt: r.approvedAt?.toISOString() ?? null,
  }));
}

/**
 * Take a directory entry off (or back on) the panel list. Off: their private
 * links stop opening; a panel-only member also leaves the organisation (roles
 * and membership removed, audited) while the entry stays for history. Back on:
 * an internal entry without a login is invited again. Other members are
 * managed on the Team page.
 */
export async function setPanelistActive(
  orgId: string,
  userId: string,
  id: string,
  active: boolean,
): Promise<{ invited: boolean }> {
  const [p] = await db
    .select({
      email: panelists.email,
      memberId: panelists.memberId,
      kind: panelists.kind,
      fullName: panelists.fullName,
      title: panelists.title,
    })
    .from(panelists)
    .where(and(eq(panelists.id, id), eq(panelists.orgId, orgId)))
    .limit(1);
  if (!p) throw new Error("Panellist not found.");
  const { writeAudit } = await import("../server/audit");
  if (p.memberId) {
    const m = active ? null : await panelOnlyMember(orgId, p.memberId);
    if (!m)
      throw new Error("Org members are taken on or off panels with their interviewer profile.");
    // Keep the entry (no cascade), then remove the panel-only membership.
    await db
      .update(panelists)
      .set({ memberId: null, active: false, updatedAt: new Date() })
      .where(and(eq(panelists.id, id), eq(panelists.orgId, orgId)));
    if (m.userId)
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, m.userId), eq(userRoles.orgId, orgId)));
    await db.delete(orgMembers).where(and(eq(orgMembers.id, m.id), eq(orgMembers.orgId, orgId)));
    await writeAudit({
      actor: `user:${userId}`,
      actorUserId: userId,
      orgId,
      action: "member.removed",
      entityType: "org_member",
      entityId: m.id,
      detail: { email: m.email, role: "interviewer", via: "panel_directory" },
    });
  } else {
    await db
      .update(panelists)
      .set({ active, updatedAt: new Date() })
      .where(and(eq(panelists.id, id), eq(panelists.orgId, orgId)));
  }
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId,
    action: active ? "panelist.reactivated" : "panelist.deactivated",
    entityType: "panelist",
    entityId: id,
    detail: { email: p.email },
  });
  const invited =
    active && p.kind === "internal"
      ? await invitePanelOnly(orgId, userId, p.email, p.fullName, p.title)
      : false;
  return { invited };
}
