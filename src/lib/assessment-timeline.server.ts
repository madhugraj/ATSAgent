/**
 * Written-assessment timeline (docs/agentic-plan.md §4.5): one policy per
 * organisation decides what the candidate is told and what happens next, so
 * the date in the invitation, the reminders, the overdue flag and the link's
 * closing never disagree.
 *
 *   sent ─▶ reminder (after first_reminder_days) ─▶ due (end of the n-th working
 *   day, final reminder) ─▶ overdue (due + overdue_after_days: the people
 *   deciding are told and offered extend / phone screen / decide without)
 *   ─▶ link closes (close_after_days after sending)
 *
 * Submitting grades the answers and raises assessment.completed: the Screening
 * agent gives its recommendation and a person decides who moves on.
 */
import { and, eq, isNull, lte, sql } from "drizzle-orm";

import { db } from "../server/db";
import { assessmentSettings, candidateAssessments } from "@db/schema";
import { wallDate, zonedTime } from "./calendar-availability.server";

export type AssessmentPolicy = {
  dueWorkingDays: number;
  firstReminderDays: number;
  maxReminders: number;
  overdueAfterDays: number;
  closeAfterDays: number;
};

export const DEFAULT_ASSESSMENT_POLICY: AssessmentPolicy = {
  dueWorkingDays: 3,
  firstReminderDays: 2,
  maxReminders: 2,
  overdueAfterDays: 2,
  closeAfterDays: 7,
};

export async function assessmentPolicyOf(orgId: string): Promise<AssessmentPolicy> {
  const [r] = await db
    .select()
    .from(assessmentSettings)
    .where(eq(assessmentSettings.orgId, orgId))
    .limit(1);
  return r
    ? {
        dueWorkingDays: r.dueWorkingDays,
        firstReminderDays: r.firstReminderDays,
        maxReminders: r.maxReminders,
        overdueAfterDays: r.overdueAfterDays,
        closeAfterDays: r.closeAfterDays,
      }
    : DEFAULT_ASSESSMENT_POLICY;
}

/* ------------------------------------------------------------ pure date maths */

const DAY = 864e5;

/** End (23:59 local) of the n-th working day (Mon–Fri) after `from`, in a time zone. */
export function dueAfterWorkingDays(from: Date, n: number, timeZone: string): Date {
  let at = from.getTime();
  let left = n;
  while (left > 0) {
    at += DAY;
    const { wd } = wallDate(at, timeZone);
    if (wd !== 0 && wd !== 6) left--;
  }
  const { y, m, d } = wallDate(at, timeZone);
  return new Date(zonedTime(y, m, d, 23, 59, timeZone));
}

/** Due and closing time for an assessment sent at `sentAt`. Closing is never before due. */
export function timelineFor(
  sentAt: Date,
  policy: AssessmentPolicy,
  timeZone: string,
): { dueAt: Date; closesAt: Date } {
  const dueAt = dueAfterWorkingDays(sentAt, policy.dueWorkingDays, timeZone);
  const closesAt = new Date(
    Math.max(sentAt.getTime() + policy.closeAfterDays * DAY, dueAt.getTime() + DAY),
  );
  return { dueAt, closesAt };
}

export type TimelineState = {
  sentAt: Date;
  dueAt: Date;
  closesAt: Date;
  remindersSent: number;
  lastRemindedAt: Date | null;
  overdueAt: Date | null;
};

/**
 * What is due now for one open assessment (pure; unit-tested). Reminders: the
 * first after `firstReminderDays`, the next on the due day; never more than
 * `maxReminders`, never twice within 20 hours, and only on working days.
 */
export function nextStep(
  s: TimelineState,
  policy: AssessmentPolicy,
  now: Date,
  timeZone: string,
): "close" | "overdue" | "remind" | null {
  const t = now.getTime();
  if (t >= s.closesAt.getTime()) return "close";
  if (!s.overdueAt && t >= s.dueAt.getTime() + policy.overdueAfterDays * DAY) return "overdue";
  const cooled = !s.lastRemindedAt || t - s.lastRemindedAt.getTime() >= 20 * 3600_000;
  // Reminders go out on working days only (the weekend one waits for Monday).
  const { wd } = wallDate(t, timeZone);
  const workingDay = wd !== 0 && wd !== 6;
  if (s.remindersSent < policy.maxReminders && cooled && workingDay) {
    const firstDue = s.sentAt.getTime() + policy.firstReminderDays * DAY;
    // The due day starts at local midnight-ish: remind once it is the due date.
    const dueDay = s.dueAt.getTime() - DAY + 60_000;
    if (s.remindersSent === 0 && t >= firstDue && t < s.dueAt.getTime()) return "remind";
    if (s.remindersSent >= 1 && t >= dueDay && t < s.dueAt.getTime()) return "remind";
  }
  return null;
}

/** Human date for emails and pop-ups, in the organisation's time zone. */
export function dayText(d: Date, timeZone: string): string {
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  });
}

/** Open assessments with anything to do (for the sweep). */
export async function openAssessments(orgId?: string) {
  return db
    .select()
    .from(candidateAssessments)
    .where(
      and(
        eq(candidateAssessments.status, "sent"),
        isNull(candidateAssessments.completedAt),
        orgId ? eq(candidateAssessments.orgId, orgId) : undefined,
        lte(candidateAssessments.createdAt, sql`now()`),
      ),
    );
}

/* ------------------------------------------------------------ actions */

type Row = typeof candidateAssessments.$inferSelect;

async function context(row: Row) {
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  const { candidates, requisitions, organizations } = await import("@db/schema");
  const [c] = await db
    .select({ name: candidates.fullName, email: candidates.email })
    .from(candidates)
    .where(eq(candidates.id, row.candidateId))
    .limit(1);
  const [r] = row.requisitionId
    ? await db
        .select({ title: requisitions.title })
        .from(requisitions)
        .where(eq(requisitions.id, row.requisitionId))
        .limit(1)
    : [];
  const [o] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, row.orgId!))
    .limit(1);
  return {
    name: c?.name ?? "The candidate",
    email: c?.email ?? null,
    jobTitle: r?.title ?? "the role",
    orgName: o?.name ?? "",
    timeZone: (await getOrgEmailSettings(row.orgId!)).timezone,
  };
}

async function tellThread(orgId: string, requisitionId: string | null, body: string) {
  if (!requisitionId) return;
  try {
    const desk = await import("../server/desk/desk.server");
    const conv = await desk.conversationForRequisition(orgId, requisitionId);
    if (conv) await desk.postMessage(conv, { role: "desk", body });
  } catch {
    /* the record and audit stand without the thread */
  }
}

async function loadRow(orgId: string, assessmentId: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(candidateAssessments)
    .where(and(eq(candidateAssessments.id, assessmentId), eq(candidateAssessments.orgId, orgId)))
    .limit(1);
  if (!row) throw new Error("That assessment is not here.");
  return row;
}

/** Email the candidate a reminder (with the date it is due) and count it. */
export async function sendAssessmentReminder(
  orgId: string,
  assessmentId: string,
  by: { userId: string | null; memberEmail: string | null },
): Promise<{ sent: boolean }> {
  const row = await loadRow(orgId, assessmentId);
  if (row.status !== "sent") throw new Error("This assessment is no longer open.");
  const ctx = await context(row);
  if (!ctx.email) throw new Error("The candidate has no email address.");
  const { env } = await import("../server/env");
  const { enqueueEmail } = await import("./email-outbox.server");
  const n = row.remindersSent + 1;
  await enqueueEmail({
    orgId,
    kind: "assessment_invite",
    templateName: "assessment_invite",
    toEmail: ctx.email,
    applicationId: row.applicationId ?? null,
    idempotencyKey: `assessment-reminder:${row.id}:${n}`,
    templateData: {
      candidateName: ctx.name,
      orgName: ctx.orgName,
      jobTitle: ctx.jobTitle,
      assessmentUrl: `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/assess/${row.token}`,
      ...(row.dueAt ? { dueDate: `${dayText(row.dueAt, ctx.timeZone)} (end of day)` } : {}),
      reminder: "yes",
    },
  });
  await db
    .update(candidateAssessments)
    .set({ remindersSent: n, lastRemindedAt: new Date() })
    .where(eq(candidateAssessments.id, row.id));
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: by.memberEmail ?? "system:assessment-timeline",
    actorUserId: by.userId,
    orgId,
    action: "assessment.reminded",
    entityType: "candidate_assessment",
    entityId: row.id,
    detail: { reminder: n },
  });
  return { sent: true };
}

/** A person moves the due date (and keeps the link open past it). */
export async function extendAssessment(
  actor: { orgId: string; userId: string; memberEmail: string },
  input: { assessmentId: string; dueDate: string; notify: boolean },
): Promise<{ dueAt: string }> {
  const row = await loadRow(actor.orgId, input.assessmentId);
  if (row.status !== "sent") throw new Error("This assessment is no longer open.");
  const ctx = await context(row);
  const [y, m, d] = input.dueDate.split("-").map(Number) as [number, number, number];
  const dueAt = new Date(zonedTime(y, m - 1, d, 23, 59, ctx.timeZone));
  if (dueAt.getTime() <= Date.now()) throw new Error("Pick a date in the future.");
  if (dueAt.getTime() > Date.now() + 30 * DAY) throw new Error("Pick a date within 30 days.");
  const closesAt = new Date(Math.max(row.closesAt?.getTime() ?? 0, dueAt.getTime() + DAY));
  await db
    .update(candidateAssessments)
    .set({ dueAt, closesAt, overdueAt: null, remindersSent: 0, lastRemindedAt: null })
    .where(eq(candidateAssessments.id, row.id));
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "assessment.extended",
    entityType: "candidate_assessment",
    entityId: row.id,
    detail: { from: row.dueAt?.toISOString() ?? null, to: dueAt.toISOString() },
  });
  if (input.notify)
    await sendAssessmentReminder(actor.orgId, row.id, {
      userId: actor.userId,
      memberEmail: actor.memberEmail,
    });
  await tellThread(
    actor.orgId,
    row.requisitionId,
    `${actor.memberEmail} gave ${ctx.name} until ${dayText(dueAt, ctx.timeZone)} for the written assessment${input.notify ? " and told them" : ""}.`,
  );
  return { dueAt: dueAt.toISOString() };
}

/** A person goes on without the written assessment (phone screen, or decide without). */
export async function waiveAssessment(
  actor: { orgId: string; userId: string; memberEmail: string },
  input: { assessmentId: string; mode: "phone_screen" | "decide_without"; reason: string },
): Promise<{ ok: true }> {
  const row = await loadRow(actor.orgId, input.assessmentId);
  if (row.status !== "sent") throw new Error("This assessment is no longer open.");
  const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 500);
  if (reason.length < 3) throw new Error("Say why, so the team and the record know.");
  const label =
    input.mode === "phone_screen" ? "Screening by phone instead" : "Deciding without it";
  await db
    .update(candidateAssessments)
    .set({ status: "waived", waivedReason: `${label}: ${reason}` })
    .where(and(eq(candidateAssessments.id, row.id), eq(candidateAssessments.status, "sent")));
  const ctx = await context(row);
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "assessment.waived",
    entityType: "candidate_assessment",
    entityId: row.id,
    detail: { mode: input.mode, reason },
  });
  if (row.candidateId) {
    const { addCandidateNoteCore } = await import("./pipeline.server");
    await addCandidateNoteCore(actor, {
      candidateId: row.candidateId,
      body: `Written assessment: ${label.toLowerCase()} — ${reason}`,
    });
  }
  await tellThread(
    actor.orgId,
    row.requisitionId,
    `${actor.memberEmail}: ${label.toLowerCase()} for ${ctx.name} — "${reason}". The link is closed.`,
  );
  return { ok: true };
}

/* ------------------------------------------------------------ events and sweep */

/** The candidate submitted: tell the thread and start the Screening agent. */
export async function onAssessmentCompleted(a: {
  orgId: string;
  assessmentId: string;
  candidateId: string;
  requisitionId: string | null;
  applicationId: string | null;
  score: number | null;
}): Promise<void> {
  try {
    const row = await loadRow(a.orgId, a.assessmentId);
    const ctx = await context(row);
    await tellThread(
      a.orgId,
      a.requisitionId,
      `${ctx.name} completed the written assessment${a.score != null ? ` (${a.score}/100)` : ""}. The screening-call questions are being refreshed to build on it, and the Screening agent is writing its recommendation; you decide who moves to an interview round.`,
    );
    // The screening-call kit now builds on the written result: no repeats,
    // the weakest areas and open CV inferences are what the call probes.
    if (a.requisitionId) {
      try {
        const { withAiSubject } = await import("../server/agents/context");
        const { prepareScreeningKitForPairing } = await import("./screening.functions");
        await withAiSubject(
          {
            requisitionId: a.requisitionId,
            applicationId: a.applicationId,
            candidateId: a.candidateId,
          },
          () =>
            prepareScreeningKitForPairing({
              orgId: a.orgId,
              candidateId: a.candidateId,
              requisitionId: a.requisitionId!,
              createdBy: null,
            }),
        );
      } catch (err) {
        const { log } = await import("../server/log");
        log.warn("assessment.kit_refresh_failed", { error: err as Error });
      }
    }
    if (a.applicationId) {
      const { emitAgentEvent } = await import("../server/agents/events");
      await emitAgentEvent({
        orgId: a.orgId,
        type: "assessment.completed",
        subjectType: "application",
        subjectId: a.applicationId,
        actorUserId: null,
        payload: { applicationId: a.applicationId, assessmentId: a.assessmentId, score: a.score },
      });
    }
  } catch (err) {
    const { log } = await import("../server/log");
    log.warn("assessment.completed_followup_failed", { error: err as Error });
  }
}

/** Whether the Screening agent may email reminders without asking (its autonomy). */
async function remindersAutomatic(orgId: string): Promise<boolean> {
  const { loadPolicy, decideToolCall } = await import("../server/agents/policy");
  const p = await loadPolicy(orgId, "screening");
  return p.enabled && decideToolCall("external", p, "assessment_invite") === "run";
}

export type SweepCounts = {
  reminded: number;
  overdue: number;
  closed: number;
  reminderDue: number;
};

/**
 * Daily (and on every scheduler tick): send due reminders, flag overdue
 * assessments to the people deciding, and close links that ran out.
 */
export async function runAssessmentSweep(orgId?: string, now = new Date()): Promise<SweepCounts> {
  const counts: SweepCounts = { reminded: 0, overdue: 0, closed: 0, reminderDue: 0 };
  const auto = new Map<string, boolean>();
  for (const row of await openAssessments(orgId)) {
    if (!row.orgId) continue;
    const policy = await assessmentPolicyOf(row.orgId);
    const ctx = await context(row);
    const step = nextStep(
      {
        sentAt: row.createdAt,
        dueAt: row.dueAt ?? new Date(row.createdAt.getTime() + 3 * DAY),
        closesAt: row.closesAt ?? new Date(row.createdAt.getTime() + 14 * DAY),
        remindersSent: row.remindersSent,
        lastRemindedAt: row.lastRemindedAt,
        overdueAt: row.overdueAt,
      },
      policy,
      now,
      ctx.timeZone,
    );
    if (step === "close") {
      const done = await db
        .update(candidateAssessments)
        .set({ status: "expired" })
        .where(and(eq(candidateAssessments.id, row.id), eq(candidateAssessments.status, "sent")))
        .returning({ id: candidateAssessments.id });
      if (done.length) {
        counts.closed++;
        await tellThread(
          row.orgId,
          row.requisitionId,
          `${ctx.name} did not complete the written assessment, so the link has closed. Send a new one, screen them by phone, or decide without it.`,
        );
      }
    } else if (step === "overdue") {
      await db
        .update(candidateAssessments)
        .set({ overdueAt: now })
        .where(eq(candidateAssessments.id, row.id));
      counts.overdue++;
      await tellThread(
        row.orgId,
        row.requisitionId,
        `${ctx.name}'s written assessment is overdue (it was due ${row.dueAt ? dayText(row.dueAt, ctx.timeZone) : "earlier"}; the link closes ${row.closesAt ? dayText(row.closesAt, ctx.timeZone) : "soon"}). Extend it, screen them by phone, or decide without it — from the pop-up or the candidate's page.`,
      );
    } else if (step === "remind") {
      if (!auto.has(row.orgId)) auto.set(row.orgId, await remindersAutomatic(row.orgId));
      if (auto.get(row.orgId) && ctx.email) {
        await sendAssessmentReminder(row.orgId, row.id, { userId: null, memberEmail: null });
        counts.reminded++;
      } else counts.reminderDue++; // a person is offered "Send reminder" in the pop-up
    }
  }
  return counts;
}

/** Whether a reminder is due now for this assessment (for the pop-up when reminders are not automatic). */
export function reminderDue(
  row: Row,
  policy: AssessmentPolicy,
  now: Date,
  timeZone: string,
): boolean {
  return (
    nextStep(
      {
        sentAt: row.createdAt,
        dueAt: row.dueAt ?? new Date(row.createdAt.getTime() + 3 * DAY),
        closesAt: row.closesAt ?? new Date(row.createdAt.getTime() + 14 * DAY),
        remindersSent: row.remindersSent,
        lastRemindedAt: row.lastRemindedAt,
        overdueAt: row.overdueAt,
      },
      policy,
      now,
      timeZone,
    ) === "remind"
  );
}
