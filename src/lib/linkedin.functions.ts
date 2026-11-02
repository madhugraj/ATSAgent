import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { orgLinkedinConnections, requisitions } from "@db/schema";
import { requireOrg, requireRole } from "./auth.middleware";
import type { LinkedinCapability } from "./linkedin.server";
import {
  authorizeUrl,
  fetchMember,
  linkedinEnvConfigured,
  linkedinOrgToken,
  postAsMember,
  probeCapabilities,
  signState,
} from "./linkedin.server";

export type LinkedinStatus = {
  /** True when the ATSIQ LinkedIn app itself is set up (platform-side). */
  configured: boolean;
  /** True when this organisation has authorised its own LinkedIn account. */
  connected: boolean;
  member: string | null;
  memberEmail: string | null;
  connectedAt: string | null;
  expiresSoon: boolean;
};

/** Per-organisation LinkedIn connection status. */
export const linkedinStatus = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<LinkedinStatus> => {
    const base: LinkedinStatus = {
      configured: linkedinEnvConfigured(),
      connected: false,
      member: null,
      memberEmail: null,
      connectedAt: null,
      expiresSoon: false,
    };
    if (!base.configured) return base;

    const [row] = await db
      .select({
        memberName: orgLinkedinConnections.memberName,
        memberEmail: orgLinkedinConnections.memberEmail,
        connectedAt: orgLinkedinConnections.connectedAt,
        expiresAt: orgLinkedinConnections.expiresAt,
      })
      .from(orgLinkedinConnections)
      .where(eq(orgLinkedinConnections.orgId, context.orgId))
      .limit(1);
    if (!row) return base;

    const expiresAt = row.expiresAt ? row.expiresAt.getTime() : null;
    return {
      ...base,
      connected: true,
      member: row.memberName ?? null,
      memberEmail: row.memberEmail ?? null,
      connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
      expiresSoon: expiresAt !== null && expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000,
    };
  });

/** Start the one-time sign-in: returns the LinkedIn URL to open. */
export const startLinkedInConnect = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ origin: z.string().url() }).parse(data))
  .handler(async ({ data, context }) => {
    if (!linkedinEnvConfigured())
      throw new Error(
        "LinkedIn is not set up on this platform yet — ask your ATSIQ administrator.",
      );
    const state = signState({
      orgId: context.orgId,
      userId: context.userId,
      origin: data.origin,
      ts: Date.now(),
    });
    return { url: authorizeUrl(state) };
  });

/** Forget this organisation's LinkedIn account. */
export const disconnectLinkedIn = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .handler(async ({ context }) => {
    await db.delete(orgLinkedinConnections).where(eq(orgLinkedinConnections.orgId, context.orgId));
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      orgId: context.orgId,
      actorUserId: context.userId,
      action: "linkedin.disconnect",
      entityType: "integration",
      entityId: context.orgId,
      detail: { provider: "linkedin" },
    });
    return { ok: true as const };
  });

const PublishInput = z.object({
  requisitionId: z.string().uuid(),
  text: z.string().min(1).max(3000),
});

/** Publish the designed post text to the organisation's own LinkedIn account. */
export const publishToLinkedIn = createServerFn({ method: "POST" })
  .middleware([requireRole("hr_head")])
  .validator((data: unknown) => PublishInput.parse(data))
  .handler(async ({ data, context }) => {
    const [requisition] = await db
      .select({ id: requisitions.id })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, context.orgId)))
      .limit(1);
    if (!requisition) throw new Error("Requisition not found.");

    const { accessToken, memberSub } = await linkedinOrgToken(context.orgId);
    // Confirms the token still works and keeps the stored identity honest.
    await fetchMember(accessToken);
    const postUrn = await postAsMember(accessToken, memberSub, data.text.trim());
    return { ok: true as const, postUrn };
  });

/** Ask LinkedIn what this organisation's connection is actually allowed to do. */
export const linkedinCapabilities = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<LinkedinCapability[]> => {
    const [row] = await db
      .select({ scope: orgLinkedinConnections.scope })
      .from(orgLinkedinConnections)
      .where(eq(orgLinkedinConnections.orgId, context.orgId))
      .limit(1);
    if (!row) return [];
    const { accessToken } = await linkedinOrgToken(context.orgId);
    return probeCapabilities(accessToken, row.scope ?? null);
  });
