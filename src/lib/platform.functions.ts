import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { writeAudit } from "../server/audit";
import { deletePrefix } from "../server/storage";
import {
  aiProviderCredentials,
  aiSettings,
  applications,
  candidateAssessments,
  candidateVerifications,
  candidates,
  captureEvents,
  copilotMessages,
  evaluations,
  inboxMessages,
  integrationCredentials,
  interviews,
  matchScores,
  offers,
  orgMembers,
  organizations,
  platformAdmins,
  requisitions,
  socialProfiles,
  stageEvents,
  userRoles,
  users,
} from "@db/schema";
import { requireIdentity, requirePlatformAdmin } from "./auth.middleware";

/**
 * Platform (product owner) layer. A super user is anyone whose email address is on the
 * `platform_admins` allowlist. The very first admin is claimed once, while the allowlist
 * is still empty, so the product owner can bootstrap without touching SQL.
 */

export type PlatformOrg = {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  hqCity: string | null;
  hqCountry: string | null;
  currency: string;
  status: string;
  createdAt: string;
  archivedAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;

  members: number;
  requisitions: number;
  openRequisitions: number;
  candidates: number;
  applications: number;
  interviews: number;
  offers: number;
  hires: number;
  lastActivityAt: string | null;
};

export type PlatformState = {
  isSuperUser: boolean;
  claimable: boolean;
  email: string | null;
};

/** Is the signed-in user a platform super user, and can super access still be claimed? */
export const platformState = createServerFn({ method: "GET" })
  // A status probe must ANSWER, not throw: gating it behind requirePlatformAdmin
  // turned "not a super user" into a thrown error that every normal user's
  // session retried and re-fetched forever on the org gate.
  .middleware([requireIdentity])
  .handler(async ({ context }): Promise<PlatformState> => {
    const email = (context.claims?.email as string | undefined)?.toLowerCase() ?? null;
    if (!email) return { isSuperUser: false, claimable: false, email: null };
    const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(platformAdmins);
    const [existing] = await db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(ilike(platformAdmins.email, email))
      .limit(1);
    return {
      isSuperUser: Boolean(existing),
      claimable: (countRow?.n ?? 0) === 0,
      email,
    };
  });

/** One-time bootstrap: the first signed-in user to claim it becomes the product owner. */
export const claimSuperUser = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .handler(async ({ context }) => {
    const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(platformAdmins);
    if ((countRow?.n ?? 0) > 0) throw new Error("Super-user access has already been claimed.");
    await db.insert(platformAdmins).values({
      email: context.email,
      userId: context.userId,
      note: "Bootstrapped product owner",
      createdBy: context.userId,
    });
    return { ok: true };
  });

export const listPlatformAdmins = createServerFn({ method: "GET" })
  .middleware([requirePlatformAdmin])
  .handler(async () => {
    const rows = await db
      .select({
        id: platformAdmins.id,
        email: platformAdmins.email,
        note: platformAdmins.note,
        createdAt: platformAdmins.createdAt,
      })
      .from(platformAdmins)
      .orderBy(platformAdmins.createdAt);
    return rows.map((a) => ({
      id: a.id,
      email: a.email,
      note: a.note,
      createdAt: a.createdAt.toISOString(),
    }));
  });

export const addPlatformAdmin = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .inputValidator((data: unknown) =>
    z.object({ email: z.string().email(), note: z.string().max(160).default("") }).parse(data),
  )
  .handler(async ({ data, context }) => {
    try {
      await db.insert(platformAdmins).values({
        email: data.email.toLowerCase(),
        note: data.note.trim() || null,
        createdBy: context.userId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(
        /duplicate|unique/i.test(message) ? "That email is already a super user." : message,
      );
    }
    await writeAudit({
      actor: context.email,
      actorUserId: context.userId,
      action: "platform.admin.add",
      entityType: "platform_admin",
      detail: { email: data.email.toLowerCase() },
    });
    return { ok: true };
  });

export const removePlatformAdmin = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .select({ id: platformAdmins.id, email: platformAdmins.email })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, data.id))
      .limit(1);
    if (!row) throw new Error("Super user not found.");
    if (row.email.toLowerCase() === context.email) {
      throw new Error("You cannot remove your own super-user access.");
    }
    await db.delete(platformAdmins).where(eq(platformAdmins.id, data.id));
    await writeAudit({
      actor: context.email,
      actorUserId: context.userId,
      action: "platform.admin.remove",
      entityType: "platform_admin",
      entityId: row.id,
      detail: { email: row.email },
    });
    return { ok: true };
  });

/** Every registered organisation with its live usage statistics. */
export const listAllOrganizations = createServerFn({ method: "GET" })
  .middleware([requirePlatformAdmin])
  .handler(async (): Promise<PlatformOrg[]> => {
    const [orgs, members, reqs, cands, apps, ivs, ofrs] = await Promise.all([
      db
        .select()
        .from(organizations)
        .orderBy(sql`${organizations.createdAt} desc`),
      db.select({ orgId: orgMembers.orgId }).from(orgMembers),
      db.select({ orgId: requisitions.orgId, status: requisitions.status }).from(requisitions),
      db.select({ orgId: candidates.orgId }).from(candidates),
      db
        .select({
          orgId: applications.orgId,
          stage: applications.stage,
          lastActivityAt: applications.lastActivityAt,
        })
        .from(applications),
      db.select({ orgId: interviews.orgId }).from(interviews),
      db.select({ orgId: offers.orgId, status: offers.status }).from(offers),
    ]);

    const count = <T extends { orgId: string | null }>(
      rows: T[],
      id: string,
      pred?: (r: T) => boolean,
    ) => rows.filter((r) => r.orgId === id && (!pred || pred(r))).length;

    return orgs.map((o) => {
      const orgApps = apps.filter((a) => a.orgId === o.id);
      const last = orgApps
        .map((a) => a.lastActivityAt)
        .filter(Boolean)
        .sort()
        .pop();
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        industry: o.industry,
        hqCity: o.hqCity,
        hqCountry: o.hqCountry,
        currency: o.currency,
        status: o.status ?? "active",
        createdAt: o.createdAt.toISOString(),
        archivedAt: o.archivedAt ? o.archivedAt.toISOString() : null,
        approvedAt: o.approvedAt ? o.approvedAt.toISOString() : null,
        rejectionReason: o.rejectionReason,
        members: count(members, o.id),
        requisitions: count(reqs, o.id),
        openRequisitions: count(reqs, o.id, (r) => r.status === "approved"),
        candidates: count(cands, o.id),
        applications: orgApps.length,
        interviews: count(ivs, o.id),
        offers: count(ofrs, o.id),
        hires: orgApps.filter((a) => a.stage === "joined" || a.stage === "hired").length,
        lastActivityAt: last ? last.toISOString() : null,
      };
    });
  });

/** Archive or restore a tenant. Archiving locks members out but keeps every record. */
export const setOrganizationStatus = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .inputValidator((data: unknown) =>
    z
      .object({
        orgId: z.string().uuid(),
        status: z.enum(["active", "archived"]),
        reason: z.string().max(300).default(""),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await db
      .update(organizations)
      .set({
        status: data.status,
        archivedAt: data.status === "archived" ? new Date() : null,
        archivedReason: data.status === "archived" ? data.reason.trim() || null : null,
      })
      .where(eq(organizations.id, data.orgId));
    await writeAudit({
      actor: context.email,
      actorUserId: context.userId,
      orgId: data.orgId,
      action: "platform.org.status",
      entityType: "organization",
      entityId: data.orgId,
      detail: { status: data.status, reason: data.reason },
    });
    return { ok: true };
  });

/**
 * Permanently delete a tenant and every record inside it, including the CV
 * vault folder. Irreversible — the console requires the exact organisation
 * name to be typed before calling this.
 */
export const deleteOrganizationAsSuperUser = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .inputValidator((data: unknown) =>
    z.object({ orgId: z.string().uuid(), confirmName: z.string().min(1) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const [org] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, data.orgId))
      .limit(1);
    if (!org) throw new Error("Organisation not found.");
    if (org.name.trim().toLowerCase() !== data.confirmName.trim().toLowerCase()) {
      throw new Error("The typed organisation name does not match.");
    }

    // Capture the sign-in identities before the membership rows disappear, otherwise the
    // accounts survive the tenant and can still authenticate into an empty shell.
    const memberRows = await db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, data.orgId));
    const memberUserIds = Array.from(
      new Set(memberRows.map((m) => m.userId).filter((v): v is string => Boolean(v))),
    );

    await db.transaction(async (tx) => {
      // Most tenant rows die with the org row through ON DELETE CASCADE. These
      // are cleared explicitly so nothing can be left behind by a missed FK.
      await tx.delete(captureEvents).where(eq(captureEvents.orgId, data.orgId));
      await tx.delete(inboxMessages).where(eq(inboxMessages.orgId, data.orgId));
      await tx.delete(copilotMessages).where(eq(copilotMessages.orgId, data.orgId));
      await tx.delete(integrationCredentials).where(eq(integrationCredentials.orgId, data.orgId));
      await tx.delete(aiProviderCredentials).where(eq(aiProviderCredentials.orgId, data.orgId));
      await tx.delete(aiSettings).where(eq(aiSettings.orgId, data.orgId));
      await tx.delete(userRoles).where(eq(userRoles.orgId, data.orgId));
      await tx.delete(orgMembers).where(eq(orgMembers.orgId, data.orgId));
      await tx.delete(organizations).where(eq(organizations.id, data.orgId));
    });

    // Candidate CV files live outside the database — remove the org's vault folder.
    await deletePrefix(`${data.orgId}/`).catch((e) =>
      console.error("vault cleanup failed for deleted org", data.orgId, e),
    );

    const removedAccounts = await purgeOrphanAccounts(memberUserIds);
    await writeAudit({
      actor: context.email,
      actorUserId: context.userId,
      orgId: data.orgId,
      action: "platform.org.delete",
      entityType: "organization",
      entityId: data.orgId,
      detail: { removedAccounts },
    });
    return { ok: true, removedAccounts };
  });

/**
 * Deletes login accounts that no longer belong to any organisation. Platform super users
 * and anyone still holding an active membership elsewhere are always preserved.
 */
async function purgeOrphanAccounts(userIds: string[]) {
  if (userIds.length === 0) return 0;

  const stillMembers = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(inArray(orgMembers.userId, userIds));
  const keep = new Set(stillMembers.map((m) => m.userId).filter(Boolean) as string[]);

  let removed = 0;
  for (const userId of userIds) {
    if (keep.has(userId)) continue;
    const [authUser] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const email = authUser?.email.toLowerCase() ?? null;
    if (email) {
      const [isSuper] = await db
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(ilike(platformAdmins.email, email))
        .limit(1);
      if (isSuper) continue; // never delete a product owner's own login
    }
    await db.delete(userRoles).where(eq(userRoles.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    removed += 1;
  }
  return removed;
}

/** Super users can correct any tenant's profile fields. */
export const updateOrganizationAsSuperUser = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .inputValidator((data: unknown) =>
    z
      .object({
        orgId: z.string().uuid(),
        name: z.string().min(2).max(120),
        industry: z.string().max(80).default(""),
        hqCity: z.string().max(80).default(""),
        hqCountry: z.string().max(80).default(""),
        currency: z.string().max(8).default("INR"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    await db
      .update(organizations)
      .set({
        name: data.name.trim(),
        industry: data.industry.trim() || null,
        hqCity: data.hqCity.trim() || null,
        hqCountry: data.hqCountry.trim() || null,
        currency: data.currency.trim() || "INR",
      })
      .where(eq(organizations.id, data.orgId));
    return { ok: true };
  });

/** Roster of one tenant, so a super user can fix or remove a user in any organisation. */
export const listOrgUsersAsSuperUser = createServerFn({ method: "GET" })
  .middleware([requirePlatformAdmin])
  .inputValidator((data: unknown) => z.object({ orgId: z.string().uuid() }).parse(data))
  .handler(async ({ data }) => {
    const rows = await db
      .select({
        id: orgMembers.id,
        email: orgMembers.email,
        fullName: orgMembers.fullName,
        title: orgMembers.title,
        status: orgMembers.status,
        isOwner: orgMembers.isOwner,
        invitedRole: orgMembers.invitedRole,
        joinedAt: orgMembers.joinedAt,
      })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, data.orgId))
      .orderBy(orgMembers.createdAt);
    return rows.map((m) => ({
      id: m.id,
      email: m.email,
      fullName: m.fullName,
      title: m.title,
      status: m.status,
      isOwner: m.isOwner,
      invitedRole: (m.invitedRole ?? null) as string | null,
      joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
    }));
  });

/** Hard-delete a membership from any organisation (super user override, owners included). */
export const deleteOrgUserAsSuperUser = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .inputValidator((data: unknown) => z.object({ memberId: z.string().uuid() }).parse(data))
  .handler(async ({ data }) => {
    const [member] = await db
      .select({ id: orgMembers.id, orgId: orgMembers.orgId, userId: orgMembers.userId })
      .from(orgMembers)
      .where(eq(orgMembers.id, data.memberId))
      .limit(1);
    if (!member) throw new Error("Member not found.");
    if (member.userId) {
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, member.userId), eq(userRoles.orgId, member.orgId)));
    }
    await db.delete(orgMembers).where(eq(orgMembers.id, member.id));
    const removedAccounts = member.userId ? await purgeOrphanAccounts([member.userId]) : 0;
    return { ok: true, removedAccounts };
  });

/**
 * Approve or reject a freshly registered tenant. Nothing inside a pending organisation
 * works until a super admin approves it, and only then can it invite internal users.
 */
export const reviewOrganization = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .inputValidator((data: unknown) =>
    z
      .object({
        orgId: z.string().uuid(),
        decision: z.enum(["approve", "reject"]),
        reason: z.string().max(300).default(""),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const now = new Date();
    const patch =
      data.decision === "approve"
        ? {
            status: "active",
            approvedAt: now,
            approvedBy: context.userId,
            rejectedAt: null,
            rejectionReason: null,
            onboardingStep: "done",
            onboardedAt: now,
          }
        : {
            status: "rejected",
            rejectedAt: now,
            rejectionReason: data.reason.trim() || "Registration rejected by the platform team.",
            approvedAt: null,
          };
    // The acknowledgement goes out BEFORE access changes, so an owner is never activated
    // (or locked out) ahead of being told why. A mail failure must not block the decision.
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, data.orgId))
      .limit(1);
    const [owner] = await db
      .select({ email: orgMembers.email, fullName: orgMembers.fullName })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, data.orgId), eq(orgMembers.isOwner, true)))
      .limit(1);

    let emailed = false;
    let emailError: string | null = null;
    if (owner?.email && org?.name) {
      try {
        const { sendTemplateEmail } = await import("@/lib/email-templates/send-email");
        const res = await sendTemplateEmail(
          data.decision === "approve" ? "org-approved" : "org-rejected",
          owner.email,
          {
            templateData: {
              orgName: org.name,
              ownerName: owner.fullName ?? undefined,
              ...(data.decision === "reject" ? { reason: patch.rejectionReason ?? undefined } : {}),
            },
            idempotencyKey: `org-${data.decision}-${data.orgId}-${now.toISOString()}`,
          },
        );
        emailed = Boolean((res as { sent?: boolean } | undefined)?.sent ?? true);
      } catch (mailError) {
        emailError =
          mailError instanceof Error ? mailError.message : "Acknowledgement email failed";
        console.error("Organisation decision email failed", mailError);
      }
    }

    await db.update(organizations).set(patch).where(eq(organizations.id, data.orgId));

    return { ok: true, emailed, emailError, notifiedAt: emailed ? now.toISOString() : null };
  });
