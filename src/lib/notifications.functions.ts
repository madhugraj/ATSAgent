import { and, asc, eq, ilike, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";

import { requireIdentity, type AppRole } from "./auth.middleware";
import { db } from "../server/db";
import {
  interviews,
  offers,
  orgMembers,
  organizations,
  platformAdmins,
  requisitions,
  userRoles,
} from "@db/schema";

/**
 * Action inbox for the signed-in user. Everything here is derived live from the
 * database, so a notification disappears as soon as the work behind it is done.
 */

export type Notification = {
  id: string;
  kind: "approval" | "interview" | "offer" | "invite" | "platform" | "stale";
  title: string;
  body: string;
  to: string;
  at: string | null;
  severity: "info" | "warn" | "urgent";
};

export const myNotifications = createServerFn({ method: "GET" })
  .middleware([requireIdentity])
  .handler(async ({ context }): Promise<Notification[]> => {
    const email = (context.claims?.["email"] as string | undefined)?.toLowerCase() ?? null;
    const out: Notification[] = [];

    // Platform super users: tenants waiting for approval.
    if (email) {
      const [isSuper] = await db
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(ilike(platformAdmins.email, email))
        .limit(1);
      if (isSuper) {
        const pending = await db
          .select({
            id: organizations.id,
            name: organizations.name,
            createdAt: organizations.createdAt,
          })
          .from(organizations)
          .where(eq(organizations.status, "pending"))
          .orderBy(asc(organizations.createdAt));
        for (const o of pending)
          out.push({
            id: `org:${o.id}`,
            kind: "platform",
            title: `${o.name} is awaiting approval`,
            body: "Review the registration and approve or reject the organisation.",
            to: "/platform",
            at: o.createdAt.toISOString(),
            severity: "urgent",
          });
      }
    }

    const [member] = await db
      .select({ orgId: orgMembers.orgId, isOwner: orgMembers.isOwner })
      .from(orgMembers)
      .where(and(eq(orgMembers.userId, context.userId), eq(orgMembers.status, "active")))
      .limit(1);

    if (member) {
      const orgId = member.orgId;
      const now = Date.now();
      const in7 = new Date(now + 7 * 864e5);

      // The bell is an action inbox: an item may only appear for someone who can
      // actually action it. Roles decide — org membership alone is not enough.
      const roles = (
        await db
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(and(eq(userRoles.userId, context.userId), eq(userRoles.orgId, orgId)))
      ).map((r) => r.role);
      const isAdmin = member.isOwner || roles.includes("president_cbo");
      const APPROVAL_HOP: Record<string, AppRole> = {
        pending_dh: "department_head",
        pending_hr: "hr_head",
        pending_cbo: "president_cbo",
      };
      const canApproveRequisition = (status: string) =>
        isAdmin || (APPROVAL_HOP[status] !== undefined && roles.includes(APPROVAL_HOP[status]!));

      // Freshly approved tenants: a one-time welcome notice so the owner hears
      // the decision in-app (email already goes out; the 10s org poll covers
      // the screen flip itself).
      const [orgRow] = await db
        .select({ status: organizations.status, approvedAt: organizations.approvedAt })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (
        member.isOwner &&
        orgRow?.status === "active" &&
        orgRow.approvedAt &&
        now - orgRow.approvedAt.getTime() < 3 * 864e5
      ) {
        out.push({
          id: "org:approved",
          kind: "platform",
          title: "Your organisation was approved",
          body: "Your workspace is live. Invite your team from Users & roles and raise your first requisition.",
          to: "/",
          at: orgRow.approvedAt.toISOString(),
          severity: "info",
        });
      }

      const [reqs, ofrs, ivs, invites] = await Promise.all([
        db
          .select({
            id: requisitions.id,
            code: requisitions.code,
            title: requisitions.title,
            status: requisitions.status,
            createdAt: requisitions.createdAt,
          })
          .from(requisitions)
          .where(
            and(
              eq(requisitions.orgId, orgId),
              inArray(requisitions.status, ["pending_dh", "pending_hr", "pending_cbo"]),
            ),
          ),
        db
          .select({ id: offers.id, status: offers.status, createdAt: offers.createdAt })
          .from(offers)
          .where(
            and(eq(offers.orgId, orgId), inArray(offers.status, ["pending_hr", "pending_cbo"])),
          ),
        // Only the interviewer's own rounds — an email filter, not org-wide.
        // No lower date bound on purpose: a past session without a scorecard is
        // exactly what the assignee still owes.
        email
          ? db
              .select({
                id: interviews.id,
                interviewer: interviews.interviewer,
                scheduledAt: interviews.scheduledAt,
                status: interviews.status,
              })
              .from(interviews)
              .where(
                and(
                  eq(interviews.orgId, orgId),
                  eq(interviews.status, "scheduled"),
                  isNotNull(interviews.scheduledAt),
                  lte(interviews.scheduledAt, in7),
                  sql`lower(${interviews.interviewerEmail}) = ${email}`,
                ),
              )
              .orderBy(asc(interviews.scheduledAt))
          : Promise.resolve(
              [] as {
                id: string;
                interviewer: string | null;
                scheduledAt: Date | null;
                status: string;
              }[],
            ),
        member.isOwner
          ? db
              .select({
                id: orgMembers.id,
                email: orgMembers.email,
                createdAt: orgMembers.createdAt,
              })
              .from(orgMembers)
              .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, "invited")))
          : Promise.resolve([] as { id: string; email: string; createdAt: Date }[]),
      ]);

      for (const r of reqs.filter((r) => canApproveRequisition(r.status)))
        out.push({
          id: `req:${r.id}`,
          kind: "approval",
          title: `${r.code} · ${r.title} needs approval`,
          body: `Requisition is waiting at ${r.status.replace("pending_", "").toUpperCase()}.`,
          to: `/requisitions/${r.id}`,
          at: r.createdAt.toISOString(),
          severity: "urgent",
        });

      if (ofrs.length && (isAdmin || roles.includes("hr_head")))
        out.push({
          id: "offers:pending",
          kind: "offer",
          title: `${ofrs.length} offer(s) awaiting approval`,
          body: "Review compensation and release the offer.",
          to: "/offers",
          at: ofrs[0]?.createdAt.toISOString() ?? null,
          severity: "warn",
        });

      for (const iv of ivs.slice(0, 8)) {
        const when = iv.scheduledAt;
        const soon = when ? when.getTime() - now < 864e5 : false;
        out.push({
          id: `iv:${iv.id}`,
          kind: "interview",
          title: `Interview ${when ? when.toLocaleString() : "scheduled"}`,
          body: `${iv.interviewer ?? "Interviewer"} — scorecard due after the session.`,
          to: "/interviews/mine",
          at: when ? when.toISOString() : null,
          severity: soon ? "urgent" : "info",
        });
      }

      for (const i of invites)
        out.push({
          id: `inv:${i.id}`,
          kind: "invite",
          title: `${i.email} has not signed in yet`,
          body: "The invitation is still unclaimed.",
          to: "/team",
          at: i.createdAt.toISOString(),
          severity: "info",
        });
    }

    const rank = { urgent: 0, warn: 1, info: 2 } as const;
    return out.sort(
      (a, b) => rank[a.severity] - rank[b.severity] || (a.at ?? "").localeCompare(b.at ?? ""),
    );
  });
