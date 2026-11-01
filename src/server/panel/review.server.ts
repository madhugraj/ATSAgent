/**
 * Silent panel agents, S3 (docs/silent-panel-agent-plan.md): the panel's
 * scorecards against the agent's hidden view, once every panellist has scored,
 * and the HR head's review card.
 *
 *   agree     the panel's verdict moves the candidate, as it always has
 *   partial   the panel's verdict moves the candidate; the HR head gets a card
 *             to confirm it or stop the candidate before the next round
 *   disagree  the move is held (when the level's agent is on); the HR head
 *             goes with the panel, holds or rejects
 *
 * The comparison is a fixed rule (src/lib/panel-reconcile.ts). The card is
 * raised by the level's agent with request_panel_review — a proposal: the
 * system checks it, states the facts and carries out the HR head's decision
 * as the HR head. An assessment that lands after the panel has scored is
 * compared then; the candidate has already moved, so the card can stop them.
 */
import { and, eq, gt, inArray } from "drizzle-orm";

import {
  applications,
  candidates,
  evaluations,
  interviews,
  interviewSlotOffers,
  panelAssessments,
  requisitions,
} from "@db/schema";
import type { Verdict } from "@/lib/interview-plan";
import { OUTCOME_LABEL, panelRatingOf, reconcile, type Outcome } from "@/lib/panel-reconcile";
import { writeAudit } from "../audit";
import { db } from "../db";
import { log } from "../log";
import { loadPolicy } from "../agents/policy";

export type PanelCheck = {
  outcome: Outcome;
  panelRating: number | null;
  panelVerdict: Verdict;
  /** A disagreement while the level's agent is on: the move waits for the HR head. */
  holdable: boolean;
};

async function scorecardsOf(orgId: string, interviewId: string) {
  return db
    .select({
      evaluator: evaluations.evaluator,
      rating: evaluations.rating,
      verdict: evaluations.recommendation,
      comments: evaluations.comments,
    })
    .from(evaluations)
    .where(and(eq(evaluations.orgId, orgId), eq(evaluations.interviewId, interviewId)));
}

async function assessmentOf(orgId: string, interviewId: string) {
  const [a] = await db
    .select()
    .from(panelAssessments)
    .where(and(eq(panelAssessments.orgId, orgId), eq(panelAssessments.interviewId, interviewId)))
    .limit(1);
  return a ?? null;
}

/**
 * The comparison for a round whose panel has just finished scoring; null when
 * the agent has no view of it (nothing to compare — the round runs as before).
 */
export async function panelCheck(
  orgId: string,
  interviewId: string,
  level: number,
  roundVerdict: Verdict,
): Promise<PanelCheck | null> {
  const a = await assessmentOf(orgId, interviewId);
  if (!a?.assessedAt || a.rating == null || !a.verdict) return null;
  const panelRating = panelRatingOf((await scorecardsOf(orgId, interviewId)).map((c) => c.rating));
  const outcome = reconcile(
    { rating: panelRating, verdict: roundVerdict },
    { rating: a.rating, verdict: a.verdict },
  );
  const agentOn =
    level >= 1 && level <= 3
      ? (await loadPolicy(orgId, `panel_l${level}` as never)).enabled
      : false;
  return {
    outcome,
    panelRating,
    panelVerdict: roundVerdict,
    holdable: outcome === "disagree" && agentOn,
  };
}

/**
 * Record the comparison (audited) and, for a partial match or a disagreement,
 * ask the level's agent to raise the HR head's card (`raise`), or leave that
 * to the run that is reading the call right now.
 */
export async function recordPanelCheck(
  ctx: { orgId: string; actor: string; actorUserId: string | null },
  r: { interviewId: string; applicationId: string; requisitionId: string; level: number },
  check: PanelCheck,
  held: boolean,
  raise: boolean,
): Promise<void> {
  await db
    .update(panelAssessments)
    .set({
      outcome: check.outcome,
      panelRating: check.panelRating == null ? null : String(check.panelRating),
      panelVerdict: check.panelVerdict,
      held,
      reconciledAt: new Date(),
    })
    .where(
      and(eq(panelAssessments.orgId, ctx.orgId), eq(panelAssessments.interviewId, r.interviewId)),
    );
  await writeAudit({
    actor: ctx.actor,
    actorUserId: ctx.actorUserId,
    orgId: ctx.orgId,
    action: "panel_review.reconciled",
    entityType: "interview",
    entityId: r.interviewId,
    detail: { level: r.level, outcome: check.outcome, held },
  });
  if (check.outcome === "agree") return;
  if (raise) {
    const { emitAgentEvent } = await import("../agents/events");
    await emitAgentEvent({
      orgId: ctx.orgId,
      type: "panel.review_due",
      subjectType: "application",
      subjectId: r.applicationId,
      actorUserId: ctx.actorUserId,
      payload: {
        interviewId: r.interviewId,
        level: r.level,
        outcome: check.outcome,
        requisitionId: r.requisitionId,
      },
    });
  }
  if (held)
    try {
      const desk = await import("../desk/desk.server");
      const conv = await desk.conversationForRequisition(ctx.orgId, r.requisitionId);
      const [c] = await db
        .select({ name: candidates.fullName })
        .from(applications)
        .innerJoin(candidates, eq(candidates.id, applications.candidateId))
        .where(eq(applications.id, r.applicationId))
        .limit(1);
      if (conv)
        await desk.postMessage(conv, {
          role: "desk",
          body: `${c?.name ?? "The candidate"}'s L${r.level} panel has scored, and the L${r.level} panel agent's independent view of the call disagrees with it. The move is on hold until the HR head reviews both.`,
        });
    } catch {
      /* the thread is a courtesy; the audit trail has the record */
    }
}

/**
 * An assessment that landed after the panel had already scored: compare now.
 * The candidate has already moved, so nothing is held. Returns the outcome
 * when a review is due (the run that assessed raises the card itself).
 */
export async function reconcileAfterAssessment(
  orgId: string,
  interviewId: string,
  level: number,
  actor: string,
): Promise<Outcome | null> {
  const [r] = await db
    .select({
      status: interviews.status,
      applicationId: interviews.applicationId,
      requisitionId: applications.requisitionId,
    })
    .from(interviews)
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .where(and(eq(interviews.orgId, orgId), eq(interviews.id, interviewId)))
    .limit(1);
  if (!r || r.status !== "completed") return null;
  const cards = await scorecardsOf(orgId, interviewId);
  if (!cards.length) return null;
  const a = await assessmentOf(orgId, interviewId);
  if (a?.reconciledAt) return null;
  const { roundVerdict } = await import("@/lib/interview-plan");
  const check = await panelCheck(
    orgId,
    interviewId,
    level,
    roundVerdict(cards.map((c) => c.verdict as Verdict)),
  );
  if (!check) return null;
  await recordPanelCheck(
    { orgId, actor, actorUserId: null },
    { interviewId, applicationId: r.applicationId, requisitionId: r.requisitionId, level },
    check,
    false,
    false,
  );
  return check.outcome === "agree" ? null : check.outcome;
}

/* -------------------------------------------------- the HR head's card */

export type PanelReviewSubject = { type: "panel_review"; interviewId: string; expects?: string };

/** Why a review cannot be raised now (null: it can). */
export async function reviewPrecheck(
  orgId: string,
  interviewId: string,
  level: number,
): Promise<string | null> {
  const a = await assessmentOf(orgId, interviewId);
  if (!a || a.level !== level)
    return `There is no L${level} panel agent's view of this round to review.`;
  if (!a.outcome) return "The panel has not finished scoring this round yet.";
  if (a.outcome === "agree")
    return "The panel agent agrees with the panel; there is nothing to review.";
  if (a.reviewDecision) return "The HR head has already reviewed this round.";
  return null;
}

const VERDICT = { select: "select", hold: "hold", reject: "reject" } as const;
const clip = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : "";

/** The card: who decides (the HR head), the facts side by side, and what each choice does. */
export async function reviewGateFor(orgId: string, subject: PanelReviewSubject) {
  const a = await assessmentOf(orgId, subject.interviewId);
  if (!a?.outcome || a.outcome === "agree")
    return { error: "There is nothing to review on this round." };
  if (a.reviewDecision) return { error: "The HR head has already reviewed this round." };
  const [row] = await db
    .select({
      stage: applications.stage,
      name: candidates.fullName,
      code: requisitions.code,
      title: requisitions.title,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(applications.id, a.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!row) return { error: "Application not found." };
  const cards = await scorecardsOf(orgId, subject.interviewId);
  const next = a.level + 1;
  // A row made before the view was written (e.g. the summary went first) has empty JSON.
  const cv = {
    competencies: a.candidate.competencies ?? [],
    strengths: a.candidate.strengths ?? [],
    gaps: a.candidate.gaps ?? [],
    openQuestions: a.candidate.openQuestions ?? [],
  };
  const lines: string[] = [
    `Panel review — L${a.level} interview of ${row.name} (${row.code} ${row.title}).`,
    a.held
      ? `The L${a.level} panel agent ${OUTCOME_LABEL[a.outcome]}, so ${row.name}'s move is ON HOLD until you decide.`
      : `The L${a.level} panel agent ${OUTCOME_LABEL[a.outcome]}. ${row.name} is at ${row.stage.toUpperCase()} as the panel decided; you can stop that before the next round happens.`,
    "",
    `The panel — verdict ${a.panelVerdict ?? "?"}, average ${a.panelRating == null ? "–" : Number(a.panelRating)}/5:`,
    ...cards.map(
      (c) =>
        `• ${c.evaluator ?? "A panellist"}: ${c.rating ?? "–"}/5, ${c.verdict}${c.comments ? ` — "${clip(c.comments, 200)}"` : ""}`,
    ),
    "",
    `The L${a.level} panel agent, from the call's transcript — ${a.verdict ? VERDICT[a.verdict] : "?"}, ${a.rating ?? "–"}/5:`,
    ...cv.competencies.map(
      (c) =>
        `• ${c.name}: ${c.rating == null ? "not covered" : `${c.rating}/5`}${c.evidence[0] ? ` — "${clip(c.evidence[0], 160)}"` : ""}${c.note ? ` (${clip(c.note, 160)})` : ""}`,
    ),
    ...(cv.strengths.length ? [`Strengths: ${cv.strengths.join("; ")}`] : []),
    ...(cv.gaps.length ? [`Gaps: ${cv.gaps.join("; ")}`] : []),
    ...(cv.openQuestions.length ? [`Open questions: ${cv.openQuestions.join("; ")}`] : []),
    "",
    "How the round was run (for the HR head only):",
    `• Competencies covered: ${a.panel.covered?.join(", ") || "–"}; missed: ${a.panel.missed?.join(", ") || "none"}`,
    ...(a.panel.candidateTalkShare != null
      ? [
          `• The candidate spoke ${Math.round(a.panel.candidateTalkShare * 100)}% of the time; the panel asked ${a.panel.panelQuestions ?? "?"} questions in about ${a.panel.minutes} minutes`,
        ]
      : []),
    ...(a.panel.offLimits?.length
      ? a.panel.offLimits.map(
          (o) => `• Question on protected ground (${o.topic.replace(/_/g, " ")}): "${o.quote}"`,
        )
      : []),
    ...(a.injectionSuspected
      ? [
          "",
          "Warning: the transcript contained text that looks like instructions to an AI — read the call before relying on the agent's view.",
        ]
      : []),
    "",
    a.held
      ? `Approve to go with the panel (${a.panelVerdict === "select" ? `${row.name} moves on to L${next}` : `their ${a.panelVerdict}`}). Decline to put ${row.name} on hold, or to reject them, with your reason.`
      : `Approve to confirm the panel's decision. Decline to stop: ${row.name} goes on hold (or is rejected, with your reason) and any later round not yet held is cancelled.`,
  ];
  return {
    role: "hr_head" as const,
    status: row.stage,
    detail: lines.join("\n"),
    subject: { ...subject, expects: row.stage },
  };
}

type Decision =
  | { status: "approved"; comment?: string | undefined }
  | { status: "rejected"; reason?: string | undefined; rejectCandidate?: boolean | undefined }
  | { status: string };

/** Carry out the HR head's decision, as the HR head (their role is checked). */
export async function performReviewGate(
  orgId: string,
  userId: string,
  memberEmail: string,
  subject: PanelReviewSubject,
  decision: Decision,
): Promise<void> {
  if (decision.status !== "approved" && decision.status !== "rejected") return;
  const { assertRole } = await import("@/lib/auth.middleware");
  await assertRole(
    userId,
    orgId,
    ["hr_head"],
    "Only the HR head (or an owner) decides on a panel review.",
  );
  const a = await assessmentOf(orgId, subject.interviewId);
  if (!a?.outcome) throw new Error("There is nothing to review on this round.");
  if (a.reviewDecision) throw new Error("This round has already been reviewed.");
  const [app] = await db
    .select({
      stage: applications.stage,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
    })
    .from(applications)
    .where(and(eq(applications.id, a.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!app) throw new Error("Application not found.");
  if (subject.expects && app.stage !== subject.expects)
    throw new Error("This candidate has already moved on; refresh to see their current stage.");

  const actor = { orgId, userId, memberEmail };
  const pipeline = await import("@/lib/pipeline.server");
  let reviewDecision: "go_with_panel" | "confirmed" | "held" | "rejected";
  let note: string | null = null;
  let cancelled = 0;

  if (decision.status === "approved") {
    note = ("comment" in decision && decision.comment?.trim()) || null;
    if (a.held) {
      reviewDecision = "go_with_panel";
      const { progressOf } = await import("@/lib/interview-plan.server");
      const { progressionFor } = await import("@/lib/interviews.functions");
      const progress = await progressOf(orgId, a.applicationId);
      const target = progressionFor(
        a.level,
        a.panelVerdict ?? "hold",
        progress.finalLevel,
        progress.plan.verdictPolicy,
      );
      if (target)
        await pipeline.moveStageCore(actor, {
          applicationId: a.applicationId,
          toStage: target,
          reason: `L${a.level} verdict: ${a.panelVerdict} — the HR head went with the panel after the panel review`,
          note,
        });
      if (a.panelVerdict === "select" && a.level < progress.finalLevel) {
        const [already] = await db
          .select({ id: interviews.id })
          .from(interviews)
          .where(
            and(
              eq(interviews.orgId, orgId),
              eq(interviews.applicationId, a.applicationId),
              eq(interviews.level, a.level + 1),
            ),
          )
          .limit(1);
        if (!already)
          await db.insert(interviews).values({
            applicationId: a.applicationId,
            orgId,
            level: a.level + 1,
            status: "pending_scheduling",
            scheduledAt: null,
          });
      }
    } else {
      reviewDecision = "confirmed";
    }
  } else {
    const why = ("reason" in decision && decision.reason?.trim()) || "";
    if (why.length < 3) throw new Error("Say why — it is kept on record with the candidate.");
    note = why;
    const reject = "rejectCandidate" in decision && Boolean(decision.rejectCandidate);
    reviewDecision = reject ? "rejected" : "held";
    await pipeline.moveStageCore(actor, {
      applicationId: a.applicationId,
      toStage: reject ? "rejected" : "on_hold",
      reason: `Panel review (L${a.level}): ${why}`,
    });
    // Stopped before the next round: rounds not yet held, and open time offers, end.
    const later = await db
      .update(interviews)
      .set({ status: "cancelled", outcomeNote: "Stopped by the HR head after the panel review" })
      .where(
        and(
          eq(interviews.orgId, orgId),
          eq(interviews.applicationId, a.applicationId),
          gt(interviews.level, a.level),
          inArray(interviews.status, ["pending_scheduling", "scheduled", "rescheduled"]),
        ),
      )
      .returning({ id: interviews.id });
    cancelled = later.length;
    const offers = await db
      .update(interviewSlotOffers)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(interviewSlotOffers.orgId, orgId),
          eq(interviewSlotOffers.applicationId, a.applicationId),
          gt(interviewSlotOffers.level, a.level),
          eq(interviewSlotOffers.status, "offered"),
        ),
      )
      .returning({ id: interviewSlotOffers.id });
    if (offers.length) {
      const { withdrawOfferEmails } = await import("@/lib/slot-offers.server");
      await withdrawOfferEmails(
        orgId,
        offers.map((o) => o.id),
      );
    }
  }

  await db
    .update(panelAssessments)
    .set({ reviewDecision, reviewNote: note, reviewedBy: userId, reviewedAt: new Date() })
    .where(and(eq(panelAssessments.orgId, orgId), eq(panelAssessments.id, a.id)));
  await writeAudit({
    actor: memberEmail,
    actorUserId: userId,
    orgId,
    action: "panel_review.decided",
    entityType: "interview",
    entityId: subject.interviewId,
    detail: {
      level: a.level,
      outcome: a.outcome,
      held: a.held,
      decision: reviewDecision,
      cancelledRounds: cancelled,
    },
  });
  // Training data: a person judged the agent's view against the panel's.
  try {
    const t = await import("../training/capture.server");
    await t.captureFeedback({
      orgId,
      source: "panel_review",
      label: reviewDecision,
      reason: note,
      original: {
        outcome: a.outcome,
        agent: { rating: a.rating, verdict: a.verdict },
        panel: { rating: a.panelRating, verdict: a.panelVerdict },
      },
      agentRunId: a.agentRunId,
      applicationId: a.applicationId,
      requisitionId: app.requisitionId,
      candidateId: app.candidateId,
      actorUserId: userId,
    });
  } catch (err) {
    log.warn("panel.review_capture_failed", { org_id: orgId, error: err as Error });
  }
  if (cancelled)
    try {
      const desk = await import("../desk/desk.server");
      const conv = await desk.conversationForRequisition(orgId, app.requisitionId);
      if (conv)
        await desk.postMessage(conv, {
          role: "desk",
          body: `After the L${a.level} panel review the HR head stopped the candidate: ${cancelled} later round(s) not yet held were cancelled. The candidate is not told automatically — let them know.`,
        });
    } catch {
      /* the thread is a courtesy; the audit trail has the record */
    }
}
