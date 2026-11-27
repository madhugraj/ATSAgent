/**
 * Tenant workflow profile server functions (docs/candidate-identification/
 * track-b-design.md §1.3–§1.4). The platform-admin apply step writes the
 * profile row; tenant governance may later adjust profile settings, with
 * step-up re-authentication when that enables auto-approved requisitions.
 * Absence of a row means `full_pipeline` with every capability.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { writeAudit } from "../server/audit";
import {
  agentWorkflowGrants,
  agentWorkflowVersions,
  agentWorkflows,
  orgWorkflowProfiles,
  organizations,
  type WorkflowProfileKind,
} from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import {
  AGENT_CAPABILITIES,
  CAPABILITIES,
  type Capability,
  type WorkflowProfileSettings,
  capabilitiesForSetting,
} from "./capabilities";
import { invalidateCapabilities, profileOf, capabilitiesOf } from "./capabilities.server";
import { STEP_UP_MESSAGE } from "../server/step-up";

/** Zod shape of WorkflowProfileSettings — shared by the apply and settings steps. */
export const WorkflowProfileSettingsInput = z
  .object({
    jdRequisitionMode: z.enum(["approval_gate", "auto_approved"]),
    jdDuplicateLookbackDays: z.number().int().min(1).max(365),
    payVarianceTolerance: z.number().min(0).max(1),
    profileMatchTopK: z.number().int().min(5).max(200),
    profileMatchWeights: z
      .object({
        must: z.number().min(0).max(1),
        nice: z.number().min(0).max(1),
        experience: z.number().min(0).max(1),
        sector: z.number().min(0).max(1),
        location: z.number().min(0).max(1),
      })
      .partial(),
  })
  .partial();

export type WorkflowProfileSettingsInput = z.infer<typeof WorkflowProfileSettingsInput>;

/** Drop keys the caller did not actually provide (zod partial keeps undefined values). */
export function providedSettings(input: WorkflowProfileSettingsInput): WorkflowProfileSettings {
  const out: WorkflowProfileSettings = {};
  if (input.jdRequisitionMode != null) out.jdRequisitionMode = input.jdRequisitionMode;
  if (input.jdDuplicateLookbackDays != null)
    out.jdDuplicateLookbackDays = input.jdDuplicateLookbackDays;
  if (input.payVarianceTolerance != null) out.payVarianceTolerance = input.payVarianceTolerance;
  return out;
}

/**
 * Capabilities the published version's graph resolves, via the agent→capability
 * map (§1.2): agent_workflows (live, published) → agent_workflow_versions →
 * the union of every agent node's capabilities. Unknown and studio agent types
 * contribute nothing — studio agents carry their own grants, not capabilities.
 * Returns [] when the workflow is missing, archived or unpublished.
 */
export async function deriveCapabilities(workflowId: string): Promise<Capability[]> {
  const [w] = await db
    .select({ status: agentWorkflows.status, publishedVersion: agentWorkflows.publishedVersion })
    .from(agentWorkflows)
    .where(eq(agentWorkflows.id, workflowId))
    .limit(1);
  if (!w || w.status === "archived" || w.publishedVersion == null) return [];
  const [v] = await db
    .select({ graph: agentWorkflowVersions.graph })
    .from(agentWorkflowVersions)
    .where(
      and(
        eq(agentWorkflowVersions.workflowId, workflowId),
        eq(agentWorkflowVersions.version, w.publishedVersion),
      ),
    )
    .limit(1);
  const resolved = new Set<Capability>();
  for (const n of v?.graph.nodes ?? []) {
    const type = n.kind === "agent" ? n.data.agentType : undefined;
    if (!type || type.startsWith("studio:")) continue;
    for (const c of AGENT_CAPABILITIES[type] ?? []) resolved.add(c);
  }
  // Canonical order, so the stored set is stable across applies.
  return CAPABILITIES.filter((c) => resolved.has(c));
}

/**
 * Refuse when any chosen setting depends on a capability the profile does not
 * resolve (§1.2 dependency rule) — e.g. the approval gate with no approval
 * chain to gate. Shared by the platform apply step and tenant settings change.
 */
export function assertSettingsFitCapabilities(
  settings: WorkflowProfileSettings,
  capabilities: Capability[],
): void {
  for (const [key, value] of Object.entries(settings)) {
    if (value == null) continue;
    for (const cap of capabilitiesForSetting(key as keyof WorkflowProfileSettings, value)) {
      if (!capabilities.includes(cap))
        throw new Error(
          `The "${key}" setting needs the ${cap} capability, which this workflow profile does not resolve.`,
        );
    }
  }
}

/** What the signed-in member's organisation runs (§1.3). */
export const myWorkflowProfile = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const p = await profileOf(context.orgId);
    return {
      profile: p.profile satisfies WorkflowProfileKind,
      workflowId: p.workflowId,
      capabilities: p.capabilities,
      settings: p.settings,
    };
  });

/**
 * Core behind saveWorkflowProfileSettings (testable without request context;
 * the server fn delegates). `request` carries the caller's session for the
 * step-up check — null in tests, which then sees the STEP_UP_REQUIRED signal.
 */
export async function saveWorkflowProfileSettingsCore(input: {
  orgId: string;
  settings: WorkflowProfileSettingsInput;
  actor: { email: string; userId: string };
  request: Request | null;
}): Promise<{ ok: true; settings: WorkflowProfileSettings }> {
  const patch = providedSettings(input.settings);
  if (Object.keys(patch).length === 0) throw new Error("Nothing to change.");

  const [row] = await db
    .select({ profile: orgWorkflowProfiles.profile, settings: orgWorkflowProfiles.settings })
    .from(orgWorkflowProfiles)
    .where(eq(orgWorkflowProfiles.orgId, input.orgId))
    .limit(1);
  const before = (row?.settings ?? {}) as WorkflowProfileSettings;
  const after: WorkflowProfileSettings = { ...before, ...patch };

  assertSettingsFitCapabilities(after, await capabilitiesOf(input.orgId));

  if (after.jdRequisitionMode === "auto_approved" && before.jdRequisitionMode !== "auto_approved") {
    // Turning on auto-approved requisitions is consequential: it needs a
    // fresh password in this session (docs/guardrails.md P2-4). No request
    // context at all (background/test callers) cannot pass the check either.
    if (!input.request) throw new Error(STEP_UP_MESSAGE);
    const { assertStepUp } = await import("../server/step-up");
    await assertStepUp(input.actor.userId, input.request);
  }

  const now = new Date();
  await db
    .insert(orgWorkflowProfiles)
    .values({
      orgId: input.orgId,
      profile: row?.profile ?? "full_pipeline",
      resolvedCapabilities: [],
      settings: after,
      appliedBy: input.actor.userId,
      appliedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orgWorkflowProfiles.orgId,
      set: { settings: after, updatedAt: now },
    });

  await writeAudit({
    actor: input.actor.email,
    actorUserId: input.actor.userId,
    orgId: input.orgId,
    action: "workflow_profile.settings_updated",
    entityType: "organization",
    entityId: input.orgId,
    detail: { before, after },
  });
  invalidateCapabilities(input.orgId);
  return { ok: true as const, settings: after };
}

/**
 * Tenant governance (owner, HR head or president cbo) adjusts profile
 * settings. Every change is audited with before/after; enabling
 * `auto_approved` requires a fresh password (step-up). Settings merge over the
 * stored row — read fresh, never from the 30 s resolver cache.
 */
export const saveWorkflowProfileSettings = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ settings: WorkflowProfileSettingsInput }).parse(data))
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head", "president_cbo"],
      "Only the organisation's governance can change workflow settings.",
    );
    const { getRequest } = await import("@tanstack/react-start/server");
    return saveWorkflowProfileSettingsCore({
      orgId: context.orgId,
      settings: data.settings,
      actor: { email: context.memberEmail, userId: context.userId },
      request: getRequest(),
    });
  });

/**
 * Core behind the platform-admin apply step (testable without request
 * context; the server fn in platform.functions.ts delegates). Verifies the
 * workflow is published and its studio agents granted, keeps the grant
 * bookkeeping in step, resolves the capability set server-side, refuses
 * settings whose capability dependency is missing, and audits everything.
 */
export async function applyWorkflowProfileCore(input: {
  orgId: string;
  profile: WorkflowProfileKind;
  workflowId?: string | null;
  settings?: WorkflowProfileSettingsInput | undefined;
  actor: { email: string; userId: string };
}): Promise<{
  ok: true;
  profile: WorkflowProfileKind;
  workflowId: string | null;
  capabilities: Capability[];
  settings: WorkflowProfileSettings;
}> {
  if (input.profile !== "full_pipeline" && !input.workflowId)
    throw new Error("Choose the published workflow this profile runs.");
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);
  if (!org) throw new Error("Organisation not found.");

  const [previous] = await db
    .select({ profile: orgWorkflowProfiles.profile, workflowId: orgWorkflowProfiles.workflowId })
    .from(orgWorkflowProfiles)
    .where(eq(orgWorkflowProfiles.orgId, input.orgId))
    .limit(1);

  const workflowId = input.profile === "full_pipeline" ? null : input.workflowId!;
  let capabilities: Capability[];

  if (workflowId) {
    // Published workflow only — the same gate grantWorkflow enforces.
    const [w] = await db
      .select({ status: agentWorkflows.status, publishedVersion: agentWorkflows.publishedVersion })
      .from(agentWorkflows)
      .where(eq(agentWorkflows.id, workflowId))
      .limit(1);
    if (!w || w.status === "archived") throw new Error("Workflow not found.");
    if (w.publishedVersion == null) throw new Error("Publish the workflow first.");

    const [v] = await db
      .select({ graph: agentWorkflowVersions.graph })
      .from(agentWorkflowVersions)
      .where(
        and(
          eq(agentWorkflowVersions.workflowId, workflowId),
          eq(agentWorkflowVersions.version, w.publishedVersion),
        ),
      )
      .limit(1);
    const { publishedStudioAgent, hasGrant } = await import("../server/agents/blueprints.server");
    for (const n of v?.graph.nodes ?? []) {
      if (n.kind !== "agent" || !n.data.agentType?.startsWith("studio:")) continue;
      const p = await publishedStudioAgent(n.data.agentType);
      if (!p || !(await hasGrant(p.blueprintId, input.orgId)))
        throw new Error(`Grant the studio agent "${n.data.label || n.data.agentType}" first.`);
    }

    capabilities = await deriveCapabilities(workflowId);
  } else {
    capabilities = [...CAPABILITIES];
  }

  // Provided settings merge over whatever the org already stored. Validated
  // before any write, so a refused apply changes nothing.
  const [stored] = await db
    .select({ settings: orgWorkflowProfiles.settings })
    .from(orgWorkflowProfiles)
    .where(eq(orgWorkflowProfiles.orgId, input.orgId))
    .limit(1);
  const settings: WorkflowProfileSettings = {
    ...((stored?.settings ?? {}) as WorkflowProfileSettings),
    ...providedSettings(input.settings ?? {}),
  };
  assertSettingsFitCapabilities(settings, capabilities);

  if (workflowId && capabilities.length === 0) {
    // A published workflow whose graph maps to no capability would apply as a
    // template profile that gates everything off — refuse instead.
    throw new Error("That workflow resolves no capabilities. Add an agent step and republish.");
  }

  // The durable rows (grant insert, grant revokes, profile upsert) commit in
  // one transaction so a failure mid-apply cannot leave a granted workflow
  // with no profile row, or a revoked grant with the old profile still live.
  // Run cancellation and the audit trail follow the commit: they are
  // side-effects of an applied profile, and writeAudit is fire-and-forget by
  // design (src/server/audit.ts).
  const now = new Date();
  let stale: { id: string; workflowId: string }[] = [];
  await db.transaction(async (tx) => {
    if (workflowId) {
      // Grant the workflow when not already live-granted.
      const [existingGrant] = await tx
        .select({ id: agentWorkflowGrants.id })
        .from(agentWorkflowGrants)
        .where(
          and(
            eq(agentWorkflowGrants.workflowId, workflowId),
            eq(agentWorkflowGrants.orgId, input.orgId),
            isNull(agentWorkflowGrants.revokedAt),
          ),
        )
        .limit(1);
      if (!existingGrant) {
        await tx
          .insert(agentWorkflowGrants)
          .values({ workflowId, orgId: input.orgId, grantedBy: input.actor.userId });
        await writeAudit({
          actor: input.actor.email,
          actorUserId: input.actor.userId,
          orgId: input.orgId,
          action: "platform.workflow_profile.grant",
          entityType: "agent_workflow",
          entityId: workflowId,
          detail: {},
        });
      }
    }

    // The referenced workflow changed: soft-revoke the other live grants
    // (their runs are cancelled after the commit, following revokeWorkflow).
    const liveGrants = await tx
      .select({ id: agentWorkflowGrants.id, workflowId: agentWorkflowGrants.workflowId })
      .from(agentWorkflowGrants)
      .where(
        and(eq(agentWorkflowGrants.orgId, input.orgId), isNull(agentWorkflowGrants.revokedAt)),
      );
    stale = liveGrants.filter((g) => g.workflowId !== workflowId);
    if (stale.length) {
      await tx
        .update(agentWorkflowGrants)
        .set({ revokedAt: now })
        .where(
          inArray(
            agentWorkflowGrants.id,
            stale.map((g) => g.id),
          ),
        );
    }

    await tx
      .insert(orgWorkflowProfiles)
      .values({
        orgId: input.orgId,
        profile: input.profile,
        workflowId,
        resolvedCapabilities: capabilities,
        settings,
        appliedBy: input.actor.userId,
        appliedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: orgWorkflowProfiles.orgId,
        set: {
          profile: input.profile,
          workflowId,
          resolvedCapabilities: capabilities,
          settings,
          appliedBy: input.actor.userId,
          appliedAt: now,
          updatedAt: now,
        },
      });
  });

  // Committed: serve the new capability set immediately, then do the
  // side-effects whose failure cannot un-apply the profile.
  invalidateCapabilities(input.orgId);

  const { cancelWorkflowRuns } = await import("../server/agents/workflows.server");
  for (const g of stale) {
    const cancelled = await cancelWorkflowRuns(g.workflowId, input.orgId);
    await writeAudit({
      actor: input.actor.email,
      actorUserId: input.actor.userId,
      orgId: input.orgId,
      action: "platform.workflow_profile.revoke",
      entityType: "agent_workflow",
      entityId: g.workflowId,
      detail: { cancelled },
    });
  }

  await writeAudit({
    actor: input.actor.email,
    actorUserId: input.actor.userId,
    orgId: input.orgId,
    action: "platform.workflow_profile.applied",
    entityType: "organization",
    entityId: input.orgId,
    detail: {
      from: previous?.profile ?? null,
      to: input.profile,
      workflowId,
      resolvedCapabilities: capabilities,
      settings,
    },
  });

  return { ok: true, profile: input.profile, workflowId, capabilities, settings };
}
