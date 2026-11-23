/**
 * Pre-interview reminders. Run by the agent tick (every minute): for every
 * booked round (scheduled / rescheduled) the candidate and each panelist get
 *   ~24 h before → "tomorrow" reminder;
 *   ~1 h before  → "starting soon" reminder.
 * Each reminder is sent once: the outbox idempotency key carries the round's
 * start time, so a reschedule re-arms both. A round booked inside a window
 * only gets the later reminder that still applies (no burst right after the
 * invite), and the day reminder is skipped when the round was booked less
 * than a few hours ago (the invite has just gone out).
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../server/db";
import { applications, candidates, interviews, organizations, requisitions } from "@db/schema";

export const REMINDER_WINDOWS = { dayHours: 24, soonHours: 1, freshBookingHours: 3 } as const;
const HOUR = 3600_000;

export type ReminderStep = "day" | "soon";

/**
 * Which reminder a round `hoursUntil` from now is due (pure). `null` when it
 * has started or is further out than a day. `hoursSinceBooked` suppresses the
 * day reminder right after the invite.
 */
export function reminderStep(hoursUntil: number, hoursSinceBooked = Infinity): ReminderStep | null {
  if (hoursUntil <= 0) return null;
  if (hoursUntil <= REMINDER_WINDOWS.soonHours) return "soon";
  if (hoursUntil <= REMINDER_WINDOWS.dayHours) {
    return hoursSinceBooked < REMINDER_WINDOWS.freshBookingHours ? null : "day";
  }
  return null;
}

/** Idempotency key for one reminder (start time included so a reschedule re-arms). */
export function reminderKey(
  interviewId: string,
  scheduledAt: Date,
  email: string,
  step: ReminderStep,
): string {
  return `interview-reminder:${interviewId}:${scheduledAt.toISOString()}:${email.toLowerCase()}:${step}`;
}

export async function sweepInterviewReminders(orgId?: string, now = Date.now()): Promise<number> {
  const rounds = await db
    .select({
      id: interviews.id,
      orgId: interviews.orgId,
      applicationId: interviews.applicationId,
      level: interviews.level,
      scheduledAt: interviews.scheduledAt,
      durationMins: interviews.durationMins,
      mode: interviews.mode,
      link: interviews.teamsLink,
      lead: interviews.interviewerEmail,
      leadName: interviews.interviewer,
      panel: interviews.panel,
      unavailable: interviews.unavailable,
      createdAt: interviews.createdAt,
      candidateName: candidates.fullName,
      candidateEmail: candidates.email,
      stage: applications.stage,
      jobTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(interviews)
    .innerJoin(
      applications,
      and(eq(applications.id, interviews.applicationId), eq(applications.orgId, interviews.orgId)),
    )
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, interviews.orgId))
    .where(
      and(
        orgId ? eq(interviews.orgId, orgId) : sql`true`,
        inArray(interviews.status, ["scheduled", "rescheduled"]),
        sql`${interviews.scheduledAt} > ${new Date(now).toISOString()}::timestamptz`,
        sql`${interviews.scheduledAt} <= ${new Date(now + REMINDER_WINDOWS.dayHours * HOUR).toISOString()}::timestamptz`,
      ),
    )
    .limit(500);

  const { enqueueEmail, formatInOrgTZ, getOrgEmailSettings } =
    await import("./email-outbox.server");
  const { interviewWith } = await import("./interview-with");
  const { env } = await import("../server/env");
  const site = env.PUBLIC_SITE_URL.replace(/\/$/, "");
  const tzByOrg = new Map<string, string>();
  let sent = 0;

  for (const r of rounds) {
    if (!r.orgId || !r.scheduledAt) continue;
    if (r.stage === "rejected" || r.stage === "withdrawn") continue;
    const step = reminderStep(
      (r.scheduledAt.getTime() - now) / HOUR,
      r.createdAt ? (now - r.createdAt.getTime()) / HOUR : Infinity,
    );
    if (!step) continue;
    try {
      let tz = tzByOrg.get(r.orgId);
      if (!tz) {
        tz = (await getOrgEmailSettings(r.orgId)).timezone;
        tzByOrg.set(r.orgId, tz);
      }
      const away = new Set((r.unavailable ?? []).map((u) => u.email.toLowerCase()));
      const panel = [
        ...(r.lead ? [{ email: r.lead, name: r.leadName }] : []),
        ...(r.panel ?? []).map((p) => ({ email: p.email, name: p.name })),
      ]
        .map((p) => ({ ...p, email: p.email.trim().toLowerCase() }))
        .filter(
          (p, i, all) =>
            p.email && !away.has(p.email) && all.findIndex((x) => x.email === p.email) === i,
        );
      const common = {
        orgName: r.orgName,
        jobTitle: r.jobTitle,
        candidateName: r.candidateName ?? undefined,
        roundLabel: `L${r.level} interview`,
        scheduledAtText: formatInOrgTZ(r.scheduledAt, tz),
        durationMins: String(r.durationMins),
        modeLabel: r.mode === "online" ? "Online" : r.mode === "onsite" ? "Onsite" : "Phone",
        whereText: r.link?.trim() || undefined,
        step,
      };

      if (r.candidateEmail) {
        await enqueueEmail({
          orgId: r.orgId,
          kind: "interview_reminder",
          templateName: "interview_reminder",
          toEmail: r.candidateEmail,
          applicationId: r.applicationId,
          idempotencyKey: reminderKey(r.id, r.scheduledAt, r.candidateEmail, step),
          templateData: {
            ...common,
            audience: "candidate",
            recipientName: r.candidateName ?? undefined,
            withText: interviewWith(panel.length),
          },
        });
        sent++;
      }
      for (const p of panel) {
        await enqueueEmail({
          orgId: r.orgId,
          kind: "interviewer_reminder",
          templateName: "interview_reminder",
          toEmail: p.email,
          applicationId: r.applicationId,
          idempotencyKey: reminderKey(r.id, r.scheduledAt, p.email, step),
          templateData: {
            ...common,
            audience: "panel",
            recipientName: p.name ?? undefined,
            actionUrl: `${site}/interviews/mine`,
          },
        });
        sent++;
      }
    } catch {
      /* one round never stops the sweep */
    }
  }
  return sent;
}
