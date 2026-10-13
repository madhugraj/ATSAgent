/**
 * What a person does from an agent pop-up: snooze or dismiss it, or act on it
 * (assessments: give more time, remind, screen by phone, decide without it,
 * and the decision after a completed assessment). Every action is org-scoped,
 * role-checked and audited by the core it calls.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidateAssessments, notificationStates } from "@db/schema";
import { assertRole, requireIdentity, requireOrg } from "./auth.middleware";

/** Snooze (hide for a while) or dismiss a pop-up; the notification itself stays live. */
export async function setNotificationStateCore(
  userId: string,
  data: { id: string; state: "seen" | "snooze" | "dismiss"; hours: number },
): Promise<{ ok: true }> {
  const now = new Date();
  const patch =
    data.state === "seen"
      ? { seenAt: now }
      : data.state === "snooze"
        ? { seenAt: now, snoozedUntil: new Date(now.getTime() + data.hours * 3600_000) }
        : { seenAt: now, dismissedAt: now };
  await db
    .insert(notificationStates)
    .values({ userId, notificationId: data.id, ...patch, updatedAt: now })
    .onConflictDoUpdate({
      target: [notificationStates.userId, notificationStates.notificationId],
      set: { ...patch, updatedAt: now },
    });
  return { ok: true };
}

export const setNotificationState = createServerFn({ method: "POST" })
  .middleware([requireIdentity])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().min(3).max(200),
        state: z.enum(["seen", "snooze", "dismiss"]),
        hours: z.number().int().min(1).max(72).default(4),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => setNotificationStateCore(context.userId, data));

const DECIDERS = ["recruiter", "hr_head", "president_cbo"] as const;

/** Act on an open assessment from the pop-up. */
export const assessmentAction = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .discriminatedUnion("action", [
        z.object({
          action: z.literal("extend"),
          assessmentId: z.string().uuid(),
          dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          notify: z.boolean().default(true),
        }),
        z.object({ action: z.literal("remind"), assessmentId: z.string().uuid() }),
        z.object({
          action: z.enum(["phone_screen", "decide_without"]),
          assessmentId: z.string().uuid(),
          reason: z.string().min(3).max(500),
        }),
      ])
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      [...DECIDERS],
      "Only TA or HR can change a candidate's assessment.",
    );
    const actor = {
      orgId: context.orgId,
      userId: context.userId,
      memberEmail: context.memberEmail,
    };
    const tl = await import("./assessment-timeline.server");
    if (data.action === "extend") return tl.extendAssessment(actor, data);
    if (data.action === "remind")
      return tl.sendAssessmentReminder(context.orgId, data.assessmentId, {
        userId: context.userId,
        memberEmail: context.memberEmail,
      });
    return tl.waiveAssessment(actor, {
      assessmentId: data.assessmentId,
      mode: data.action,
      reason: data.reason,
    });
  });

/** The decision after a completed (or waived) assessment: interview, hold, or not taken further. */
export async function decideAfterAssessmentCore(
  actor: { orgId: string; userId: string; memberEmail: string },
  data: { applicationId: string; decision: "move_l1" | "hold" | "reject"; note: string },
): Promise<{ ok: true }> {
  await assertRole(
    actor.userId,
    actor.orgId,
    [...DECIDERS],
    "Only TA or HR can decide who moves on.",
  );
  const note = data.note.replace(/\s+/g, " ").trim();
  if (data.decision !== "move_l1" && note.length < 3)
    throw new Error("Say why — it goes on the candidate's record.");
  const [app] = await db
    .select({ id: applications.id, stage: applications.stage })
    .from(applications)
    .where(and(eq(applications.id, data.applicationId), eq(applications.orgId, actor.orgId)))
    .limit(1);
  if (!app) throw new Error("Application not found.");
  if (app.stage !== "shortlisted")
    throw new Error(`This candidate has already moved on (${app.stage.replace(/_/g, " ")}).`);
  // The assessment behind the decision, for the record.
  const [a] = await db
    .select({ score: candidateAssessments.mindsetScore, status: candidateAssessments.status })
    .from(candidateAssessments)
    .where(
      and(
        eq(candidateAssessments.orgId, actor.orgId),
        eq(candidateAssessments.applicationId, app.id),
      ),
    )
    .orderBy(sql`${candidateAssessments.createdAt} desc`)
    .limit(1);
  const basis =
    a?.status === "completed"
      ? `Written assessment ${a.score != null ? `${a.score}/100` : "completed"}`
      : "Decided without the written assessment";
  const { moveStageCore } = await import("./pipeline.server");
  await moveStageCore(actor, {
    applicationId: app.id,
    toStage: data.decision === "move_l1" ? "l1" : data.decision === "hold" ? "on_hold" : "rejected",
    reason: note ? `${basis}. ${note}` : basis,
  });
  return { ok: true };
}

export const decideAfterAssessment = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        applicationId: z.string().uuid(),
        decision: z.enum(["move_l1", "hold", "reject"]),
        note: z.string().max(1000).default(""),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) =>
    decideAfterAssessmentCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data,
    ),
  );

/* ------------------------------------------------------------ policy */

export const getAssessmentPolicy = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    const { assessmentPolicyOf } = await import("./assessment-timeline.server");
    return assessmentPolicyOf(context.orgId);
  });

/** Change the organisation's assessment timeline — HR head or owner, audited. */
export const setAssessmentPolicy = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        dueWorkingDays: z.number().int().min(1).max(15),
        firstReminderDays: z.number().int().min(1).max(14),
        maxReminders: z.number().int().min(0).max(3),
        overdueAfterDays: z.number().int().min(0).max(14),
        closeAfterDays: z.number().int().min(2).max(30),
      })
      .refine((p) => p.firstReminderDays < p.closeAfterDays, {
        message: "The first reminder must come before the link closes.",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head", "president_cbo"],
      "Only the HR head, the CBO or an owner can change the assessment timeline.",
    );
    const { assessmentSettings } = await import("@db/schema");
    const now = new Date();
    await db
      .insert(assessmentSettings)
      .values({ orgId: context.orgId, ...data, updatedBy: context.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: assessmentSettings.orgId,
        set: { ...data, updatedBy: context.userId, updatedAt: now },
      });
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "assessment.policy_changed",
      entityType: "assessment_settings",
      entityId: context.orgId,
      detail: data,
    });
    return data;
  });
