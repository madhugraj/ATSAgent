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
  orgMembers,
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

/**
 * What a completed round does to the candidate under the role's plan (null =
 * nothing moves; the hiring manager decides). A select before the final round
 * opens the next one; after the final round the hiring decision always comes
 * from the hiring manager under "recommend". Under "immediate" the round's
 * verdict moves the candidate as it used to.
 */
export function progressionFor(
  level: number,
  verdict: "select" | "hold" | "reject",
  final: number,
  policy: "recommend" | "immediate",
): Stage | null {
  if (verdict === "select")
    return level < final
      ? (`l${level + 1}` as Stage)
      : policy === "immediate"
        ? "offer_pending"
        : null;
  if (policy === "recommend") return null;
  return verdict === "reject" ? "rejected" : "on_hold";
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
  /** This round's name and competencies from the role's interview plan. */
  round_name: string | null;
  competencies: string[];
  /** Everyone on the panel (names or emails). */
  panel: string[];
  /** Panel members who have not scored yet (when I have). */
  waiting_for: string[];
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
        panel: interviews.panel,
      })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, context.orgId),
          or(
            sql`lower(${interviews.interviewerEmail}) = ${email}`,
            sql`lower(${interviews.interviewer}) = ${email}`,
            sql`${interviews.panel} @> ${JSON.stringify([{ email }])}::jsonb`,
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
        .select({
          interviewId: evaluations.interviewId,
          by: sql<string>`lower(coalesce(${evaluations.evaluatorEmail}, ${evaluations.evaluator}, ''))`,
        })
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

    const { planFor } = await import("./interview-plan.server");
    const { roundOf } = await import("./interview-plan");
    const plans = new Map<string, Awaited<ReturnType<typeof planFor>>["plan"]>();
    for (const id of reqIds) plans.set(id, (await planFor(context.orgId, id)).plan);
    const scoredBy = (interviewId: string) =>
      evals.filter((e) => e.interviewId === interviewId).map((e) => e.by);

    return mine.map((r) => {
      const app = apps.find((a) => a.id === r.applicationId);
      const round = app ? roundOf(plans.get(app.requisitionId)!, r.level) : null;
      const members = [
        ...(r.interviewerEmail ? [{ name: r.interviewer, email: r.interviewerEmail }] : []),
        ...(r.panel ?? []),
      ];
      const by = scoredBy(r.id);
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
        submitted: by.includes(email),
        round_name: round?.name ?? null,
        competencies: round?.competencies ?? [],
        panel: members.map((m) => m.name ?? m.email),
        waiting_for: members
          .filter((m) => !by.includes(m.email.toLowerCase()))
          .map((m) => m.name ?? m.email),
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
  /** Every interviewer on the round has scored it. */
  roundComplete: boolean;
  /** Interviewers still to score the round. */
  waitingFor: string[];
  /** Why nothing moved: the hiring manager decides. */
  decisionPending?: string;
};

/**
 * Single sanctioned way to submit interview feedback: one immutable scorecard
 * per interviewer per round. A round completes when every interviewer on its
 * panel has submitted; only then does the candidate move — under the role's
 * plan (see progressionFor): a select before the final round opens the next
 * round; holds, rejects and the final decision go to the hiring manager unless
 * the plan says "immediate". The Evaluation agent hears about each completed
 * round.
 */
export async function submitScorecardCore(
  ctx: { orgId: string; userId: string; email: string; actor: string; isOwner?: boolean },
  data: z.infer<typeof ScorecardInput>,
): Promise<ScorecardResult> {
  const actor = ctx.actor;
  const me = ctx.email.trim().toLowerCase();
  const now = new Date();

  const [app] = await db
    .select({
      id: applications.id,
      stage: applications.stage,
      requisitionId: applications.requisitionId,
    })
    .from(applications)
    .where(and(eq(applications.orgId, ctx.orgId), eq(applications.id, data.applicationId)))
    .limit(1);
  if (!app) throw new Error("Application not found");

  let round: {
    id: string;
    interviewerEmail: string | null;
    panel: { email: string }[];
    level: number;
  } | null = null;
  if (data.interviewId) {
    const [r] = await db
      .select({
        id: interviews.id,
        interviewerEmail: interviews.interviewerEmail,
        panel: interviews.panel,
        level: interviews.level,
        status: interviews.status,
        applicationId: interviews.applicationId,
      })
      .from(interviews)
      .where(and(eq(interviews.orgId, ctx.orgId), eq(interviews.id, data.interviewId)))
      .limit(1);
    if (!r || r.applicationId !== app.id) throw new Error("Interview round not found.");
    if (["cancelled", "no_show"].includes(r.status))
      throw new Error("This round did not take place, so it cannot be scored.");
    const { emailsOf } = await import("./interview-plan.server");
    const panel = emailsOf(r);
    if (panel.length && !panel.includes(me)) {
      await assertRole(
        ctx.userId,
        ctx.orgId,
        ["hr_head", "president_cbo"],
        "Only the interviewers on this round can score it.",
      );
    }
    const [existing] = await db
      .select({ id: evaluations.id })
      .from(evaluations)
      .where(
        and(
          eq(evaluations.orgId, ctx.orgId),
          eq(evaluations.interviewId, data.interviewId),
          sql`lower(coalesce(${evaluations.evaluatorEmail}, ${evaluations.evaluator})) = ${me}`,
        ),
      )
      .limit(1);
    if (existing) throw new Error("You have already scored this round — scorecards are final.");
    round = r;
  }
  if (data.verdict !== "select" && !data.reason?.trim() && !data.comments?.trim()) {
    throw new Error("A hold or reject needs a written reason.");
  }

  const [evaluation] = await db
    .insert(evaluations)
    .values({
      applicationId: data.applicationId,
      orgId: ctx.orgId,
      interviewId: data.interviewId ?? null,
      level: data.level,
      evaluator: actor,
      evaluatorEmail: me,
      focusArea: data.focusArea?.trim() || null,
      rating: data.rating,
      recommendation: data.verdict,
      comments: [data.comments?.trim(), data.reason?.trim()].filter(Boolean).join("\n\n") || null,
      competencies: data.competencies,
      submittedBy: actor,
      submittedAt: now,
    })
    .returning({ id: evaluations.id });
  if (!evaluation) throw new Error("The scorecard could not be saved.");

  // Is the round complete (every interviewer on it scored)?
  const { progressOf } = await import("./interview-plan.server");
  const progress = await progressOf(ctx.orgId, app.id);
  const thisRound = round
    ? progress.rounds.find((r) => r.interviewId === round!.id)
    : progress.rounds.find((r) => r.level === data.level && r.complete);
  const complete = Boolean(thisRound?.complete);
  if (round && complete) {
    await db
      .update(interviews)
      .set({ status: "completed", completedAt: now })
      .where(and(eq(interviews.orgId, ctx.orgId), eq(interviews.id, round.id)));
  }
  if (!complete) {
    await db
      .update(applications)
      .set({ lastActivityAt: now })
      .where(and(eq(applications.orgId, ctx.orgId), eq(applications.id, app.id)));
    return {
      ok: true,
      evaluationId: evaluation.id,
      movedTo: null,
      blocked: null,
      nextInterviewCreated: false,
      roundComplete: false,
      waitingFor: thisRound?.missing ?? [],
    };
  }

  const verdict = thisRound!.verdict ?? data.verdict;
  // Tell the orchestrator: a switched-on Evaluation agent debriefs the round.
  {
    const { emitAgentEvent } = await import("../server/agents/events");
    await emitAgentEvent({
      orgId: ctx.orgId,
      type: "scorecard.submitted",
      subjectType: "requisition",
      subjectId: app.requisitionId,
      actorUserId: ctx.userId,
      payload: {
        applicationId: data.applicationId,
        level: data.level,
        verdict,
        roundComplete: true,
        finalRound: data.level >= progress.finalLevel,
        // "immediate": the round's verdict moves the candidate itself.
        policy: progress.plan.verdictPolicy,
      },
    });
  }

  /* Progression under the plan, audited exactly like a manual stage move. */
  const from = app.stage as Stage;
  const target = progressionFor(
    data.level,
    verdict,
    progress.finalLevel,
    progress.plan.verdictPolicy,
  );
  let movedTo: Stage | null = null;
  let blocked: string | null = null;
  const reason = data.reason?.trim() || `L${data.level} verdict: ${verdict}`;
  if (target && HR_CONTROLLED_TARGETS.has(target)) {
    await assertRole(
      ctx.userId,
      ctx.orgId,
      ["hr_head", "president_cbo"],
      "Only the HR head or an owner can move a candidate into the offer pipeline.",
    );
  }
  if (target && from !== target && canMove(from, target)) {
    await db
      .update(applications)
      .set({
        stage: target,
        stageReason: reason,
        stageNote: data.comments?.trim() || null,
        lastActivityAt: now,
      })
      .where(and(eq(applications.orgId, ctx.orgId), eq(applications.id, app.id)));
    const { recordStageTransition } = await import("./stage-events.server");
    await recordStageTransition({
      orgId: ctx.orgId,
      applicationId: app.id,
      fromStage: from,
      toStage: target,
      actor,
      reason,
      note: data.comments?.trim() || null,
    });
    movedTo = target;
  } else if (target && from !== target) {
    blocked = `${STAGE_LABEL[from]} → ${STAGE_LABEL[target]} is not an allowed transition — move the candidate manually.`;
  }
  await db
    .update(applications)
    .set({ lastActivityAt: now })
    .where(and(eq(applications.orgId, ctx.orgId), eq(applications.id, app.id)));

  /* A select before the final round queues the next round so nothing stalls. */
  let nextInterviewCreated = false;
  if (verdict === "select" && data.level < progress.finalLevel) {
    const nextLevel = data.level + 1;
    const [already] = await db
      .select({ id: interviews.id })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, ctx.orgId),
          eq(interviews.applicationId, app.id),
          eq(interviews.level, nextLevel),
          sql`${interviews.status} not in ('cancelled','no_show')`,
        ),
      )
      .limit(1);
    if (!already) {
      await db.insert(interviews).values({
        applicationId: app.id,
        orgId: ctx.orgId,
        level: nextLevel,
        status: "pending_scheduling",
        scheduledAt: null,
      });
      nextInterviewCreated = true;
    }
  }

  return {
    ok: true,
    evaluationId: evaluation.id,
    movedTo,
    blocked,
    nextInterviewCreated,
    roundComplete: true,
    waitingFor: [],
    ...(target === null
      ? {
          decisionPending:
            verdict === "select"
              ? "Final round complete — the hiring manager makes the hiring decision."
              : `Round verdict ${verdict}: the hiring manager decides; the candidate stays where they are.`,
        }
      : {}),
  };
}

export const submitScorecard = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => ScorecardInput.parse(data))
  .handler(async ({ data, context }): Promise<ScorecardResult> =>
    submitScorecardCore(
      {
        orgId: context.orgId,
        userId: context.userId,
        email: actorOf(context),
        actor: actorOf(context),
      },
      data,
    ),
  );

/* ------------------------------------------------------- round outcomes */

const OutcomeInput = z.object({
  interviewId: z.string().uuid(),
  outcome: z.enum(["candidate_no_show", "interviewer_unavailable", "cancelled"]),
  note: z.string().trim().max(500).default(""),
});

/**
 * A round that did not happen: the candidate did not show, the interviewer
 * could not make it, or it was cancelled. Recorded on the round (audited);
 * nothing moves the candidate. The hiring desk thread is told, and the
 * Interview coordinator offers new times (event interview.missed).
 */
export async function markInterviewOutcomeCore(
  ctx: { orgId: string; userId: string; email: string },
  data: z.infer<typeof OutcomeInput>,
): Promise<{ ok: true }> {
  const [r] = await db
    .select({
      id: interviews.id,
      status: interviews.status,
      level: interviews.level,
      applicationId: interviews.applicationId,
      interviewerEmail: interviews.interviewerEmail,
      panel: interviews.panel,
      requisitionId: applications.requisitionId,
      candidateName: candidates.fullName,
    })
    .from(interviews)
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(interviews.orgId, ctx.orgId), eq(interviews.id, data.interviewId)))
    .limit(1);
  if (!r) throw new Error("Interview round not found.");
  if (!["scheduled", "rescheduled"].includes(r.status))
    throw new Error(
      `This round is ${r.status.replace("_", " ")}; only a booked round can be marked.`,
    );
  const { emailsOf } = await import("./interview-plan.server");
  if (!emailsOf(r).includes(ctx.email.toLowerCase()))
    await assertRole(
      ctx.userId,
      ctx.orgId,
      ["recruiter", "hiring_manager", "hr_head", "president_cbo"],
      "Only an interviewer on this round or the hiring team can mark it.",
    );
  const status = data.outcome === "candidate_no_show" ? "no_show" : "cancelled";
  const label =
    data.outcome === "candidate_no_show"
      ? "the candidate did not join"
      : data.outcome === "interviewer_unavailable"
        ? "the interviewer could not make it"
        : "it was cancelled";
  await db
    .update(interviews)
    .set({ status, outcomeNote: [label, data.note].filter(Boolean).join(" — ") })
    .where(and(eq(interviews.orgId, ctx.orgId), eq(interviews.id, r.id)));
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: ctx.email,
    actorUserId: ctx.userId,
    orgId: ctx.orgId,
    action: `interview.${status}`,
    entityType: "interview",
    entityId: r.id,
    detail: { outcome: data.outcome, note: data.note || null, level: r.level },
  });
  const { emitAgentEvent } = await import("../server/agents/events");
  await emitAgentEvent({
    orgId: ctx.orgId,
    type: "interview.missed",
    subjectType: "application",
    subjectId: r.applicationId,
    actorUserId: ctx.userId,
    payload: { requisitionId: r.requisitionId, level: r.level, outcome: data.outcome },
  });
  try {
    const desk = await import("../server/desk/desk.server");
    const conv = await desk.conversationForRequisition(ctx.orgId, r.requisitionId);
    if (conv)
      await desk.postMessage(conv, {
        role: "desk",
        body: `${r.candidateName}'s L${r.level} interview did not happen: ${label}${data.note ? ` ("${data.note}")` : ""}. Nothing about the candidate changed; the Interview coordinator offers new times when it is on.`,
      });
  } catch {
    /* the thread is a courtesy; the audit trail has the record */
  }
  return { ok: true };
}

export const markInterviewOutcome = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => OutcomeInput.parse(data))
  .handler(async ({ data, context }) =>
    markInterviewOutcomeCore(
      { orgId: context.orgId, userId: context.userId, email: actorOf(context) },
      data,
    ),
  );

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
  /** Further interviewers on the panel (active members), besides `interviewerEmail`. */
  panel: z
    .array(z.object({ name: z.string().optional().nullable(), email: z.string().email() }))
    .max(2)
    .default([]),
});

/** Create or re-schedule a round and park the application on that interview stage. */
/**
 * Create or re-schedule a round, park the application on that interview stage
 * and queue the candidate's invite. Shared by the Interviews page and the
 * Interview coordinator agent (`actor` is the label written to stage events).
 */
export type ScheduleData = Omit<z.infer<typeof ScheduleInput>, "panel"> & {
  panel?: { name?: string | null | undefined; email: string }[];
};

export async function scheduleInterviewCore(
  ctx: { orgId: string; actor: string },
  data: ScheduleData,
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
    panel: await panelOf(ctx.orgId, data.interviewerEmail ?? null, data.panel ?? []),
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

  /* Every interviewer's own invite and brief — best-effort too. */
  if (interviewId) {
    const members = [
      ...(row.interviewerEmail ? [{ name: row.interviewer, email: row.interviewerEmail }] : []),
      ...row.panel,
    ];
    for (const m of members) {
      try {
        const { sendInterviewerBrief } = await import("./interviewer-brief.server");
        await sendInterviewerBrief(ctx.orgId, {
          interviewId,
          applicationId: app.id,
          candidateId: app.candidateId,
          level: data.level,
          interviewerName: m.name,
          interviewerEmail: m.email,
          scheduledAt,
          durationMins: data.durationMins,
          mode: data.mode,
          meetingLink: row.teamsLink,
          agenda: row.agenda,
          panelNames: members.map((x) => x.name ?? x.email),
        });
      } catch {
        /* the round stands even if a brief cannot be queued */
      }
    }
  }

  return { ok: true as const, rescheduled, candidateEmail, interviewId };
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

/** Validate further panel members: active members of the organisation, no repeats. */
async function panelOf(
  orgId: string,
  primary: string | null,
  panel: { name?: string | null | undefined; email: string }[],
): Promise<{ name: string | null; email: string }[]> {
  const wanted = panel
    .map((p) => p.email.trim().toLowerCase())
    .filter((e, i, all) => e && e !== (primary ?? "").toLowerCase() && all.indexOf(e) === i);
  if (!wanted.length) return [];
  const rows = await db
    .select({ name: orgMembers.fullName, email: orgMembers.email })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, "active"),
        inArray(sql`lower(${orgMembers.email})`, wanted),
      ),
    );
  const found = rows.map((r) => ({ name: r.name ?? null, email: r.email.toLowerCase() }));
  const unknown = wanted.filter((e) => !found.some((f) => f.email === e));
  if (unknown.length)
    throw new Error(
      `Panel members must be active members of the organisation: ${unknown.join(", ")}.`,
    );
  return found;
}
