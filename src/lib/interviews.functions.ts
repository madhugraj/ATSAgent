import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import {
  aiInterviews,
  applications,
  candidates,
  evaluations,
  interviews,
  organizations,
  requisitions,
} from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import { canMove, REASON_REQUIRED, STAGE_LABEL, type Stage } from "./lifecycle";
import { buildIcs } from "./ics";

/* --------------------------------------------------------------- helpers */

function actorOf(context: { claims?: unknown; userId: string }) {
  const email = (context.claims as Record<string, unknown> | undefined)?.["email"];
  return typeof email === "string" ? email : context.userId;
}

/** Where a verdict at a given level should push the application next. */
export function nextStageFor(level: number, verdict: "select" | "hold" | "reject"): Stage {
  if (verdict === "reject") return "rejected";
  if (verdict === "hold") return "on_hold";
  return level >= 3 ? "offer_pending" : (`l${level + 1}` as Stage);
}

const HR_CONTROLLED_TARGETS = new Set<Stage>([
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "offer",
  "hired",
  "joined",
]);

/* ---------------------------------------------------- interviewer queue */

export type MyInterview = {
  id: string;
  application_id: string;
  candidate_id: string;
  candidate_name: string;
  requisition_title: string;
  level: number;
  scheduled_at: string | null;
  duration_mins: number;
  mode: string;
  agenda: string | null;
  teams_link: string | null;
  status: string;
  stage: Stage;
  submitted: boolean;
};

/** Every interview assigned to the signed-in user, newest first. */
export const myInterviews = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<MyInterview[]> => {
    const email = actorOf(context).toLowerCase();

    const mine = await db
      .select({
        id: interviews.id,
        applicationId: interviews.applicationId,
        level: interviews.level,
        scheduledAt: interviews.scheduledAt,
        durationMins: interviews.durationMins,
        mode: interviews.mode,
        agenda: interviews.agenda,
        teamsLink: interviews.teamsLink,
        status: interviews.status,
        interviewer: interviews.interviewer,
        interviewerEmail: interviews.interviewerEmail,
      })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, context.orgId),
          or(
            sql`lower(${interviews.interviewerEmail}) = ${email}`,
            sql`lower(${interviews.interviewer}) = ${email}`,
          ),
        ),
      )
      .orderBy(asc(interviews.scheduledAt));
    if (!mine.length) return [];

    const appIds = [...new Set(mine.map((r) => r.applicationId))];
    const [apps, evals] = await Promise.all([
      db
        .select({
          id: applications.id,
          stage: applications.stage,
          candidateId: applications.candidateId,
          requisitionId: applications.requisitionId,
        })
        .from(applications)
        .where(and(eq(applications.orgId, context.orgId), inArray(applications.id, appIds))),
      db
        .select({ interviewId: evaluations.interviewId })
        .from(evaluations)
        .where(
          and(eq(evaluations.orgId, context.orgId), inArray(evaluations.applicationId, appIds)),
        ),
    ]);

    const candIds = [...new Set(apps.map((a) => a.candidateId))];
    const reqIds = [...new Set(apps.map((a) => a.requisitionId))];
    const [cands, reqs] = await Promise.all([
      db
        .select({ id: candidates.id, fullName: candidates.fullName })
        .from(candidates)
        .where(and(eq(candidates.orgId, context.orgId), inArray(candidates.id, candIds))),
      db
        .select({ id: requisitions.id, title: requisitions.title })
        .from(requisitions)
        .where(and(eq(requisitions.orgId, context.orgId), inArray(requisitions.id, reqIds))),
    ]);

    const submitted = new Set(evals.map((e) => e.interviewId).filter(Boolean) as string[]);

    return mine.map((r) => {
      const app = apps.find((a) => a.id === r.applicationId);
      return {
        id: r.id,
        application_id: r.applicationId,
        candidate_id: app?.candidateId ?? "",
        candidate_name: cands.find((c) => c.id === app?.candidateId)?.fullName ?? "Candidate",
        requisition_title: reqs.find((q) => q.id === app?.requisitionId)?.title ?? "Requisition",
        level: r.level,
        scheduled_at: r.scheduledAt ? r.scheduledAt.toISOString() : null,
        duration_mins: r.durationMins,
        mode: r.mode,
        agenda: r.agenda,
        teams_link: r.teamsLink,
        status: r.status,
        stage: (app?.stage ?? "shortlisted") as Stage,
        submitted: submitted.has(r.id),
      };
    });
  });

/* ------------------------------------------------------ scorecard submit */

const ScorecardInput = z.object({
  interviewId: z.string().uuid().optional().nullable(),
  applicationId: z.string().uuid(),
  level: z.number().min(1).max(3),
  focusArea: z.string().optional().nullable(),
  rating: z.number().min(1).max(5),
  verdict: z.enum(["select", "hold", "reject"]),
  comments: z.string().optional().nullable(),
  reason: z.string().optional().nullable(),
  competencies: z
    .array(z.object({ name: z.string().min(1), rating: z.number().min(1).max(5) }))
    .max(12)
    .default([]),
});

export type ScorecardResult = {
  ok: true;
  evaluationId: string;
  movedTo: Stage | null;
  blocked: string | null;
  nextInterviewCreated: boolean;
};

/**
 * Single sanctioned way to submit interview feedback: writes an immutable
 * scorecard, locks the round, then auto-progresses the application (select →
 * next level or offer, hold → on hold, reject → rejected) with a stage_event.
 */
export const submitScorecard = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => ScorecardInput.parse(data))
  .handler(async ({ data, context }): Promise<ScorecardResult> => {
    const actor = actorOf(context);
    const now = new Date();

    if (data.interviewId) {
      const [existing] = await db
        .select({ id: evaluations.id })
        .from(evaluations)
        .where(
          and(eq(evaluations.orgId, context.orgId), eq(evaluations.interviewId, data.interviewId)),
        )
        .limit(1);
      if (existing)
        throw new Error("This interview round has already been scored — scorecards are final.");
    }

    const [app] = await db
      .select({ id: applications.id, stage: applications.stage })
      .from(applications)
      .where(and(eq(applications.orgId, context.orgId), eq(applications.id, data.applicationId)))
      .limit(1);
    if (!app) throw new Error("Application not found");

    const target = nextStageFor(data.level, data.verdict);
    if (REASON_REQUIRED.includes(target) && !data.reason?.trim() && !data.comments?.trim()) {
      throw new Error(`A reason is required to move the candidate to ${STAGE_LABEL[target]}.`);
    }
    if (HR_CONTROLLED_TARGETS.has(target)) {
      await assertRole(
        context.userId,
        context.orgId,
        ["hr_head", "president_cbo"],
        "Only the HR head or an owner can move a candidate into the offer pipeline.",
      );
    }

    const [evaluation] = await db
      .insert(evaluations)
      .values({
        applicationId: data.applicationId,
        orgId: context.orgId,
        interviewId: data.interviewId ?? null,
        level: data.level,
        evaluator: actor,
        focusArea: data.focusArea?.trim() || null,
        rating: data.rating,
        recommendation: data.verdict,
        comments: data.comments?.trim() || null,
        competencies: data.competencies,
        submittedBy: actor,
        submittedAt: now,
      })
      .returning({ id: evaluations.id });
    if (!evaluation) throw new Error("The scorecard could not be saved.");
    {
      // Tell the orchestrator: a switched-on Evaluation agent debriefs the round.
      const [req] = await db
        .select({ requisitionId: applications.requisitionId })
        .from(applications)
        .where(eq(applications.id, data.applicationId))
        .limit(1);
      if (req) {
        const { emitAgentEvent } = await import("../server/agents/events");
        await emitAgentEvent({
          orgId: context.orgId,
          type: "scorecard.submitted",
          subjectType: "requisition",
          subjectId: req.requisitionId,
          actorUserId: context.userId,
          payload: { applicationId: data.applicationId, level: data.level, verdict: data.verdict },
        });
      }
    }

    if (data.interviewId) {
      await db
        .update(interviews)
        .set({ status: "completed", completedAt: now })
        .where(and(eq(interviews.orgId, context.orgId), eq(interviews.id, data.interviewId)));
    }

    /* Auto-progression, audited exactly like a manual stage move. */
    const from = app.stage as Stage;
    let movedTo: Stage | null = null;
    let blocked: string | null = null;
    const reason = data.reason?.trim() || `L${data.level} verdict: ${data.verdict}`;

    if (from !== target && canMove(from, target)) {
      await db
        .update(applications)
        .set({
          stage: target,
          stageReason: reason,
          stageNote: data.comments?.trim() || null,
          lastActivityAt: now,
        })
        .where(and(eq(applications.orgId, context.orgId), eq(applications.id, app.id)));
      const { recordStageTransition } = await import("./stage-events.server");
      await recordStageTransition({
        orgId: context.orgId,
        applicationId: app.id,
        fromStage: from,
        toStage: target,
        actor,
        reason,
        note: data.comments?.trim() || null,
      });
      movedTo = target;
    } else if (from !== target) {
      blocked = `${STAGE_LABEL[from]} → ${STAGE_LABEL[target]} is not an allowed transition — move the candidate manually.`;
      await db
        .update(applications)
        .set({ lastActivityAt: now })
        .where(and(eq(applications.orgId, context.orgId), eq(applications.id, app.id)));
    }

    /* A select below L3 queues the next round so nothing stalls unassigned. */
    let nextInterviewCreated = false;
    if (data.verdict === "select" && data.level < 3) {
      const nextLevel = data.level + 1;
      const [already] = await db
        .select({ id: interviews.id })
        .from(interviews)
        .where(
          and(
            eq(interviews.orgId, context.orgId),
            eq(interviews.applicationId, app.id),
            eq(interviews.level, nextLevel),
          ),
        )
        .limit(1);
      if (!already) {
        await db.insert(interviews).values({
          applicationId: app.id,
          orgId: context.orgId,
          level: nextLevel,
          status: "pending_scheduling",
          scheduledAt: null,
        });
        nextInterviewCreated = true;
      }
    }

    return { ok: true, evaluationId: evaluation.id, movedTo, blocked, nextInterviewCreated };
  });

/* ------------------------------------------------------------- scheduling */

export const ScheduleInput = z.object({
  applicationId: z.string().uuid(),
  level: z.number().min(1).max(3),
  interviewer: z.string().optional().nullable(),
  interviewerEmail: z.string().email().optional().nullable(),
  scheduledAt: z.string().min(1),
  durationMins: z.number().min(15).max(240).default(60),
  mode: z.enum(["online", "onsite", "phone"]).default("online"),
  meetingLink: z.string().optional().nullable(),
  agenda: z.string().optional().nullable(),
  interviewId: z.string().uuid().optional().nullable(),
  /** Required when re-scheduling an existing round, so the change is auditable. */
  rescheduleReason: z.string().optional().nullable(),
  /** Recruiter-confirmed candidate email; written back to the candidate record. */
  candidateEmail: z.string().email().optional().nullable(),
});

/** Create or re-schedule a round and park the application on that interview stage. */
/**
 * Create or re-schedule a round, park the application on that interview stage
 * and queue the candidate's invite. Shared by the Interviews page and the
 * Interview coordinator agent (`actor` is the label written to stage events).
 */
export async function scheduleInterviewCore(
  ctx: { orgId: string; actor: string },
  data: z.infer<typeof ScheduleInput>,
) {
  const actor = ctx.actor;
  const now = new Date();
  const scheduledAt = new Date(data.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("Choose a valid interview date and time.");
  }
  const row = {
    applicationId: data.applicationId,
    level: data.level,
    interviewer: data.interviewer?.trim() || null,
    interviewerEmail: data.interviewerEmail?.trim().toLowerCase() || null,
    scheduledAt,
    durationMins: data.durationMins,
    mode: data.mode,
    teamsLink: data.meetingLink?.trim() || null,
    agenda: data.agenda?.trim() || null,
    status: "scheduled",
  };

  const { recordStageTransition } = await import("./stage-events.server");

  const [app] = await db
    .select({
      id: applications.id,
      stage: applications.stage,
      candidateId: applications.candidateId,
    })
    .from(applications)
    .where(and(eq(applications.orgId, ctx.orgId), eq(applications.id, data.applicationId)))
    .limit(1);
  if (!app) throw new Error("Application not found in your organisation.");

  /* Candidate email is the invite address: confirm it before the round exists. */
  let candidateEmail: string | null = null;
  let candidateName: string | null = null;
  {
    const [cand] = await db
      .select({ id: candidates.id, email: candidates.email, fullName: candidates.fullName })
      .from(candidates)
      .where(and(eq(candidates.orgId, ctx.orgId), eq(candidates.id, app.candidateId)))
      .limit(1);
    candidateEmail = cand?.email ?? null;
    candidateName = cand?.fullName ?? null;
    const typed = data.candidateEmail?.trim().toLowerCase() || null;
    if (typed && typed !== (candidateEmail ?? "").toLowerCase()) {
      await db
        .update(candidates)
        .set({ email: typed })
        .where(and(eq(candidates.orgId, ctx.orgId), eq(candidates.id, app.candidateId)));
      candidateEmail = typed;
    }
  }
  if (!candidateEmail) {
    throw new Error(
      "This candidate has no email on file — add one before scheduling, or the invite cannot be sent.",
    );
  }

  let rescheduled = false;
  let interviewId: string | null = data.interviewId ?? null;
  if (data.interviewId) {
    const reason = data.rescheduleReason?.trim();
    if (!reason)
      throw new Error("Give a reason for the re-schedule — it is written to the audit trail.");
    const [previous] = await db
      .select({ scheduledAt: interviews.scheduledAt })
      .from(interviews)
      .where(and(eq(interviews.orgId, ctx.orgId), eq(interviews.id, data.interviewId)))
      .limit(1);
    await db
      .update(interviews)
      .set({ ...row, status: "rescheduled" })
      .where(and(eq(interviews.orgId, ctx.orgId), eq(interviews.id, data.interviewId)));
    rescheduled = true;

    {
      const wasAt = previous?.scheduledAt ? previous.scheduledAt.toISOString() : "unscheduled";
      await recordStageTransition({
        orgId: ctx.orgId,
        applicationId: app.id,
        fromStage: app.stage as Stage,
        toStage: app.stage as Stage,
        actor,
        reason: `L${data.level} re-scheduled: ${reason}`,
        note: `${wasAt} → ${scheduledAt.toISOString()}`,
        cause: "interview_scheduled",
      });
    }
  } else {
    const [created] = await db
      .insert(interviews)
      .values({ ...row, orgId: ctx.orgId })
      .returning({ id: interviews.id });
    interviewId = created?.id ?? null;
  }

  const target = `l${data.level}` as Stage;
  if (app.stage !== target && canMove(app.stage as Stage, target)) {
    await db
      .update(applications)
      .set({ stage: target, stageReason: `L${data.level} scheduled`, lastActivityAt: now })
      .where(and(eq(applications.orgId, ctx.orgId), eq(applications.id, app.id)));
    await recordStageTransition({
      orgId: ctx.orgId,
      applicationId: app.id,
      fromStage: app.stage as Stage,
      toStage: target,
      actor,
      reason: `L${data.level} interview scheduled`,
      cause: "interview_scheduled",
    });
  } else {
    await db
      .update(applications)
      .set({ lastActivityAt: now })
      .where(and(eq(applications.orgId, ctx.orgId), eq(applications.id, app.id)));
    if (!rescheduled) {
      await recordStageTransition({
        orgId: ctx.orgId,
        applicationId: app.id,
        fromStage: app.stage as Stage,
        toStage: app.stage as Stage,
        actor,
        reason: `L${data.level} interview scheduled`,
        note: scheduledAt.toISOString(),
        cause: "interview_scheduled",
      });
    }
  }

  /* Invite email with calendar attachment — best-effort, both create and
   * reschedule. The .ics UID is the interview id so reschedules update the
   * same calendar entry. */
  try {
    const { enqueueEmail, formatInOrgTZ, getOrgEmailSettings } =
      await import("./email-outbox.server");
    const [ctxRow] = await db
      .select({ jobTitle: requisitions.title, orgName: organizations.name })
      .from(applications)
      .innerJoin(requisitions, eq(applications.requisitionId, requisitions.id))
      .innerJoin(organizations, eq(applications.orgId, organizations.id))
      .where(eq(applications.id, app.id))
      .limit(1);
    if (interviewId) {
      const roundLabel = `L${data.level} interview`;
      const whereText = data.meetingLink?.trim() || null;
      const modeLabel =
        data.mode === "online" ? "Online" : data.mode === "onsite" ? "Onsite" : "Phone";
      const ics = buildIcs({
        uid: `interview-${interviewId}@atsiq`,
        title: `${roundLabel}: ${ctxRow?.jobTitle ?? "Role"}${
          ctxRow?.orgName ? ` (${ctxRow.orgName})` : ""
        }`,
        description:
          [
            data.interviewer?.trim() ? `Interviewer: ${data.interviewer.trim()}` : null,
            data.agenda?.trim() || null,
          ]
            .filter(Boolean)
            .join("\n") || null,
        location: whereText ?? (data.mode === "onsite" ? (ctxRow?.orgName ?? null) : null),
        startsAt: scheduledAt.toISOString(),
        durationMins: data.durationMins,
        attendees: [candidateEmail],
      });
      const templateData: Record<string, string | undefined> = {
        candidateName: candidateName ?? undefined,
        orgName: ctxRow?.orgName,
        jobTitle: ctxRow?.jobTitle,
        roundLabel,
        scheduledAtText: formatInOrgTZ(
          scheduledAt,
          (await getOrgEmailSettings(ctx.orgId)).timezone,
        ),
        durationMins: String(data.durationMins),
        modeLabel,
      };
      if (whereText) templateData["whereText"] = whereText;
      if (data.interviewer?.trim()) templateData["interviewerName"] = data.interviewer.trim();
      if (data.agenda?.trim()) templateData["agenda"] = data.agenda.trim();
      await enqueueEmail({
        orgId: ctx.orgId,
        kind: "interview_invite",
        templateName: "interview_invite",
        toEmail: candidateEmail,
        applicationId: app.id,
        templateData,
        attachments: [
          {
            filename: `interview-l${data.level}.ics`,
            contentBase64: Buffer.from(ics, "utf8").toString("base64"),
            contentType: "text/calendar",
          },
        ],
        idempotencyKey: `interview-invite:${interviewId}:${scheduledAt.toISOString()}`,
      });
    }
  } catch {
    /* best-effort: scheduling must succeed even if the invite cannot be queued */
  }

  return { ok: true as const, rescheduled, candidateEmail };
}

export const scheduleInterview = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => ScheduleInput.parse(data))
  .handler(async ({ data, context }) =>
    scheduleInterviewCore({ orgId: context.orgId, actor: actorOf(context) }, data),
  );

/* ------------------------------------------------------ AI screening filing */

const AiScreenSaveInput = z.object({
  applicationId: z.string().uuid(),
  jdMatchScore: z.number().int(),
  skillsetScore: z.number().int(),
  transcript: z.array(z.object({ question: z.string(), expected_signal: z.string() })),
  summary: z.string(),
});

/**
 * File a completed AI screening interview against an org-owned application and
 * park the application on "ai_screened". The legacy client never surfaced
 * failures of that stage bump, so it stays best-effort.
 */
export const saveAiInterview = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => AiScreenSaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const [application] = await db
      .select({ id: applications.id, stage: applications.stage })
      .from(applications)
      .where(and(eq(applications.orgId, context.orgId), eq(applications.id, data.applicationId)))
      .limit(1);
    if (!application) throw new Error("Application not found");

    await db.insert(aiInterviews).values({
      applicationId: data.applicationId,
      orgId: context.orgId,
      jdMatchScore: data.jdMatchScore,
      skillsetScore: data.skillsetScore,
      transcript: data.transcript,
      summary: data.summary,
    });

    const from = application.stage as Stage;
    if (from !== "ai_screened") {
      if (!canMove(from, "ai_screened")) {
        throw new Error(
          `${STAGE_LABEL[from]} → ${STAGE_LABEL.ai_screened} is not an allowed transition.`,
        );
      }
      const now = new Date();
      await db
        .update(applications)
        .set({ stage: "ai_screened", lastActivityAt: now, stageReason: "AI screening completed" })
        .where(and(eq(applications.orgId, context.orgId), eq(applications.id, data.applicationId)));
      const { recordStageTransition } = await import("./stage-events.server");
      await recordStageTransition({
        orgId: context.orgId,
        applicationId: application.id,
        fromStage: from,
        toStage: "ai_screened",
        actor: actorOf(context),
        reason: "AI screening completed",
      });
    }
    return { ok: true as const };
  });
