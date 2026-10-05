/**
 * Authorization seam.
 *
 * `requireIdentity` (authn) verifies the caller's identity. Everything on
 * top of it here is authorization, computed from the verified identity only —
 * never from client input. Every tenant-scoped server function must use
 * `requireOrg` (or `requireRole`), and every query it issues must carry an
 * explicit `org_id` predicate. `requireIdentity` reads the
 * database-backed session cookie.
 */
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, inArray } from "drizzle-orm";

import { emailVerified } from "../server/claims";
import { db } from "../server/db";
import { orgMembers, platformAdmins, userRoles } from "@db/schema";

/** The verified-identity claim shape the rest of the app reads. */
export type IdentityClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  email_confirmed_at?: string | null;
};

export type AppRole =
  "recruiter" | "hiring_manager" | "department_head" | "hr_head" | "president_cbo";

export type OrgContext = {
  orgId: string;
  isOwner: boolean;
  memberEmail: string;
};

/** Resolve the caller's active organisation. First membership wins, matching the legacy `current_org_id()`. */
export async function activeOrgOf(userId: string): Promise<OrgContext | null> {
  const [membership] = await db
    .select({ orgId: orgMembers.orgId, isOwner: orgMembers.isOwner, email: orgMembers.email })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, "active")))
    .orderBy(orgMembers.createdAt)
    .limit(1);
  if (!membership) return null;
  return {
    orgId: membership.orgId,
    isOwner: membership.isOwner,
    memberEmail: membership.email,
  };
}

/** Imperative role assertion for use inside handlers (input-dependent checks). */
export async function assertRole(
  userId: string,
  orgId: string,
  role: AppRole | AppRole[],
  message = "You do not have permission to perform this action.",
): Promise<void> {
  const org = await activeOrgOf(userId);
  if (!org || org.orgId !== orgId) throw new Error(message);
  if (org.isOwner) return;
  const wanted = Array.isArray(role) ? role : [role];
  const [row] = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.orgId, orgId),
        inArray(userRoles.role, wanted),
      ),
    )
    .limit(1);
  if (!row) throw new Error(message);
}

/** Authn only: the atsiq_session httpOnly cookie.
 *  The definition lives in this client-reached module; the server-only
 *  resolution (server/identity.ts) is imported lazily inside the .server()
 *  body, so the client bundle never pulls it in. */
export const requireIdentity = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { resolveSession } = await import("../server/identity");
  const request = getRequest();
  const session = request ? await resolveSession(request) : null;
  if (!session) throw new Error("Unauthorized: No authorization header provided");
  return next({
    context: {
      userId: session.userId,
      // A cookie session carries no JWT — fabricate the claim shape the
      // rest of the app reads (sub / email / email_verified).
      claims: {
        sub: session.userId,
        email: session.email,
        email_verified: true,
      } satisfies IdentityClaims,
    },
  });
});

/** Authn + tenant resolution. Context gains a verified `orgId`; queries must scope on it. */
export const requireOrg = createMiddleware({ type: "function" })
  .middleware([requireIdentity])
  .server(async ({ context, next }) => {
    const org = await activeOrgOf(context.userId);
    if (!org) throw new Error("You are not part of an organisation yet.");
    return next({ context: { ...context, ...org } });
  });

/** Authn + tenant + role. An org owner passes every role; otherwise a matching user_roles row must exist. */
export function requireRole(role: AppRole) {
  return createMiddleware({ type: "function" })
    .middleware([requireIdentity])
    .server(async ({ context, next }) => {
      const org = await activeOrgOf(context.userId);
      if (!org) throw new Error("You are not part of an organisation yet.");
      if (!org.isOwner) {
        const [row] = await db
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(
            and(
              eq(userRoles.userId, context.userId),
              eq(userRoles.orgId, org.orgId),
              eq(userRoles.role, role),
            ),
          )
          .limit(1);
        if (!row) throw new Error("You do not have permission to perform this action.");
      }
      return next({ context: { ...context, ...org } });
    });
}

/** Authn + org-owner check (membership `is_owner` flag, verified server-side). */
export const requireOrgOwner = createMiddleware({ type: "function" })
  .middleware([requireIdentity])
  .server(async ({ context, next }) => {
    const org = await activeOrgOf(context.userId);
    if (!org) throw new Error("You are not part of an organisation yet.");
    if (!org.isOwner) throw new Error("Only an organisation owner can do this.");
    return next({ context: { ...context, ...org } });
  });

/** Authn + platform super-user allowlist (keyed by verified email, case-insensitive). */
export const requirePlatformAdmin = createMiddleware({ type: "function" })
  .middleware([requireIdentity])
  .server(async ({ context, next }) => {
    const claims = (context.claims ?? {}) as Record<string, unknown>;
    const email = typeof claims["email"] === "string" ? claims["email"].toLowerCase() : undefined;
    if (!email) throw new Error("Your account has no email address.");
    // The allowlist is keyed by email, so the email must be verified — an
    // unverified marker must never match the super-user allowlist.
    if (!emailVerified(claims))
      throw new Error("Verify your email address before using the super-user console.");
    const [row] = await db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, email))
      .limit(1);
    if (!row) throw new Error("Super-user access only.");
    return next({ context: { ...context, email } });
  });
