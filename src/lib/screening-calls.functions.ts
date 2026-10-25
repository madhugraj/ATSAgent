/**
 * Phone screening calls on the candidate page (docs/voice-screening-agent.md):
 * what happened on each call, "Call now" (a person's request — the approval
 * itself) and cancelling a call that is still waiting. Never the phone number
 * (only its last 4 digits); the transcript exists only if the candidate agreed.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { applications, requisitions, screeningCalls, screeningKits } from "@db/schema";
import { db } from "../server/db";
import { assertRole, requireOrg } from "./auth.middleware";

/** Who may ask for or cancel a call (the same people who run screening). */
const CALL_ROLES = ["recruiter", "hr_head", "president_cbo"] as const;

export const listScreeningCalls = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ candidateId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const rows = await db
      .select({
        id: screeningCalls.id,
        requisitionId: screeningCalls.requisitionId,
        role: requisitions.title,
        status: screeningCalls.status,
        attempt: screeningCalls.attempt,
        reschedules: screeningCalls.reschedules,
        dueAt: screeningCalls.dueAt,
        startedAt: screeningCalls.startedAt,
        endedAt: screeningCalls.endedAt,
        durationS: screeningCalls.durationS,
        phoneLast4: screeningCalls.phoneLast4,
        endReason: screeningCalls.endReason,
        consentAt: screeningCalls.consentAt,
        answers: screeningCalls.answers,
        details: screeningCalls.details,
        transcript: screeningCalls.transcript,
        screeningRunId: screeningCalls.screeningRunId,
        kitQuestions: screeningKits.questions,
        createdAt: screeningCalls.createdAt,
      })
      .from(screeningCalls)
      .leftJoin(requisitions, eq(requisitions.id, screeningCalls.requisitionId))
      .leftJoin(screeningKits, eq(screeningKits.id, screeningCalls.kitId))
      .where(
        and(
          eq(screeningCalls.orgId, context.orgId),
          eq(screeningCalls.candidateId, data.candidateId),
        ),
      )
      .orderBy(desc(screeningCalls.createdAt))
      .limit(20);
    // The candidate states their pay on the call: the transcript is for the
    // people who may see pay (TA, the HR head, the CBO, owners) only.
    let seesPay = true;
    try {
      await assertRole(context.userId, context.orgId, [...CALL_ROLES], "");
    } catch {
      seesPay = false;
    }
    return rows.map(({ kitQuestions, transcript, ...r }) => {
      const questions = Array.isArray(kitQuestions)
        ? (kitQuestions as { id?: string; question?: string }[])
        : [];
      return {
        ...r,
        transcript: seesPay ? transcript : [],
        transcriptHidden: !seesPay && transcript.length > 0,
        answers: r.answers.map((a) => ({
          ...a,
          question: questions.find((q) => q.id === a.question_id)?.question ?? a.question_id,
        })),
      };
    });
  });

/** Ask for a call now — the person asking is the approval. Audited. */
export const callCandidateNow = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ candidateId: z.string().uuid(), requisitionId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      [...CALL_ROLES],
      "Only TA, the HR head or the CBO can arrange a screening call.",
    );
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.orgId, context.orgId),
          eq(applications.candidateId, data.candidateId),
          eq(applications.requisitionId, data.requisitionId),
        ),
      )
      .limit(1);
    if (!app) throw new Error("This candidate is not in the pipeline for that role.");
    const { requestScreeningCall } = await import("../server/voice/request.server");
    const r = await requestScreeningCall({
      orgId: context.orgId,
      applicationId: app.id,
      requestedBy: context.userId,
      requestedRunId: null,
      actor: context.memberEmail,
    });
    return { callId: r.callId, dueAt: r.dueAt.toISOString() };
  });

/** Cancel a call that has not happened yet. Audited. */
export const cancelScreeningCall = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ callId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      [...CALL_ROLES],
      "Only TA, the HR head or the CBO can cancel a screening call.",
    );
    const rows = await db
      .update(screeningCalls)
      .set({ status: "cancelled", dueAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(screeningCalls.id, data.callId),
          eq(screeningCalls.orgId, context.orgId),
          inArray(screeningCalls.status, [
            "requested",
            "approved",
            "callback",
            "no_answer",
            "failed",
          ]),
        ),
      )
      .returning({ id: screeningCalls.id });
    if (!rows.length) throw new Error("That call is already happening or over.");
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "screening_call.cancelled",
      entityType: "screening_call",
      entityId: data.callId,
    });
    return { ok: true };
  });

/** When the candidate asked not to be called by the AI assistant (null: never). */
export const getAiCallOptOut = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ candidateId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { candidates } = await import("@db/schema");
    const [c] = await db
      .select({ at: candidates.aiCallOptOutAt })
      .from(candidates)
      .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, context.orgId)))
      .limit(1);
    return { optedOutAt: c?.at?.toISOString() ?? null };
  });

/**
 * Record what the candidate told the team: don't call me with the AI assistant
 * (waiting calls are cancelled), or they asked to be called again. Audited.
 */
export const setAiCallOptOut = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ candidateId: z.string().uuid(), optOut: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      [...CALL_ROLES],
      "Only TA, the HR head or the CBO can change this.",
    );
    const optOut = await import("../server/voice/opt-out.server");
    if (data.optOut)
      await optOut.recordAiCallOptOut({
        orgId: context.orgId,
        candidateId: data.candidateId,
        source: "team",
        actor: context.memberEmail,
        actorUserId: context.userId,
      });
    else
      await optOut.clearAiCallOptOut({
        orgId: context.orgId,
        candidateId: data.candidateId,
        actor: context.memberEmail,
        actorUserId: context.userId,
      });
    return { ok: true };
  });
