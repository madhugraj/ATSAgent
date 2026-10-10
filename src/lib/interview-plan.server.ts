/**
 * Interview plans and round progress, server side. A role's plan is its saved
 * one, else the default built from its must-haves (src/lib/interview-plan.ts).
 * A round is complete when every interviewer on it has submitted a scorecard
 * (legacy scorecards without a round count as complete for their level).
 */
import { and, eq } from "drizzle-orm";

import { db } from "../server/db";
import { applications, evaluations, interviews, requisitions } from "@db/schema";
import {
  defaultPlan,
  finalLevel,
  InterviewPlanSchema,
  roundVerdict,
  type InterviewPlan,
  type Verdict,
} from "./interview-plan";

export async function planFor(
  orgId: string,
  requisitionId: string,
): Promise<{ plan: InterviewPlan; saved: boolean }> {
  const [r] = await db
    .select({ plan: requisitions.interviewPlan, mustHave: requisitions.mustHaveSkills })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!r) throw new Error("Requisition not found.");
  if (r.plan) {
    const parsed = InterviewPlanSchema.safeParse(r.plan);
    if (parsed.success) return { plan: parsed.data, saved: true };
  }
  return { plan: defaultPlan(r.mustHave), saved: false };
}

export async function savePlan(
  orgId: string,
  requisitionId: string,
  plan: unknown,
): Promise<InterviewPlan> {
  const parsed = InterviewPlanSchema.parse(plan);
  const done = await db
    .update(requisitions)
    .set({ interviewPlan: parsed })
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .returning({ id: requisitions.id });
  if (!done.length) throw new Error("Requisition not found.");
  return parsed;
}

export const emailsOf = (r: {
  interviewerEmail: string | null;
  panel: { email: string }[] | null;
}) =>
  [r.interviewerEmail, ...(r.panel ?? []).map((p) => p.email)]
    .filter((e): e is string => Boolean(e))
    .map((e) => e.toLowerCase())
    .filter((e, i, all) => all.indexOf(e) === i);

export type RoundProgress = {
  level: number;
  interviewId: string | null;
  status: string;
  panel: string[];
  submitted: string[];
  missing: string[];
  complete: boolean;
  verdict: Verdict | null;
};

/** Every round of an application with who scored it, against the role's plan. */
export async function progressOf(
  orgId: string,
  applicationId: string,
): Promise<{
  plan: InterviewPlan;
  finalLevel: number;
  rounds: RoundProgress[];
  /** The final round is complete (every panel member scored it). */
  finalComplete: boolean;
}> {
  const [app] = await db
    .select({ requisitionId: applications.requisitionId })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!app) throw new Error("Application not found.");
  const { plan } = await planFor(orgId, app.requisitionId);
  const rows = await db
    .select({
      id: interviews.id,
      level: interviews.level,
      status: interviews.status,
      interviewerEmail: interviews.interviewerEmail,
      panel: interviews.panel,
    })
    .from(interviews)
    .where(and(eq(interviews.orgId, orgId), eq(interviews.applicationId, applicationId)));
  const cards = await db
    .select({
      interviewId: evaluations.interviewId,
      level: evaluations.level,
      evaluatorEmail: evaluations.evaluatorEmail,
      evaluator: evaluations.evaluator,
      verdict: evaluations.recommendation,
    })
    .from(evaluations)
    .where(and(eq(evaluations.orgId, orgId), eq(evaluations.applicationId, applicationId)));
  const rounds: RoundProgress[] = rows
    .filter((r) => !["cancelled", "no_show", "pending_scheduling"].includes(r.status))
    .map((r) => {
      const panel = emailsOf(r);
      const mine = cards.filter((c) => c.interviewId === r.id);
      const submitted = mine.map((c) => (c.evaluatorEmail ?? c.evaluator ?? "").toLowerCase());
      const missing = panel.filter((e) => !submitted.includes(e));
      const complete = mine.length > 0 && missing.length === 0;
      return {
        level: r.level,
        interviewId: r.id,
        status: r.status,
        panel,
        submitted,
        missing,
        complete,
        verdict: complete ? roundVerdict(mine.map((c) => c.verdict as Verdict)) : null,
      };
    });
  // Scorecards filed without a round (older data) stand for their level.
  for (const c of cards.filter((x) => !x.interviewId)) {
    if (rounds.some((r) => r.level === c.level && r.complete)) continue;
    rounds.push({
      level: c.level,
      interviewId: null,
      status: "completed",
      panel: [],
      submitted: [(c.evaluatorEmail ?? c.evaluator ?? "").toLowerCase()],
      missing: [],
      complete: true,
      verdict: c.verdict as Verdict,
    });
  }
  rounds.sort((a, b) => a.level - b.level);
  const last = finalLevel(plan);
  return {
    plan,
    finalLevel: last,
    rounds,
    finalComplete: rounds.some((r) => r.level >= last && r.complete),
  };
}

/**
 * Why a hiring decision may not be requested yet (null = it may). A select
 * (→ offer) needs the role's final round complete; a hold or reject needs at
 * least one completed round.
 */
export async function hiringDecisionBlocked(
  orgId: string,
  applicationId: string,
  recommendation: Verdict,
): Promise<string | null> {
  const p = await progressOf(orgId, applicationId);
  if (!p.rounds.some((r) => r.complete))
    return "No interview round is complete yet, so there is nothing to decide on.";
  if (recommendation === "select" && !p.finalComplete) {
    const done = p.rounds.filter((r) => r.complete).map((r) => `L${r.level}`);
    return `Too early for a select: the role has ${p.finalLevel} interview round(s) and the final one (L${p.finalLevel}) is not complete (complete: ${done.join(", ") || "none"}). Debrief this round only; ask for the hiring decision after L${p.finalLevel}.`;
  }
  return null;
}
