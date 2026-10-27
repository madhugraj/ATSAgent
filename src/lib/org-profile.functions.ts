/**
 * Organisation → Profile (docs/org-context-agent-plan.md, O0): read the
 * profile and its versions, write a draft by hand, submit it, and the HR
 * head's or owner's decision. Roles are checked again in the cores
 * (src/lib/org-profile.server.ts); every query is scoped to the caller's org.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";

import { db } from "../server/db";
import { userRoles, users } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import type { OrgProfileSections } from "./org-profile";
import { MAX_ITEM_CHARS } from "./org-profile";

export type OrgProfileVersionView = {
  id: string;
  version: number;
  status: string;
  sections: OrgProfileSections;
  injectionFlagged: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
};

export type OrgProfileView = {
  requireProfile: boolean;
  approved: OrgProfileVersionView | null;
  open: OrgProfileVersionView | null;
  history: {
    id: string;
    version: number;
    status: string;
    createdAt: string;
    decidedAt: string | null;
    decisionNote: string | null;
  }[];
  /** HR head, CBO or owner: may write and submit drafts. */
  canEdit: boolean;
  /** HR head or owner: may approve, decline or send back. */
  canDecide: boolean;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function nameOf(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u ? (u.name ?? u.email) : null;
}

async function view(
  v: Awaited<ReturnType<typeof import("./org-profile.server").profileState>>["approved"],
): Promise<OrgProfileVersionView | null> {
  if (!v) return null;
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    sections: v.sections,
    injectionFlagged: v.injectionFlagged,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    updatedBy: await nameOf(v.updatedBy),
    submittedAt: iso(v.submittedAt),
    submittedBy: await nameOf(v.submittedBy),
    decidedAt: iso(v.decidedAt),
    decidedBy: await nameOf(v.decidedBy),
    decisionNote: v.decisionNote,
  };
}

export const getOrgProfile = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<OrgProfileView> => {
    const { profileState } = await import("./org-profile.server");
    const state = await profileState(context.orgId);
    const roles = (
      await db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(and(eq(userRoles.userId, context.userId), eq(userRoles.orgId, context.orgId)))
    ).map((r) => r.role as string);
    return {
      requireProfile: state.requireProfile,
      approved: await view(state.approved),
      open: await view(state.open),
      history: state.history.map((h) => ({
        id: h.id,
        version: h.version,
        status: h.status,
        createdAt: h.createdAt.toISOString(),
        decidedAt: iso(h.decidedAt),
        decisionNote: h.decisionNote,
      })),
      canEdit: context.isOwner || roles.includes("hr_head") || roles.includes("president_cbo"),
      canDecide: context.isOwner || roles.includes("hr_head"),
    };
  });

/** Whether the organisation has an approved profile (the soft gate's notice). */
export const getOrgProfileGate = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { profileGate } = await import("./org-profile.server");
    return profileGate(context.orgId);
  });

export const startOrgProfileDraft = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { startDraftCore } = await import("./org-profile.server");
    const v = await startDraftCore({ orgId: context.orgId, userId: context.userId });
    return { versionId: v.id };
  });

const Item = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(MAX_ITEM_CHARS * 2),
  visibility: z.enum(["candidate", "internal"]),
});

export const saveOrgProfileDraft = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        versionId: z.string().uuid(),
        sections: z.record(z.string().max(40), z.array(Item).max(60)),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { saveDraftCore } = await import("./org-profile.server");
    // Items typed on this page are the person's own words.
    const sections = Object.fromEntries(
      Object.entries(data.sections).map(([k, items]) => [
        k,
        items.map((i) => ({ ...i, source: { kind: "person" as const } })),
      ]),
    );
    return saveDraftCore(
      { orgId: context.orgId, userId: context.userId },
      { versionId: data.versionId, sections },
    );
  });

const VersionInput = z.object({ versionId: z.string().uuid() });

export const submitOrgProfileDraft = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => VersionInput.parse(d))
  .handler(async ({ data, context }) => {
    const { submitDraftCore } = await import("./org-profile.server");
    await submitDraftCore({ orgId: context.orgId, userId: context.userId }, data);
    return { ok: true as const };
  });

export const discardOrgProfileDraft = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => VersionInput.parse(d))
  .handler(async ({ data, context }) => {
    const { discardDraftCore } = await import("./org-profile.server");
    await discardDraftCore({ orgId: context.orgId, userId: context.userId }, data);
    return { ok: true as const };
  });

export const decideOrgProfileVersion = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        versionId: z.string().uuid(),
        decision: z.enum(["approve", "decline", "send_back"]),
        note: z.string().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { decideVersionCore } = await import("./org-profile.server");
    const actor = { orgId: context.orgId, userId: context.userId };
    if (data.decision === "approve")
      await decideVersionCore(actor, {
        versionId: data.versionId,
        decision: "approve",
        note: data.note ?? null,
      });
    else
      await decideVersionCore(actor, {
        versionId: data.versionId,
        decision: data.decision,
        note: data.note ?? "",
      });
    return { ok: true as const };
  });

export const setOrgProfileRequired = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ required: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { setRequireProfileCore } = await import("./org-profile.server");
    await setRequireProfileCore({ orgId: context.orgId, userId: context.userId }, data);
    return { ok: true as const };
  });
