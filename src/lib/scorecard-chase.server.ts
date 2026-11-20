/**
 * Scorecards are due 2 hours after a round ends (the hiring SLA leaves no room
 * for a day's wait). Run by the agent tick for every interviewer who has not
 * scored a round that ended:
 *   at the end      → reminder (their scorecard link);
 *   +1 h            → second reminder;
 *   +2 h            → the HR head is told on the hiring desk: the candidate is
 *                     blocked on feedback;
 *   +4 h, then daily→ the HR head is told again and the interviewer reminded.
 * Each step happens once (scorecard_chases); rounds older than 14 days are left.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  applications,
  candidates,
  evaluations,
  interviews,
  organizations,
  scorecardChases,
} from "@db/schema";

export const SCORECARD_DUE = { remindAgainHours: 1, dueHours: 2, escalateHours: 4 } as const;
const HOUR = 3600_000;

/**
 * The chase step a missing scorecard should be at `hoursAfterEnd` after the
 * round (pure). A step is never repeated; a late first look jumps straight to
 * the step that applies (one reminder and one desk message, not a burst).
 */
export function chaseStep(hoursAfterEnd: number, lastStep: number, hoursSinceLast: number): number {
  if (hoursAfterEnd < 0) return lastStep;
  const target =
    hoursAfterEnd >= SCORECARD_DUE.escalateHours
      ? 4
      : hoursAfterEnd >= SCORECARD_DUE.dueHours
        ? 3
        : hoursAfterEnd >= SCORECARD_DUE.remindAgainHours
          ? 2
          : 1;
  if (target > lastStep) return target;
  if (lastStep >= 4 && hoursSinceLast >= 24) return lastStep + 1;
  return lastStep;
}

/** First noticed this late (hours): marked without messages (backlog), then chased daily. */
const QUIET_FIRST_LOOK_HOURS = 48;

/** Interviewers still to score each round, by round id (internal helper, exported for the Interviews page). */
export async function missingScorecards(
  orgId: string,
  interviewIds: string[],
): Promise<Record<string, string[]>> {
  if (!interviewIds.length) return {};
  const rounds = await db
    .select({
      id: interviews.id,
      lead: interviews.interviewerEmail,
      panel: interviews.panel,
      unavailable: interviews.unavailable,
    })
    .from(interviews)
    .where(and(eq(interviews.orgId, orgId), inArray(interviews.id, interviewIds)));
  const scored = await db
    .select({ id: evaluations.interviewId, email: evaluations.evaluatorEmail })
    .from(evaluations)
    .where(and(eq(evaluations.orgId, orgId), inArray(evaluations.interviewId, interviewIds)));
  const out: Record<string, string[]> = {};
  for (const r of rounds) {
    const away = new Set((r.unavailable ?? []).map((u) => u.email.toLowerCase()));
    const people = [...(r.lead ? [r.lead] : []), ...(r.panel ?? []).map((p) => p.email)]
      .map((e) => e.toLowerCase())
      .filter((e, i, all) => all.indexOf(e) === i && !away.has(e));
    const done = new Set(
      scored.filter((x) => x.id === r.id).map((x) => (x.email ?? "").toLowerCase()),
    );
    const missing = people.filter((e) => !done.has(e));
    if (missing.length) out[r.id] = missing;
  }
  return out;
}

export async function sweepScorecards(orgId?: string, now = Date.now()): Promise<number> {
  const ended = await db
    .select({
      id: interviews.id,
      orgId: interviews.orgId,
      applicationId: interviews.applicationId,
      level: interviews.level,
      scheduledAt: interviews.scheduledAt,
      durationMins: interviews.durationMins,
      panel: interviews.panel,
      lead: interviews.interviewerEmail,
      leadName: interviews.interviewer,
    })
    .from(interviews)
    .where(
      and(
        orgId ? eq(interviews.orgId, orgId) : sql`true`,
        inArray(interviews.status, ["scheduled", "rescheduled", "completed"]),
        sql`${interviews.scheduledAt} + make_interval(mins => ${interviews.durationMins}) <= ${new Date(now).toISOString()}::timestamptz`,
        sql`${interviews.scheduledAt} > ${new Date(now - 14 * 864e5).toISOString()}::timestamptz`,
      ),
    )
    .limit(300);
  let acted = 0;
  const byOrg = new Map<string, typeof ended>();
  for (const r of ended) {
    if (!r.orgId) continue;
    byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r]);
  }
  for (const [org, rounds] of byOrg) {
    const missing = await missingScorecards(
      org,
      rounds.map((r) => r.id),
    );
    for (const r of rounds) {
      for (const email of missing[r.id] ?? []) {
        try {
          if (await chaseOne(org, r, email, now)) acted++;
        } catch {
          /* one interviewer never stops the sweep */
        }
      }
    }
  }
  return acted;
}

type Round = {
  id: string;
  applicationId: string;
  level: number;
  scheduledAt: Date | null;
  durationMins: number;
  panel: { name: string | null; email: string }[];
  lead: string | null;
  leadName: string | null;
};

async function chaseOne(orgId: string, r: Round, email: string, now: number): Promise<boolean> {
  const end = r.scheduledAt!.getTime() + r.durationMins * 60_000;
  const [row] = await db
    .insert(scorecardChases)
    .values({ orgId, interviewId: r.id, email })
    .onConflictDoUpdate({
      target: [scorecardChases.interviewId, scorecardChases.email],
      set: { email },
    })
    .returning();
  const last = row!.step;
  const sinceLast = row!.lastAt ? (now - row!.lastAt.getTime()) / HOUR : Infinity;
  const next = chaseStep((now - end) / HOUR, last, sinceLast);
  if (next === last) return false;
  const [claimed] = await db
    .update(scorecardChases)
    .set({ step: next, lastAt: new Date(now) })
    .where(and(eq(scorecardChases.id, row!.id), eq(scorecardChases.step, last)))
    .returning({ id: scorecardChases.id });
  if (!claimed) return false;
  if (last === 0 && (now - end) / HOUR > QUIET_FIRST_LOOK_HOURS) return false;

  const [ctx] = await db
    .select({
      candidateName: candidates.fullName,
      orgName: organizations.name,
      requisitionId: applications.requisitionId,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .where(and(eq(applications.id, r.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  const cand = ctx?.candidateName ?? "the candidate";
  const name =
    (r.lead?.toLowerCase() === email ? r.leadName : null) ??
    r.panel.find((p) => p.email.toLowerCase() === email)?.name ??
    email;
  const overdue = Math.max(0, Math.round(((now - end) / HOUR) * 10) / 10);

  // The interviewer: steps 1, 2 and every escalation.
  if (next !== 3) await remindInterviewer(orgId, r, email, name, cand, ctx?.orgName, next);
  // The HR head, on the role's hiring desk: from the due time on.
  if (next >= 3 && ctx) {
    const body =
      next === 3
        ? `${name}'s L${r.level} scorecard for ${cand} is due and missing (${overdue} h after the round). ${cand} is blocked on feedback until it is in.`
        : `${name}'s L${r.level} scorecard for ${cand} is still missing, ${overdue} h after the round. ${cand} cannot move on; chase ${name} or ask another panelist.`;
    try {
      const desk = await import("../server/desk/desk.server");
      const conv = await desk.conversationForRequisition(orgId, ctx.requisitionId);
      if (conv) await desk.postMessage(conv, { role: "desk", body });
    } catch {
      /* the Interviews page shows it either way */
    }
  }
  return true;
}

async function remindInterviewer(
  orgId: string,
  r: Round,
  email: string,
  name: string,
  cand: string,
  orgName: string | undefined,
  step: number,
) {
  const { env } = await import("../server/env");
  const site = env.PUBLIC_SITE_URL.replace(/\/$/, "");
  // An interviewer without an account scores through their private link.
  const { linkPanelist, issueScorecardLink } = await import("./panelist-links.server");
  const p = await linkPanelist(orgId, email);
  const url =
    p && r.scheduledAt
      ? `${site}/scorecard/${await issueScorecardLink(orgId, r.id, p.id, r.scheduledAt)}`
      : `${site}/interviews/mine`;
  const { enqueueEmail } = await import("./email-outbox.server");
  await enqueueEmail({
    orgId,
    kind: "member_reminder",
    templateName: "member_reminder",
    toEmail: email,
    applicationId: r.applicationId,
    idempotencyKey: `scorecard-chase:${r.id}:${email}:${step}`,
    templateData: {
      memberName: name,
      orgName,
      heading:
        step === 1
          ? `Your L${r.level} scorecard for ${cand}`
          : `Overdue: your L${r.level} scorecard for ${cand}`,
      message:
        step === 1
          ? `Please submit your scorecard within ${SCORECARD_DUE.dueHours} hours — ${cand} cannot move on until the panel has scored.`
          : `${cand} is waiting on your scorecard and cannot move on until it is in. It takes a few minutes.`,
      actionUrl: url,
    },
  });
}
