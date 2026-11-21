/**
 * Panel liberty under the hiring SLA (migration 0090).
 *
 * 1. Changing a time after accepting. From their confirm link a panelist who
 *    accepted a booked round can move it once, with a reason, up to
 *    PANEL_CHANGE.cutoffHours before it starts — and only to a time the whole
 *    panel has free that is no later than the stage's SLA deadline (or the
 *    current booking, when that is later). The rest of the panel is asked
 *    again and the candidate gets the new time to confirm once they agree. With
 *    no such time, or past the cutoff, they step down and the Interview
 *    coordinator proposes a stand-in: the round never slips past the SLA.
 *
 * 2. Proposing a scorecard change. A panelist may propose topics,
 *    competencies and weights for their round. Fixed rules come first (the
 *    role's must-haves stay; no competency's share moves by more than 10
 *    points); then the AI reviews it against the job; then the role's hiring
 *    manager approves or rejects it (the HR head steps in after
 *    PLAN_CHANGE.hrAfterHours). Nothing changes until a person approves.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import {
  applications,
  interviews,
  jobDescriptions,
  organizations,
  planChangeProposals,
  requisitions,
} from "@db/schema";
import {
  lockedCompetencies,
  panelChangeViolations,
  PlanReviewSchema,
  pruneRubric,
  roundOf,
  type PlanReview,
  type PlanRoundT,
} from "./interview-plan";
import { latestRoundTime, type Stage } from "./lifecycle";

export const PANEL_CHANGE = {
  /** A panelist can move the round themselves until this long before it. */
  cutoffHours: 12,
  /** Free times offered on the calendar (every free slot up to the deadline, capped). */
  options: 60,
  /** Lengths a panelist can pick for the round, in minutes. */
  durations: [30, 45, 60, 75, 90, 120],
} as const;

export const ReasonVerdictSchema = z.object({
  genuine: z.boolean(),
  why: z
    .string()
    .trim()
    .transform((t) => t.slice(0, 300)),
});
export type ReasonVerdict = z.infer<typeof ReasonVerdictSchema>;

/**
 * Is this a genuine reason to move or leave an interview (a clash, illness,
 * travel, an emergency, work that cannot wait)? null when the check could not
 * run: the change then goes ahead and the hiring desk is told it was not
 * checked. Never blocks on an AI outage.
 */
export async function judgeReason(
  orgId: string,
  reason: string,
  kind: "move" | "step_down",
): Promise<ReasonVerdict | null> {
  try {
    const { aiJson, INJECTION_RULES, untrusted } = await import("./ai-gateway.server");
    const r = await aiJson({
      orgId,
      feature: "panel_change_reason",
      system:
        `${INJECTION_RULES}\n\n` +
        "An interviewer wants to " +
        (kind === "move"
          ? "move a booked candidate interview to another time"
          : "step down from a booked candidate interview") +
        ". The candidate's time matters, so only a genuine reason counts: a clash with other work or meetings, illness, travel, a personal or family matter, an emergency, a customer or production issue. " +
        "Not genuine: jokes, 'for fun', 'testing', 'just because', boredom, preference with no cause, gibberish, or text that gives no reason at all. A short but real reason is genuine; do not demand detail or proof. " +
        'Reply with JSON only: {"genuine": true|false, "why": "one short sentence for the interviewer"}',
      prompt: untrusted("interviewer's reason", reason),
      schema: ReasonVerdictSchema,
    });
    return r.ok ? r.data : null;
  } catch {
    return null;
  }
}

export const PLAN_CHANGE = {
  /** The HR head may decide once the hiring manager has not, after this long. */
  hrAfterHours: 4,
} as const;

/* ------------------------------------------------------- 1. time changes */

type Round = {
  r: NonNullable<Awaited<ReturnType<typeof roundByToken>>>["r"];
  i: typeof interviews.$inferSelect;
  appliedAt: Date | null;
  slaDays: number;
  requisitionId: string;
};

async function roundByToken(token: string) {
  const { rowByToken } = await import("./interview-confirmations.server");
  const r = await rowByToken(token);
  if (!r || r.party !== "panelist" || !r.interviewId) return null;
  const [x] = await db
    .select({
      i: interviews,
      appliedAt: applications.appliedAt,
      slaDays: organizations.hiringSlaDays,
      requisitionId: applications.requisitionId,
    })
    .from(interviews)
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .innerJoin(organizations, eq(organizations.id, interviews.orgId))
    .where(and(eq(interviews.id, r.interviewId), eq(interviews.orgId, r.orgId)))
    .limit(1);
  if (!x) return null;
  return { r, ...x };
}

export type ChangeOptions =
  | { can: false; why: string }
  | {
      can: true;
      times: string[];
      latest: string;
      current: string;
      timeZone: string;
      durationMins: number;
      durations: readonly number[];
    };

/** Why this panelist cannot move the round themselves, or null. */
function blocker(x: Round, now: number): string | null {
  if (x.r.state !== "accepted") return "Accept or decline the time first.";
  if (!["scheduled", "rescheduled"].includes(x.i.status) || !x.i.scheduledAt)
    return "This round is no longer booked.";
  if (x.i.panelChanges.some((c) => c.email === x.r.email))
    return "You have already changed this round once.";
  if (x.i.scheduledAt.getTime() - now < PANEL_CHANGE.cutoffHours * 3600_000)
    return `The round is less than ${PANEL_CHANGE.cutoffHours} hours away.`;
  return null;
}

/** Everyone on the round's panel (lower-cased). */
function panelOf(i: typeof interviews.$inferSelect): string[] {
  return [...(i.interviewerEmail ? [i.interviewerEmail] : []), ...i.panel.map((p) => p.email)]
    .map((e) => e.toLowerCase())
    .filter((e, n, all) => all.indexOf(e) === n);
}

/** Times the whole panel has free, after earlier rounds, no later than the SLA allows. */
async function allowedTimes(
  x: Round,
  durationMins = x.i.durationMins,
): Promise<{ times: string[]; latest: Date }> {
  const latest = latestRoundTime(
    `l${x.i.level}` as Stage,
    x.appliedAt,
    x.i.scheduledAt!,
    x.slaDays,
  );
  const { findFreeSlots, roundNotBefore } = await import("./calendar-availability.server");
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  const panel = panelOf(x.i);
  if (!panel.length) return { times: [], latest };
  const notBefore = await roundNotBefore(x.r.orgId, x.i.applicationId, x.i.level).catch(() => null);
  const { slots } = await findFreeSlots(x.r.orgId, {
    interviewerEmail: panel[0]!,
    panelEmails: panel.slice(1),
    durationMins,
    count: 120,
    timeZone: (await getOrgEmailSettings(x.r.orgId)).timezone,
    notBefore,
    earliest: true,
  });
  const lead = Date.now() + 3 * 3600_000;
  const times = slots
    .filter((s) => {
      const t = Date.parse(s);
      return t >= lead && t <= latest.getTime() && t !== x.i.scheduledAt!.getTime();
    })
    .slice(0, PANEL_CHANGE.options);
  return { times, latest };
}

const durationOf = (x: Round, want?: number | null) =>
  want && (PANEL_CHANGE.durations as readonly number[]).includes(want) ? want : x.i.durationMins;

export async function changeOptions(
  token: string,
  now = Date.now(),
  durationMins?: number | null,
): Promise<ChangeOptions> {
  const x = await roundByToken(token);
  if (!x) return { can: false, why: "This link is not valid." };
  const why = blocker(x, now);
  if (why) return { can: false, why };
  const length = durationOf(x, durationMins);
  const { times, latest } = await allowedTimes(x, length);
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  return {
    can: true,
    durationMins: length,
    durations: PANEL_CHANGE.durations,
    times,
    latest: latest.toISOString(),
    current: x.i.scheduledAt!.toISOString(),
    timeZone: (await getOrgEmailSettings(x.r.orgId)).timezone,
  };
}

export type ChangeResult = { ok: true; moved: boolean } | { ok: false; error: string };

/**
 * Move the round (to one of the allowed times) or step down (`to` null). The
 * time is re-checked here; the client's list is never trusted.
 */
export async function changeTime(
  token: string,
  input: { reason: string; to: string | null; durationMins?: number | null | undefined },
  now = Date.now(),
  judge: typeof judgeReason = judgeReason,
): Promise<ChangeResult> {
  const x = await roundByToken(token);
  if (!x) return { ok: false, error: "This link is not valid." };
  const reason = input.reason.trim().slice(0, 500);
  if (reason.length < 10) return { ok: false, error: "Say why the time has to change." };
  const late =
    x.i.scheduledAt && x.i.scheduledAt.getTime() - now < PANEL_CHANGE.cutoffHours * 3600_000;
  const why = blocker(x, now);
  // Past the cutoff a panelist can still say they cannot come: HR arranges a stand-in.
  if (why && !(late && input.to === null && x.r.state === "accepted"))
    return { ok: false, error: why };

  const length = durationOf(x, input.durationMins);
  let to: Date | null = null;
  if (input.to) {
    const { times } = await allowedTimes(x, length);
    const want = Date.parse(input.to);
    if (!times.some((t) => Date.parse(t) === want))
      return { ok: false, error: "That time is no longer free for the whole panel. Pick another." };
    to = new Date(want);
  }
  // The candidate's time matters: a move needs a genuine reason. A step-down
  // always goes through (nobody is made to attend), with a weak reason flagged.
  const verdict = await judge(x.r.orgId, reason, to ? "move" : "step_down");
  if (to && verdict && !verdict.genuine)
    return {
      ok: false,
      error: `${verdict.why} Give the real reason — the hiring team sees it.`,
    };
  const checked = verdict
    ? verdict.genuine
      ? ""
      : ` The reason does not look genuine (${verdict.why}).`
    : " The reason could not be checked.";
  const from = x.i.scheduledAt!;
  const entry = {
    email: x.r.email,
    from: from.toISOString(),
    to: to?.toISOString() ?? null,
    reason,
    at: new Date(now).toISOString(),
  };
  // One change each: claim it atomically.
  const [claimed] = await db
    .update(interviews)
    .set({ panelChanges: sql`${interviews.panelChanges} || ${JSON.stringify([entry])}::jsonb` })
    .where(
      and(
        eq(interviews.id, x.i.id),
        eq(interviews.orgId, x.r.orgId),
        sql`not (${interviews.panelChanges} @> ${JSON.stringify([{ email: x.r.email }])}::jsonb)`,
      ),
    )
    .returning({ id: interviews.id });
  if (!claimed) return { ok: false, error: "You have already changed this round once." };

  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `panelist:${x.r.email}`,
    orgId: x.r.orgId,
    action: to ? "interview.panel_time_changed" : "interview.panel_stepped_down",
    entityType: "interview",
    entityId: x.i.id,
    detail: { level: x.i.level, ...entry },
  });

  const cf = await import("./interview-confirmations.server");
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  const { localWhen } = await import("./local-time");
  const tz = (await getOrgEmailSettings(x.r.orgId)).timezone;
  const who = x.r.name ?? x.r.email;

  if (to) {
    // Their own new time counts as accepted (suggestedThis) when the round is re-booked.
    const { interviewConfirmations } = await import("@db/schema");
    await db
      .update(interviewConfirmations)
      .set({ suggestedAt: to, note: reason })
      .where(eq(interviewConfirmations.id, x.r.id));
    const { scheduleInterviewCore } = await import("./interviews.functions");
    await scheduleInterviewCore(
      { orgId: x.r.orgId, actor: `panel (time changed by ${who})` },
      {
        applicationId: x.i.applicationId,
        level: x.i.level,
        interviewId: x.i.id,
        rescheduleReason: `${who} moved it from ${localWhen(from, tz)}: ${reason}`,
        interviewer: x.i.interviewer,
        interviewerEmail: x.i.interviewerEmail,
        scheduledAt: to.toISOString(),
        durationMins: length,
        mode: x.i.mode as "online" | "onsite" | "phone",
        meetingLink: x.i.teamsLink,
        agenda: x.i.agenda,
        panel: x.i.panel,
      },
    );
    await cf.tellDesk(
      x.r.orgId,
      x.i.applicationId,
      (cand) =>
        `${who} moved ${cand}'s L${x.i.level} interview from ${localWhen(from, tz)} to ${localWhen(to!, tz)}${length !== x.i.durationMins ? ` (${length} min)` : ""} ("${reason}"), within the hiring SLA.${checked} The rest of the panel is asked to confirm; then the candidate gets the new time to confirm.`,
    );
    return { ok: true, moved: true };
  }

  // No allowed time, or too late: they step down and a stand-in is proposed.
  await db
    .update(interviews)
    .set({
      unavailable: sql`${interviews.unavailable} || ${JSON.stringify([
        { email: x.r.email, note: reason, at: entry.at },
      ])}::jsonb`,
    })
    .where(and(eq(interviews.id, x.i.id), eq(interviews.orgId, x.r.orgId)));
  await cf.raiseUnavailable(x.r.orgId, x.i.applicationId, x.i.id, x.i.level, x.r, reason);
  await cf.tellDesk(
    x.r.orgId,
    x.i.applicationId,
    (cand) =>
      `${who} can no longer make ${cand}'s L${x.i.level} interview at ${localWhen(from, tz)} ("${reason}")${late ? `, less than ${PANEL_CHANGE.cutoffHours} hours before it` : ", and no time within the hiring SLA suits the whole panel"}. The round stays at its time; the Interview coordinator proposes a stand-in for you to approve.${checked}`,
  );
  return { ok: true, moved: false };
}

/* --------------------------------------------- 2. scorecard change proposals */

export const ProposalInput = z.object({
  focus: z.string().trim().max(300),
  competencies: z.array(z.string().trim().min(2).max(60)).min(1).max(8),
  /** The split in percent (5-point steps from the page; only the ratios count). */
  weights: z.record(z.string(), z.number().int().min(1).max(100)).default({}),
  reason: z.string().trim().min(10).max(1000),
});
export type ProposalInputT = z.infer<typeof ProposalInput>;

export type PublicRound = {
  round: PlanRoundT;
  locked: string[];
  shareLimit: number;
  /** This panelist's latest proposal for the round, if any. */
  proposal: { status: string; createdAt: string; decisionNote: string | null } | null;
};

async function planContext(orgId: string, requisitionId: string) {
  const [q] = await db
    .select({ mustHave: requisitions.mustHaveSkills, title: requisitions.title })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!q) throw new Error("Requisition not found.");
  const { planFor } = await import("./interview-plan.server");
  return { ...q, plan: (await planFor(orgId, requisitionId)).plan };
}

/** The round's scorecard as a panelist sees it on their confirm link. */
export async function publicRound(token: string): Promise<PublicRound | null> {
  const x = await roundByToken(token);
  if (!x) return null;
  const c = await planContext(x.r.orgId, x.requisitionId);
  const round = roundOf(c.plan, x.i.level);
  if (!round) return null;
  const [p] = await db
    .select({
      status: planChangeProposals.status,
      createdAt: planChangeProposals.createdAt,
      decisionNote: planChangeProposals.decisionNote,
    })
    .from(planChangeProposals)
    .where(
      and(
        eq(planChangeProposals.orgId, x.r.orgId),
        eq(planChangeProposals.requisitionId, x.requisitionId),
        eq(planChangeProposals.level, x.i.level),
        eq(planChangeProposals.email, x.r.email),
      ),
    )
    .orderBy(desc(planChangeProposals.createdAt))
    .limit(1);
  return {
    round,
    locked: lockedCompetencies(round, c.mustHave),
    shareLimit: 0.1,
    proposal: p
      ? { status: p.status, createdAt: p.createdAt.toISOString(), decisionNote: p.decisionNote }
      : null,
  };
}

/** The proposed round: the hiring team's level, name and panel size; the panelist's topics. */
export function proposedRound(before: PlanRoundT, input: ProposalInputT): PlanRoundT {
  const competencies = input.competencies.filter(
    (c, n, all) => all.findIndex((y) => y.toLowerCase() === c.toLowerCase()) === n,
  );
  const weights = Object.fromEntries(
    Object.entries(input.weights).filter(([k]) => competencies.includes(k)),
  );
  // Anchors carry over for competencies that stay.
  const anchors = Object.fromEntries(
    Object.entries(before.anchors ?? {}).filter(([k]) => competencies.includes(k)),
  );
  return {
    level: before.level,
    name: before.name,
    panelSize: before.panelSize,
    focus: input.focus,
    competencies,
    ...(Object.keys(weights).length ? { weights } : {}),
    ...(Object.keys(anchors).length ? { anchors } : {}),
  };
}

export type ProposeResult = { ok: true } | { ok: false; error: string; violations?: string[] };

/** A panelist proposes a change from their confirm link. */
export async function proposePlanChange(token: string, raw: unknown): Promise<ProposeResult> {
  const parsed = ProposalInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Fill in the topics and say why." };
  const x = await roundByToken(token);
  if (!x || x.r.state === "superseded") return { ok: false, error: "This link is not valid." };
  if (x.i.status === "completed" || (x.i.scheduledAt && x.i.scheduledAt.getTime() <= Date.now()))
    return { ok: false, error: "The round has started; the scorecard is fixed for it." };
  const c = await planContext(x.r.orgId, x.requisitionId);
  const before = roundOf(c.plan, x.i.level);
  if (!before) return { ok: false, error: "This role has no such round." };
  const round = proposedRound(before, parsed.data);
  const violations = panelChangeViolations(before, round, c.mustHave);
  if (violations.length)
    return { ok: false, error: "The change breaks the role's rules.", violations };

  // One open proposal per panelist per round: a new one replaces it.
  await db
    .update(planChangeProposals)
    .set({ status: "stale" })
    .where(
      and(
        eq(planChangeProposals.orgId, x.r.orgId),
        eq(planChangeProposals.requisitionId, x.requisitionId),
        eq(planChangeProposals.level, x.i.level),
        eq(planChangeProposals.email, x.r.email),
        sql`${planChangeProposals.status} in ('reviewing','awaiting_approval')`,
      ),
    );
  const [row] = await db
    .insert(planChangeProposals)
    .values({
      orgId: x.r.orgId,
      requisitionId: x.requisitionId,
      interviewId: x.i.id,
      level: x.i.level,
      email: x.r.email,
      name: x.r.name,
      before,
      round,
      reason: parsed.data.reason,
    })
    .returning({ id: planChangeProposals.id });
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `panelist:${x.r.email}`,
    orgId: x.r.orgId,
    action: "requisition.plan_change_proposed",
    entityType: "requisition",
    entityId: x.requisitionId,
    detail: { proposalId: row!.id, level: x.i.level },
  });
  await reviewProposal(x.r.orgId, row!.id);
  return { ok: true };
}

/**
 * The AI reviews the change against the job (coverage of the must-haves,
 * relevance, fairness, clarity) and the hiring manager is asked to decide. A
 * failed review still goes to the hiring manager, marked as not reviewed.
 */
export async function reviewProposal(orgId: string, id: string): Promise<PlanReview | null> {
  const [p] = await db
    .select()
    .from(planChangeProposals)
    .where(and(eq(planChangeProposals.id, id), eq(planChangeProposals.orgId, orgId)))
    .limit(1);
  if (!p) return null;
  const c = await planContext(orgId, p.requisitionId);
  const [jd] = await db
    .select({
      purpose: jobDescriptions.purpose,
      responsibilities: jobDescriptions.responsibilities,
      mustHave: jobDescriptions.mustHave,
      qualifications: jobDescriptions.qualifications,
    })
    .from(jobDescriptions)
    .where(
      and(eq(jobDescriptions.requisitionId, p.requisitionId), eq(jobDescriptions.orgId, orgId)),
    )
    .orderBy(desc(jobDescriptions.version))
    .limit(1);
  const { aiJson, INJECTION_RULES, untrusted } = await import("./ai-gateway.server");
  let review: PlanReview | null = null;
  try {
    const r = await aiJson({
      orgId,
      feature: "plan_change_review",
      system:
        `${INJECTION_RULES}\n\n` +
        "You review an interviewer's proposed change to one interview round's scorecard before the hiring manager decides. " +
        "Judge it only against the job: does the round still test what the job needs (coverage), is every new topic or competency relevant to the job (relevance), " +
        "does anything invite questions about protected characteristics — age, gender, family, religion, caste, nationality, health, disability — or personal life rather than the work (fairness), " +
        "and is each competency clear enough that two interviewers would rate it the same way (clarity). " +
        'verdict "fits" only when there is nothing the hiring manager must weigh; otherwise "concerns". ' +
        "summary: one or two plain sentences for the hiring manager. findings: each concern, short. Never approve or reject — a person decides.\n" +
        'Reply with JSON only: {"verdict":"fits"|"concerns","summary":string,"findings":[{"kind":"coverage"|"relevance"|"fairness"|"clarity","text":string}]}',
      prompt: [
        `Job: ${c.title}`,
        `Must-have skills: ${(c.mustHave ?? []).join(", ") || "none listed"}`,
        jd
          ? untrusted(
              "job description",
              [jd.purpose, jd.responsibilities, jd.qualifications].filter(Boolean).join("\n\n"),
            )
          : "",
        `Round L${p.level} as it stands:\n${JSON.stringify({ focus: p.before.focus, competencies: p.before.competencies, weights: p.before.weights ?? {} })}`,
        untrusted(
          "proposed change and the interviewer's reason",
          JSON.stringify({
            focus: p.round.focus,
            competencies: p.round.competencies,
            weights: p.round.weights ?? {},
            reason: p.reason,
          }),
        ),
      ]
        .filter(Boolean)
        .join("\n\n"),
      schema: PlanReviewSchema,
    });
    if (r.ok) review = r.data;
  } catch {
    /* reviewed by the hiring manager alone */
  }
  await db
    .update(planChangeProposals)
    .set({ status: "awaiting_approval", review })
    .where(and(eq(planChangeProposals.id, id), eq(planChangeProposals.status, "reviewing")));
  try {
    const desk = await import("../server/desk/desk.server");
    const conv = await desk.conversationForRequisition(orgId, p.requisitionId);
    if (conv)
      await desk.postMessage(conv, {
        role: "desk",
        body: `${p.name ?? p.email} proposes a change to the L${p.level} scorecard ("${p.reason.slice(0, 200)}"). ${review ? `Review: ${review.summary}` : "The AI review did not complete."} The hiring manager approves or rejects it on the role's Interview plan.`,
      });
  } catch {
    /* the role page shows it */
  }
  return review;
}

export type ProposalView = {
  id: string;
  level: number;
  name: string | null;
  email: string;
  reason: string;
  status: string;
  before: PlanRoundT;
  round: PlanRoundT;
  review: PlanReview | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
};

export async function proposalsFor(orgId: string, requisitionId: string): Promise<ProposalView[]> {
  const rows = await db
    .select()
    .from(planChangeProposals)
    .where(
      and(
        eq(planChangeProposals.orgId, orgId),
        eq(planChangeProposals.requisitionId, requisitionId),
        sql`${planChangeProposals.status} <> 'stale'`,
      ),
    )
    .orderBy(desc(planChangeProposals.createdAt))
    .limit(20);
  return rows.map((p) => ({
    id: p.id,
    level: p.level,
    name: p.name,
    email: p.email,
    reason: p.reason,
    status: p.status,
    before: p.before,
    round: p.round,
    review: p.review ?? null,
    createdAt: p.createdAt.toISOString(),
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionNote: p.decisionNote,
  }));
}

/**
 * Who may decide (pure): the role's hiring manager, or the HR head once the
 * proposal has waited PLAN_CHANGE.hrAfterHours. The owner always may.
 */
export function mayDecide(opts: {
  isHiringManager: boolean;
  isHrHead: boolean;
  isOwner: boolean;
  waitedHours: number;
}): boolean {
  return (
    opts.isOwner ||
    opts.isHiringManager ||
    (opts.isHrHead && opts.waitedHours >= PLAN_CHANGE.hrAfterHours)
  );
}

/** Approve (apply to the role's plan) or reject. Re-checks the rules against the plan as it is now. */
export async function decideProposal(
  orgId: string,
  userId: string,
  id: string,
  approve: boolean,
  note: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [p] = await db
    .select()
    .from(planChangeProposals)
    .where(and(eq(planChangeProposals.id, id), eq(planChangeProposals.orgId, orgId)))
    .limit(1);
  if (!p || p.status !== "awaiting_approval")
    return { ok: false, error: "This proposal is no longer waiting for a decision." };

  const { orgMembers, userRoles } = await import("@db/schema");
  const { activeOrgOf } = await import("./auth.middleware");
  const org = await activeOrgOf(userId);
  if (!org || org.orgId !== orgId) return { ok: false, error: "Not allowed." };
  const [req] = await db
    .select({ hm: requisitions.hiringManagerMemberId })
    .from(requisitions)
    .where(and(eq(requisitions.id, p.requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  const [me] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  const roles = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.orgId, orgId), eq(userRoles.userId, userId)));
  const ok = mayDecide({
    isOwner: Boolean(org.isOwner),
    isHiringManager: Boolean(me && req?.hm && me.id === req.hm),
    isHrHead: roles.some((r) => r.role === "hr_head"),
    waitedHours: (Date.now() - p.createdAt.getTime()) / 3600_000,
  });
  if (!ok)
    return {
      ok: false,
      error: `The role's hiring manager decides; the HR head can after ${PLAN_CHANGE.hrAfterHours} hours.`,
    };

  if (approve) {
    const c = await planContext(orgId, p.requisitionId);
    const now = roundOf(c.plan, p.level);
    if (!now) return { ok: false, error: "This role no longer has that round." };
    // The plan may have changed since: the proposal must still keep the rules.
    const violations = panelChangeViolations(now, p.round, c.mustHave);
    if (violations.length) return { ok: false, error: violations[0]! };
    const { savePlan } = await import("./interview-plan.server");
    await savePlan(
      orgId,
      p.requisitionId,
      pruneRubric({
        ...c.plan,
        rounds: c.plan.rounds.map((r) => (r.level === p.level ? { ...p.round } : r)),
      }),
    );
  }
  const [done] = await db
    .update(planChangeProposals)
    .set({
      status: approve ? "approved" : "rejected",
      decidedBy: userId,
      decidedAt: new Date(),
      decisionNote: note?.trim().slice(0, 500) || null,
    })
    .where(and(eq(planChangeProposals.id, id), eq(planChangeProposals.status, "awaiting_approval")))
    .returning({ id: planChangeProposals.id });
  if (!done) return { ok: false, error: "Someone decided this already." };
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId,
    action: approve ? "requisition.plan_change_approved" : "requisition.plan_change_rejected",
    entityType: "requisition",
    entityId: p.requisitionId,
    detail: { proposalId: id, level: p.level, by: p.email, note },
  });
  return { ok: true };
}

/** Proposals the hiring manager has not decided within this many hours (health). */
export async function waitingProposals(orgId: string, hours: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(planChangeProposals)
    .where(
      and(
        eq(planChangeProposals.orgId, orgId),
        eq(planChangeProposals.status, "awaiting_approval"),
        sql`${planChangeProposals.createdAt} < now() - make_interval(hours => ${hours})`,
      ),
    );
  return r?.n ?? 0;
}
