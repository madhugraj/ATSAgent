/**
 * Training-data controls (docs/agentic-plan.md §14). An owner decides whether
 * the organisation's AI work is kept to train a future HR model, for how long,
 * and can delete what was kept; reviewers can annotate model calls. Every
 * change is audited. Org-scoped; no vendor or model names leave the server.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { trainingFeedback, trainingInferences, trainingSettings } from "@db/schema";
import { assertRole, requireOrg, requireOrgOwner } from "./auth.middleware";
import { writeAudit } from "../server/audit";

export type TrainingStatus = {
  enabled: boolean;
  consentedAt: string | null;
  retentionDays: number;
  inferences: number;
  feedback: { source: string; count: number }[];
  oldest: string | null;
};

export async function trainingStatusOf(orgId: string): Promise<TrainingStatus> {
  const [s] = await db
    .select()
    .from(trainingSettings)
    .where(eq(trainingSettings.orgId, orgId))
    .limit(1);
  const [inf] = (await db.execute(sql`
    select count(*)::int as n, min(created_at) as oldest
    from training_inferences where org_id = ${orgId}`)) as unknown as {
    n: number;
    oldest: string | null;
  }[];
  const fb = (await db.execute(sql`
    select source, count(*)::int as count from training_feedback
    where org_id = ${orgId} group by 1 order by 2 desc`)) as unknown as {
    source: string;
    count: number;
  }[];
  return {
    enabled: s?.enabled ?? false,
    consentedAt: s?.consentedAt ? s.consentedAt.toISOString() : null,
    retentionDays: s?.retentionDays ?? 730,
    inferences: inf?.n ?? 0,
    feedback: fb,
    oldest: inf?.oldest ? new Date(inf.oldest).toISOString() : null,
  };
}

export const getTrainingStatus = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => trainingStatusOf(context.orgId));

/** Switch capture on or off and set retention — owners only, audited. */
export async function setTrainingConsentCore(
  actor: { orgId: string; userId: string; memberEmail: string },
  input: { enabled: boolean; retentionDays: number },
): Promise<TrainingStatus> {
  const now = new Date();
  await db
    .insert(trainingSettings)
    .values({
      orgId: actor.orgId,
      enabled: input.enabled,
      retentionDays: input.retentionDays,
      consentedBy: input.enabled ? actor.userId : null,
      consentedAt: input.enabled ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: trainingSettings.orgId,
      set: {
        enabled: input.enabled,
        retentionDays: input.retentionDays,
        // Consent is recorded when it is given; withdrawing clears it.
        consentedBy: input.enabled
          ? sql`coalesce(${trainingSettings.consentedBy}, ${actor.userId}::uuid)`
          : null,
        consentedAt: input.enabled ? sql`coalesce(${trainingSettings.consentedAt}, now())` : null,
        updatedAt: now,
      },
    });
  const { resetCaptureCache } = await import("../server/training/capture.server");
  resetCaptureCache(actor.orgId);
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: input.enabled ? "training.consent_given" : "training.consent_withdrawn",
    entityType: "training_settings",
    entityId: actor.orgId,
    detail: { retentionDays: input.retentionDays },
  });
  return trainingStatusOf(actor.orgId);
}

export const setTrainingConsent = createServerFn({ method: "POST" })
  .middleware([requireOrgOwner])
  .inputValidator((d: unknown) =>
    z.object({ enabled: z.boolean(), retentionDays: z.number().int().min(30).max(3650) }).parse(d),
  )
  .handler(async ({ data, context }) =>
    setTrainingConsentCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data,
    ),
  );

/** Delete everything kept for training (e.g. after withdrawing consent) — owners only, audited. */
export async function deleteTrainingDataCore(actor: {
  orgId: string;
  userId: string;
  memberEmail: string;
}): Promise<{ inferences: number; feedback: number }> {
  const fb = await db
    .delete(trainingFeedback)
    .where(eq(trainingFeedback.orgId, actor.orgId))
    .returning({ id: trainingFeedback.id });
  const inf = await db
    .delete(trainingInferences)
    .where(eq(trainingInferences.orgId, actor.orgId))
    .returning({ id: trainingInferences.id });
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "training.data_deleted",
    entityType: "training_settings",
    entityId: actor.orgId,
    detail: { inferences: inf.length, feedback: fb.length },
  });
  return { inferences: inf.length, feedback: fb.length };
}

export const deleteTrainingData = createServerFn({ method: "POST" })
  .middleware([requireOrgOwner])
  .handler(async ({ context }) =>
    deleteTrainingDataCore({
      orgId: context.orgId,
      userId: context.userId,
      memberEmail: context.memberEmail,
    }),
  );

/** Delete rows older than each organisation's retention (daily sweep). */
export async function applyTrainingRetention(orgId?: string): Promise<number> {
  const settings = await db
    .select({ orgId: trainingSettings.orgId, days: trainingSettings.retentionDays })
    .from(trainingSettings)
    .where(orgId ? eq(trainingSettings.orgId, orgId) : undefined);
  let removed = 0;
  for (const s of settings) {
    const cutoff = new Date(Date.now() - s.days * 864e5);
    removed += (
      await db
        .delete(trainingFeedback)
        .where(and(eq(trainingFeedback.orgId, s.orgId), lt(trainingFeedback.createdAt, cutoff)))
        .returning({ id: trainingFeedback.id })
    ).length;
    removed += (
      await db
        .delete(trainingInferences)
        .where(and(eq(trainingInferences.orgId, s.orgId), lt(trainingInferences.createdAt, cutoff)))
        .returning({ id: trainingInferences.id })
    ).length;
  }
  return removed;
}

/**
 * A reviewer's annotation on one model call: a rating, a label, and the
 * output it should have produced — gold data for fine-tuning.
 */
export async function annotateInferenceCore(
  actor: { orgId: string; userId: string },
  input: {
    inferenceId: string;
    label: string;
    rating?: number | null | undefined;
    reason?: string | null | undefined;
    corrected?: unknown;
  },
): Promise<{ ok: true }> {
  await assertRole(
    actor.userId,
    actor.orgId,
    ["hr_head", "president_cbo"],
    "Annotating training data is for the HR head, the CBO or an owner.",
  );
  const [inf] = await db
    .select({
      id: trainingInferences.id,
      applicationId: trainingInferences.applicationId,
      candidateId: trainingInferences.candidateId,
      agentRunId: trainingInferences.agentRunId,
    })
    .from(trainingInferences)
    .where(
      and(eq(trainingInferences.id, input.inferenceId), eq(trainingInferences.orgId, actor.orgId)),
    )
    .limit(1);
  if (!inf) throw new Error("That record is not here.");
  const { captureEnabled, captureFeedback } = await import("../server/training/capture.server");
  if (!(await captureEnabled(actor.orgId)))
    throw new Error(
      "Training-data capture is off for this organisation; an owner can switch it on.",
    );
  await captureFeedback({
    orgId: actor.orgId,
    source: "annotation",
    label: input.label,
    rating: input.rating ?? null,
    reason: input.reason ?? null,
    ...(input.corrected === undefined ? {} : { corrected: input.corrected }),
    inferenceId: inf.id,
    agentRunId: inf.agentRunId,
    applicationId: inf.applicationId,
    candidateId: inf.candidateId,
    actorUserId: actor.userId,
  });
  return { ok: true };
}

export const annotateInference = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        inferenceId: z.string().uuid(),
        label: z.enum(["good", "bad", "corrected", "unsafe", "off_policy"]),
        rating: z.number().int().min(1).max(5).nullish(),
        reason: z.string().max(4000).nullish(),
        corrected: z.unknown().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) =>
    annotateInferenceCore({ orgId: context.orgId, userId: context.userId }, data),
  );
