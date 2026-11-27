/**
 * Server side of the tenant capability model (docs/candidate-identification/
 * track-b-design.md §1.3, §1.5).
 *
 * The resolver is authoritative; the nav predicates and route guards only
 * mirror it. Absence of a profile row means `full_pipeline` — every existing
 * tenant keeps today's behaviour without a migration of its own.
 */
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { and, eq, isNull } from "drizzle-orm";

import {
  CAPABILITY_MESSAGE,
  CAPABILITIES,
  type Capability,
  type WorkflowProfileSettings,
} from "./capabilities";
import { requireOrg } from "./auth.middleware";
import { db } from "../server/db";
import {
  agentWorkflowGrants,
  agentWorkflows,
  orgWorkflowProfiles,
  type WorkflowProfileKind,
} from "@db/schema";

export type ResolvedProfile = {
  profile: WorkflowProfileKind;
  workflowId: string | null;
  capabilities: Capability[];
  settings: WorkflowProfileSettings;
};

/* Per-process cache (captureEnabled precedent): a platform-admin apply takes
 * effect on this instance immediately (invalidated below) and elsewhere within
 * CAPABILITY_CACHE_MS. Accepted and documented in the design note. */
const CAPABILITY_CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: ResolvedProfile }>();

/** Test helper: forget every cached profile. */
export function resetCapabilitiesCache(): void {
  cache.clear();
}

/** Test helper: pretend time moved on (cache-window tests). */
export function expireCapabilitiesCache(orgId: string): void {
  cache.delete(orgId);
}

/** Invalidate after an apply/settings change so this instance serves the new set at once. */
export function invalidateCapabilities(orgId: string): void {
  cache.delete(orgId);
}

/** All capabilities, in the canonical order. */
export function allCapabilities(): Capability[] {
  return [...CAPABILITIES];
}

/** Resolve (and cache) the tenant's workflow profile and capability set. */
export async function profileOf(orgId: string): Promise<ResolvedProfile> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CAPABILITY_CACHE_MS) return hit.value;
  const [row] = await db
    .select({
      profile: orgWorkflowProfiles.profile,
      workflowId: orgWorkflowProfiles.workflowId,
      resolvedCapabilities: orgWorkflowProfiles.resolvedCapabilities,
      settings: orgWorkflowProfiles.settings,
    })
    .from(orgWorkflowProfiles)
    .where(eq(orgWorkflowProfiles.orgId, orgId))
    .limit(1);
  let value: ResolvedProfile;
  if (!row) {
    value = {
      profile: "full_pipeline",
      workflowId: null,
      capabilities: allCapabilities(),
      settings: {},
    };
  } else if (row.profile === "full_pipeline") {
    value = {
      profile: row.profile,
      workflowId: row.workflowId,
      capabilities: allCapabilities(),
      settings: (row.settings ?? {}) as WorkflowProfileSettings,
    };
  } else {
    // A template/custom profile only holds while its workflow is still live,
    // published and granted (§1.3). revokeWorkflow/archiveWorkflow/deletion do
    // not touch the profile row, so re-verify here and fail CLOSED: a workflow
    // that no longer runs gates its capabilities off (never back on).
    const [w] = row.workflowId
      ? await db
          .select({
            status: agentWorkflows.status,
            publishedVersion: agentWorkflows.publishedVersion,
          })
          .from(agentWorkflows)
          .where(eq(agentWorkflows.id, row.workflowId))
          .limit(1)
      : [];
    const [grant] = row.workflowId
      ? await db
          .select({ id: agentWorkflowGrants.id })
          .from(agentWorkflowGrants)
          .where(
            and(
              eq(agentWorkflowGrants.workflowId, row.workflowId),
              eq(agentWorkflowGrants.orgId, orgId),
              isNull(agentWorkflowGrants.revokedAt),
            ),
          )
          .limit(1)
      : [];
    const live = w && w.status !== "archived" && w.publishedVersion != null && grant;
    value = {
      profile: row.profile,
      workflowId: row.workflowId,
      capabilities: live
        ? row.resolvedCapabilities.filter((c): c is Capability =>
            (CAPABILITIES as readonly string[]).includes(c),
          )
        : [],
      settings: (row.settings ?? {}) as WorkflowProfileSettings,
    };
  }
  cache.set(orgId, { at: Date.now(), value });
  return value;
}

/** The tenant's capability set. */
export async function capabilitiesOf(orgId: string): Promise<Capability[]> {
  return (await profileOf(orgId)).capabilities;
}

/** Imperative assertion for handlers and cores (mirrors assertRole). */
export async function assertCapability(orgId: string, cap: Capability): Promise<void> {
  const caps = await capabilitiesOf(orgId);
  if (!caps.includes(cap)) throw new Error(CAPABILITY_MESSAGE);
}

/**
 * Middleware form, composed AFTER requireOrg / requireRole / requirePanel in
 * the function's middleware array — it only needs context.orgId, which all
 * three yield. The server functions remain the authoritative gate; the nav
 * and the router only mirror this.
 */
export function requireCapability(cap: Capability) {
  return createMiddleware({ type: "function" }).server(async ({ context, next }) => {
    const orgId = (context as unknown as { orgId?: string }).orgId;
    if (!orgId) throw new Error("You are not part of an organisation yet.");
    await assertCapability(orgId, cap);
    return next({ context });
  });
}

/**
 * What the signed-in member's organisation resolves to — the read behind the
 * nav predicates and the route beforeLoad guard. requireOrg (not
 * requireIdentity) so a member without an active organisation gets the same
 * answer as every other tenant read.
 */
export const myCapabilities = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<ResolvedProfile> => {
    return profileOf(context.orgId);
  });
