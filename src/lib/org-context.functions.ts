/**
 * Organisation → Profile, the agent's sources (docs/org-context-agent-plan.md,
 * O1): the organisation's website, its uploaded documents, and starting the
 * Organisation context agent. Roles are checked again in the cores
 * (src/lib/org-context.server.ts); every query is scoped to the caller's org.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { agentPolicies, orgContextSources } from "@db/schema";
import { requireOrg } from "./auth.middleware";

const MAX_UPLOAD_BYTES = 10_000_000;

/** Website, re-read state, sources and whether the agent is switched on. */
export const getOrgContextAdmin = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { orgProfiles } = await import("@db/schema");
    const [profile] = await db
      .select({
        websiteUrl: orgProfiles.websiteUrl,
        websiteConfirmedAt: orgProfiles.websiteConfirmedAt,
        lastRereadAt: orgProfiles.lastRereadAt,
        lastRereadStatus: orgProfiles.lastRereadStatus,
        nextRereadAt: orgProfiles.nextRereadAt,
      })
      .from(orgProfiles)
      .where(eq(orgProfiles.orgId, context.orgId))
      .limit(1);
    const sources = await db
      .select({
        id: orgContextSources.id,
        kind: orgContextSources.kind,
        url: orgContextSources.url,
        fileName: orgContextSources.fileName,
        bytes: orgContextSources.bytes,
        ocrPages: orgContextSources.ocrPages,
        injectionFlagged: orgContextSources.injectionFlagged,
        fetchedAt: orgContextSources.fetchedAt,
        deletedAt: orgContextSources.deletedAt,
      })
      .from(orgContextSources)
      .where(eq(orgContextSources.orgId, context.orgId))
      .orderBy(desc(orgContextSources.createdAt))
      .limit(100);
    const [policy] = await db
      .select({ enabled: agentPolicies.enabled })
      .from(agentPolicies)
      .where(
        and(eq(agentPolicies.orgId, context.orgId), eq(agentPolicies.agentType, "org_context")),
      )
      .limit(1);
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      website: profile?.websiteUrl
        ? {
            url: profile.websiteUrl,
            confirmedAt: iso(profile.websiteConfirmedAt),
            lastRereadAt: iso(profile.lastRereadAt),
            lastRereadStatus: profile.lastRereadStatus,
            nextRereadAt: iso(profile.nextRereadAt),
          }
        : null,
      sources: sources.map((s) => ({
        id: s.id,
        kind: s.kind,
        url: s.url,
        fileName: s.fileName,
        bytes: s.bytes,
        ocr: s.ocrPages > 0,
        injectionFlagged: s.injectionFlagged,
        fetchedAt: iso(s.fetchedAt),
        deleted: Boolean(s.deletedAt),
      })),
      agentEnabled: policy?.enabled ?? false,
    };
  });

export const setOrgWebsite = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ url: z.string().max(400), confirm: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { setWebsiteCore } = await import("./org-context.server");
    return setWebsiteCore({ orgId: context.orgId, userId: context.userId }, data);
  });

export const readOrgWebsiteNow = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ pages: z.array(z.string().max(2000)).max(20).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { readWebsiteCore } = await import("./org-context.server");
    return readWebsiteCore({ orgId: context.orgId, userId: context.userId }, data);
  });

export const uploadOrgDocument = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({ fileName: z.string().min(1).max(300), dataBase64: z.string().max(15_000_000) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const bytes = Buffer.from(data.dataBase64, "base64");
    if (!bytes.byteLength) throw new Error("The file arrived empty; try again.");
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Documents are limited to 10 MB.");
    const { uploadOrgDocumentCore } = await import("./org-context.server");
    return uploadOrgDocumentCore(
      { orgId: context.orgId, userId: context.userId },
      {
        fileName: data.fileName,
        bytes: new Uint8Array(bytes),
      },
    );
  });

export const deleteOrgDocument = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ sourceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { deleteOrgDocumentCore } = await import("./org-context.server");
    await deleteOrgDocumentCore({ orgId: context.orgId, userId: context.userId }, data);
    return { ok: true as const };
  });

/** A person has read the held-back page and says it is fine — extract it now. */
export const acceptOrgSource = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ sourceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { acceptSourceCore } = await import("./org-context.server");
    await acceptSourceCore({ orgId: context.orgId, userId: context.userId }, data);
    return { ok: true as const };
  });

/** "Build it with the agent": start an org_context run as the person clicking. */
export const startOrgContextBuild = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { loadPolicy } = await import("../server/agents/policy");
    if (!(await loadPolicy(context.orgId, "org_context")).enabled)
      throw new Error(
        "The Organisation context agent is switched off. Switch it on in Governance → Agent settings, or keep writing the profile by hand.",
      );
    const { startRun } = await import("../server/agents/runtime.server");
    const { runId } = await startRun({
      orgId: context.orgId,
      agentType: "org_context",
      principalUserId: context.userId,
      goal: "Build the organisation's profile: read the organisation's records, its website and every uploaded document, propose what you find as profile items with their exact quotes, then submit the version for approval.",
      subjectType: "org_profile",
    });
    const { kickAgents } = await import("../server/agents/orchestrator.server");
    kickAgents(context.orgId);
    return { runId };
  });

/**
 * Delete the whole profile and start from nothing (HR head / CBO / owner;
 * audited). The agent's open runs stop, and the require-profile switch is
 * switched off with it.
 */
export const resetOrgProfile = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ reason: z.string().trim().min(3).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(
      context.userId,
      context.orgId,
      "hr_head",
      "Only the HR head or an owner can delete the organisation profile.",
    );
    const { resetProfileCore } = await import("./org-profile.server");
    return resetProfileCore({ orgId: context.orgId, userId: context.userId }, data);
  });

/** Recent refusal count for the Profile page's quiet warning. */
export const getOrgContextRefusals = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { auditLog } = await import("@db/schema");
    const rows = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, context.orgId),
          eq(auditLog.action, "org_profile.items_refused"),
          gt(auditLog.createdAt, sql`now() - interval '7 days'`),
        ),
      )
      .limit(100);
    const refused = rows.flatMap((r) => {
      const d = r.detail as { refused?: unknown[] } | null;
      return Array.isArray(d?.refused) ? d.refused : [];
    });
    return { refusedLastWeek: refused.length };
  });
