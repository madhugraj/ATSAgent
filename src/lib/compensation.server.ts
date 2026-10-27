/**
 * Compensation and availability (docs/agentic-plan.md §4.5, §4.8): what an
 * offer is built on, collected at screening — never guessed at offer time.
 *
 *   send_compensation_form (Screening / Offer agent, or TA by hand)
 *     ─▶ private /pay/<token> link, same timeline as written assessments
 *        (due date, reminders, overdue, link closes)
 *     ─▶ candidate submits ─▶ compensation_details (source candidate_form)
 *        ─▶ compensation.submitted ─▶ the Offer agent continues if it waits
 *   TA / HR may also enter the details from a call (source screening_call).
 *
 * Amounts are rupees. The detail is visible to TA, HR head, CBO and owners
 * only; thread messages never carry amounts.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import {
  applications,
  candidates,
  compensationDetails,
  compensationRequests,
  organizations,
  requisitions,
  type CompensationSource,
} from "@db/schema";

/** Roles that may see and enter a candidate's pay (owners pass assertRole). */
export const PAY_ROLES = ["recruiter", "hr_head", "president_cbo"] as const;

/** Stages at which asking about pay makes sense: screening through offer. */
type Stage = (typeof applications.stage.enumValues)[number];
const PAY_STAGE_LIST: Stage[] = [
  "shortlisted",
  "l1",
  "l2",
  "l3",
  "offer_pending",
  "on_hold",
  "reserve",
];
export const PAY_STAGES = new Set<string>(PAY_STAGE_LIST);

const MAX_RUPEES = 500_000_000; // ₹50 crore — anything above is a typo.
const DAY = 864e5;

const money = z.number().finite().min(0).max(MAX_RUPEES);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Fields shared by the candidate's form and a person's entry. */
export const CompensationFields = z.object({
  currentFixed: money.nullable().optional(),
  currentVariable: money.nullable().optional(),
  expectedCtc: money.positive().nullable().optional(),
  noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),
  earliestJoining: isoDate.nullable().optional(),
  competingOffers: z.boolean().nullable().optional(),
  competingNote: z.string().trim().max(500).nullable().optional(),
  currentLocation: z.string().trim().max(120).nullable().optional(),
  openToRelocate: z.boolean().nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type CompensationInput = z.infer<typeof CompensationFields>;

/** The candidate's form: expected CTC and notice period are required, consent is explicit. */
export const CandidateCompensationForm = CompensationFields.extend({
  expectedCtc: money.positive(),
  noticePeriodDays: z.number().int().min(0).max(365),
  consent: z.literal(true),
});

/** Earliest joining must be today or later and within a year (pure; unit-tested). */
export function joiningDateProblem(
  date: string | null | undefined,
  now = new Date(),
): string | null {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return "That joining date is not a real date.";
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  // A day of slack either way for time zones.
  if (t < today - DAY) return "The joining date is in the past.";
  if (t > today + 366 * DAY) return "Pick a joining date within the next year.";
  return null;
}

/* ------------------------------------------------------------ reading */

export type CompensationView = {
  currentFixed: number | null;
  currentVariable: number | null;
  /** Fixed + variable, or the profile's current CTC when no split is known. */
  currentTotal: number | null;
  expectedCtc: number | null;
  noticePeriodDays: number | null;
  earliestJoining: string | null;
  competingOffers: boolean | null;
  competingNote: string | null;
  currentLocation: string | null;
  openToRelocate: boolean | null;
  note: string | null;
  /** Where the expected CTC came from. */
  source: CompensationSource | "candidate_profile" | null;
  updatedAt: string | null;
  /** Expected CTC and notice period are both known: an offer can be drafted. */
  complete: boolean;
  /**
   * The expected CTC comes only from the talent-pool profile — never given or
   * confirmed for this application (it may be from an earlier process). An
   * offer is not built on it until the candidate confirms it.
   */
  unconfirmed: boolean;
};

type DetailRow = typeof compensationDetails.$inferSelect;
const n = (v: string | number | null | undefined) => (v == null ? null : Number(v));

/**
 * Field by field, the latest value anyone recorded (pure; unit-tested): a
 * later entry of just the notice period does not erase the expected CTC.
 * Falls back to the candidate profile's figures.
 */
export function mergeCompensation(
  rows: DetailRow[],
  profile: {
    currentCtc: string | null;
    expectedCtc: string | null;
    noticePeriodDays: number | null;
  },
): CompensationView {
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const pick = <K extends keyof DetailRow>(k: K): DetailRow[K] | null =>
    sorted.find((r) => r[k] != null)?.[k] ?? null;
  const fixed = n(pick("currentFixed"));
  const variable = n(pick("currentVariable"));
  const expectedRow = sorted.find((r) => r.expectedCtc != null);
  const expected = n(expectedRow?.expectedCtc) ?? n(profile.expectedCtc);
  const notice = pick("noticePeriodDays") ?? profile.noticePeriodDays;
  const joining = pick("earliestJoining");
  return {
    currentFixed: fixed,
    currentVariable: variable,
    currentTotal:
      fixed != null || variable != null ? (fixed ?? 0) + (variable ?? 0) : n(profile.currentCtc),
    expectedCtc: expected,
    noticePeriodDays: notice,
    earliestJoining: joining ? String(joining) : null,
    competingOffers: pick("competingOffers"),
    competingNote: pick("competingNote"),
    currentLocation: pick("currentLocation"),
    openToRelocate: pick("openToRelocate"),
    note: pick("note"),
    source: expectedRow
      ? expectedRow.source
      : profile.expectedCtc != null
        ? "candidate_profile"
        : null,
    updatedAt: sorted[0]?.createdAt.toISOString() ?? null,
    complete: expected != null && notice != null,
    unconfirmed: !expectedRow && profile.expectedCtc != null,
  };
}

async function loadApp(orgId: string, applicationId: string) {
  const [a] = await db
    .select({
      id: applications.id,
      stage: applications.stage,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      name: candidates.fullName,
      email: candidates.email,
      currentCtc: candidates.currentCtc,
      expectedCtc: candidates.expectedCtc,
      noticePeriodDays: candidates.noticePeriodDays,
      jobTitle: requisitions.title,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!a) throw new Error("Application not found.");
  return a;
}

/** The compensation in force for one application (org-scoped). */
export async function detailsFor(orgId: string, applicationId: string): Promise<CompensationView> {
  const app = await loadApp(orgId, applicationId);
  const rows = await db
    .select()
    .from(compensationDetails)
    .where(
      and(
        eq(compensationDetails.orgId, orgId),
        eq(compensationDetails.applicationId, applicationId),
      ),
    )
    .orderBy(desc(compensationDetails.createdAt));
  return mergeCompensation(rows, app);
}

/** The latest form request for one application, if any (org-scoped). */
export async function latestRequest(orgId: string, applicationId: string) {
  const [r] = await db
    .select()
    .from(compensationRequests)
    .where(
      and(
        eq(compensationRequests.orgId, orgId),
        eq(compensationRequests.applicationId, applicationId),
      ),
    )
    .orderBy(desc(compensationRequests.createdAt))
    .limit(1);
  return r ?? null;
}

type RequestRow = typeof compensationRequests.$inferSelect;
const isOpen = (r: RequestRow | null, now = Date.now()) =>
  !!r && r.status === "sent" && (r.closesAt?.getTime() ?? Infinity) > now;

/* ------------------------------------------------------------ helpers */

async function orgInfo(orgId: string) {
  const [o] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  const settings = await getOrgEmailSettings(orgId);
  return { orgName: o?.name ?? "", timeZone: settings.timezone, settings };
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

const formUrl = async (token: string) => {
  const { env } = await import("../server/env");
  return `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/pay/${token}`;
};

async function emailForm(
  orgId: string,
  row: RequestRow,
  app: { name: string | null; email: string | null; jobTitle: string; id: string },
  reminder: number,
) {
  const { orgName, timeZone } = await orgInfo(orgId);
  const { dayText } = await import("./assessment-timeline.server");
  const { enqueueEmail } = await import("./email-outbox.server");
  await enqueueEmail({
    orgId,
    kind: "compensation_form",
    templateName: "compensation_form",
    toEmail: app.email!,
    applicationId: app.id,
    idempotencyKey: reminder ? `pay-reminder:${row.id}:${reminder}` : `pay:${row.id}`,
    templateData: {
      candidateName: app.name ?? undefined,
      orgName,
      jobTitle: app.jobTitle,
      formUrl: await formUrl(row.token),
      ...(row.dueAt ? { dueDate: `${dayText(row.dueAt, timeZone)} (end of day)` } : {}),
      ...(reminder ? { reminder: "yes" } : {}),
    },
  });
}

/* ------------------------------------------------------------ actions */

export type Actor = { userId: string | null; memberEmail: string | null; label?: string };

/**
 * Send the private form to the candidate. Idempotent: an open request is
 * returned as-is (no second email); details already known are not asked for
 * again. Due date and closing follow the organisation's assessment policy.
 */
export async function requestCompensation(
  orgId: string,
  applicationId: string,
  by: Actor,
  now = new Date(),
): Promise<{
  requestId: string;
  emailed: boolean;
  alreadyOpen: boolean;
  dueAt: string | null;
  closesAt: string | null;
  due: string | null;
}> {
  const app = await loadApp(orgId, applicationId);
  if (!PAY_STAGES.has(app.stage))
    throw new Error(
      `Pay details are asked for between screening and offer; this candidate is ${app.stage.replace(/_/g, " ")}.`,
    );
  if (!app.email) throw new Error("The candidate has no email address.");
  const { timeZone, settings } = await orgInfo(orgId);
  const { dayText, assessmentPolicyOf, timelineFor } = await import("./assessment-timeline.server");
  const open = await latestRequest(orgId, applicationId);
  if (isOpen(open, now.getTime()))
    return {
      requestId: open!.id,
      emailed: false,
      alreadyOpen: true,
      dueAt: open!.dueAt?.toISOString() ?? null,
      closesAt: open!.closesAt?.toISOString() ?? null,
      due: open!.dueAt ? dayText(open!.dueAt, timeZone) : null,
    };
  if (!settings.enabled || !settings.stageEnabled)
    throw new Error(
      "Candidate emails are turned off for this organisation, so the form cannot be sent. Enter the details from a call instead.",
    );
  const t = timelineFor(now, await assessmentPolicyOf(orgId), timeZone);
  const [row] = await db
    .insert(compensationRequests)
    .values({
      orgId,
      applicationId: app.id,
      candidateId: app.candidateId,
      token: crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""),
      status: "sent",
      dueAt: t.dueAt,
      closesAt: t.closesAt,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("The form could not be created.");
  await emailForm(orgId, row, app, 0);
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: by.label ?? by.memberEmail ?? "system:compensation",
    actorUserId: by.userId,
    orgId,
    action: "compensation.requested",
    entityType: "compensation_request",
    entityId: row.id,
    detail: { applicationId: app.id, dueAt: t.dueAt.toISOString() },
  });
  await tellThread(
    orgId,
    app.requisitionId,
    `${app.name ?? "The candidate"} was sent the pay & availability form (due ${dayText(t.dueAt, timeZone)}). Only TA and HR see the answers.`,
  );
  return {
    requestId: row.id,
    emailed: true,
    alreadyOpen: false,
    dueAt: t.dueAt.toISOString(),
    closesAt: t.closesAt.toISOString(),
    due: dayText(t.dueAt, timeZone),
  };
}

/** Record details, keep the candidate profile's headline figures in step. */
async function insertDetails(
  orgId: string,
  app: { id: string; candidateId: string },
  data: CompensationInput,
  source: CompensationSource,
  enteredBy: string | null,
  requestId: string | null,
) {
  const [row] = await db
    .insert(compensationDetails)
    .values({
      orgId,
      applicationId: app.id,
      candidateId: app.candidateId,
      currentFixed: data.currentFixed != null ? String(data.currentFixed) : null,
      currentVariable: data.currentVariable != null ? String(data.currentVariable) : null,
      expectedCtc: data.expectedCtc != null ? String(data.expectedCtc) : null,
      noticePeriodDays: data.noticePeriodDays ?? null,
      earliestJoining: data.earliestJoining ?? null,
      competingOffers: data.competingOffers ?? null,
      competingNote: data.competingNote || null,
      currentLocation: data.currentLocation || null,
      openToRelocate: data.openToRelocate ?? null,
      note: data.note || null,
      source,
      enteredBy,
      requestId,
    })
    .returning({ id: compensationDetails.id });
  const patch: Partial<typeof candidates.$inferInsert> = {};
  if (data.currentFixed != null || data.currentVariable != null)
    patch.currentCtc = String((data.currentFixed ?? 0) + (data.currentVariable ?? 0));
  if (data.expectedCtc != null) patch.expectedCtc = String(data.expectedCtc);
  if (data.noticePeriodDays != null) patch.noticePeriodDays = data.noticePeriodDays;
  if (Object.keys(patch).length)
    await db
      .update(candidates)
      .set(patch)
      .where(and(eq(candidates.id, app.candidateId), eq(candidates.orgId, orgId)));
  return row!.id;
}

async function announce(orgId: string, applicationId: string, actorUserId: string | null) {
  const { emitAgentEvent } = await import("../server/agents/events");
  await emitAgentEvent({
    orgId,
    type: "compensation.submitted",
    subjectType: "application",
    subjectId: applicationId,
    actorUserId,
    payload: { applicationId },
  });
}

/** Public: what the form shows behind a token (no amounts are ever sent back). */
export async function publicCompensationView(token: string, now = new Date()) {
  const [r] = await db
    .select({
      status: compensationRequests.status,
      dueAt: compensationRequests.dueAt,
      closesAt: compensationRequests.closesAt,
      orgId: compensationRequests.orgId,
      name: candidates.fullName,
      jobTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(compensationRequests)
    .innerJoin(candidates, eq(candidates.id, compensationRequests.candidateId))
    .innerJoin(applications, eq(applications.id, compensationRequests.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, compensationRequests.orgId))
    .where(eq(compensationRequests.token, token))
    .limit(1);
  if (!r) throw new Error("This link is not valid.");
  if (r.status === "completed")
    return {
      status: "completed" as const,
      candidateName: r.name,
      jobTitle: r.jobTitle,
      orgName: r.orgName,
      due: null,
    };
  if (r.status !== "sent" || (r.closesAt && r.closesAt.getTime() <= now.getTime()))
    throw new Error(
      "This link has closed. Reply to the hiring team's email if you still want to share your details.",
    );
  const { timeZone } = await orgInfo(r.orgId);
  const { dayText } = await import("./assessment-timeline.server");
  return {
    status: "sent" as const,
    candidateName: r.name,
    jobTitle: r.jobTitle,
    orgName: r.orgName,
    due: r.dueAt ? dayText(r.dueAt, timeZone) : null,
  };
}

/** Public: the candidate submits once. The status guard is in the UPDATE (no double submit). */
export async function submitCompensation(
  token: string,
  input: z.infer<typeof CandidateCompensationForm>,
  now = new Date(),
): Promise<{ ok: true }> {
  const data = CandidateCompensationForm.parse(input);
  const joining = joiningDateProblem(data.earliestJoining, now);
  if (joining) throw new Error(joining);
  const [r] = await db
    .select()
    .from(compensationRequests)
    .where(eq(compensationRequests.token, token))
    .limit(1);
  if (!r) throw new Error("This link is not valid.");
  if (r.status === "completed") throw new Error("You have already sent your details. Thank you.");
  if (r.status !== "sent" || (r.closesAt && r.closesAt.getTime() <= now.getTime()))
    throw new Error("This link has closed.");
  const claimed = await db
    .update(compensationRequests)
    .set({ status: "completed", completedAt: now })
    .where(and(eq(compensationRequests.id, r.id), eq(compensationRequests.status, "sent")))
    .returning({ id: compensationRequests.id });
  if (!claimed.length) throw new Error("You have already sent your details. Thank you.");
  const app = { id: r.applicationId, candidateId: r.candidateId };
  const { consent: _consent, ...fields } = data;
  const detailId = await insertDetails(r.orgId, app, fields, "candidate_form", null, r.id);
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `candidate:${r.candidateId}`,
    orgId: r.orgId,
    action: "compensation.submitted",
    entityType: "compensation_details",
    entityId: detailId,
    detail: { applicationId: r.applicationId, requestId: r.id, consent: true },
  });
  const a = await loadApp(r.orgId, r.applicationId);
  await tellThread(
    r.orgId,
    a.requisitionId,
    `${a.name ?? "The candidate"} shared their pay and availability. TA and HR can see it on the candidate's page.`,
  );
  await announce(r.orgId, r.applicationId, null);
  return { ok: true };
}

/**
 * TA / HR enter or correct details (e.g. from the screening call). Role-checked
 * and audited; closes an open form request once expected CTC and notice are known.
 */
export async function recordCompensation(
  actor: { orgId: string; userId: string; memberEmail: string },
  applicationId: string,
  input: CompensationInput,
  source: Exclude<CompensationSource, "candidate_form">,
  now = new Date(),
): Promise<{ ok: true; complete: boolean }> {
  const { assertRole } = await import("./auth.middleware");
  await assertRole(
    actor.userId,
    actor.orgId,
    [...PAY_ROLES],
    "Only TA, the HR head or the CBO can record a candidate's pay.",
  );
  const data = CompensationFields.parse(input);
  if (!Object.values(data).some((v) => v != null && v !== ""))
    throw new Error("Enter at least one detail.");
  const joining = joiningDateProblem(data.earliestJoining, now);
  if (joining) throw new Error(joining);
  const app = await loadApp(actor.orgId, applicationId);
  const detailId = await insertDetails(actor.orgId, app, data, source, actor.userId, null);
  const view = await detailsFor(actor.orgId, app.id);
  if (view.complete)
    await db
      .update(compensationRequests)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(compensationRequests.orgId, actor.orgId),
          eq(compensationRequests.applicationId, app.id),
          eq(compensationRequests.status, "sent"),
        ),
      );
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "compensation.recorded",
    entityType: "compensation_details",
    entityId: detailId,
    // Which fields changed — never the amounts.
    detail: {
      applicationId: app.id,
      source,
      fields: Object.keys(data).filter((k) => data[k as keyof typeof data] != null),
    },
  });
  await tellThread(
    actor.orgId,
    app.requisitionId,
    `${actor.memberEmail} recorded ${app.name ?? "the candidate"}'s pay and availability${source === "screening_call" ? " from the screening call" : ""}.`,
  );
  if (view.complete) await announce(actor.orgId, app.id, actor.userId);
  return { ok: true, complete: view.complete };
}

/**
 * What the AI screening call records here: the candidate's own figures for
 * current and expected pay, notice period and availability. The agent never
 * discusses, judges or negotiates them; only TA / HR see them.
 */
export const CallDetailsFields = z
  .object({
    currentFixed: money.nullable().optional(),
    currentVariable: money.nullable().optional(),
    expectedCtc: money.positive().nullable().optional(),
    noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),
    earliestJoining: isoDate.nullable().optional(),
    currentLocation: z.string().trim().max(120).nullable().optional(),
    openToRelocate: z.boolean().nullable().optional(),
    /** Pay said in words, not figures ("a 30% hike", "plus ₹10L in shares"). */
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export type CallDetails = z.infer<typeof CallDetailsFields>;

/**
 * The Screening call agent records what the candidate said about pay, notice
 * period and availability (source `screening_call`, entered by no person).
 * Audited with field names only — never the amounts.
 */
export async function recordCallDetails(
  orgId: string,
  applicationId: string,
  input: CallDetails,
  now = new Date(),
): Promise<{ recorded: string[] }> {
  const data = CallDetailsFields.parse(input);
  const fields = Object.keys(data).filter((k) => data[k as keyof typeof data] != null);
  if (!fields.length) return { recorded: [] };
  if (joiningDateProblem(data.earliestJoining, now)) delete data.earliestJoining;
  const app = await loadApp(orgId, applicationId);
  const detailId = await insertDetails(orgId, app, data, "screening_call", null, null);
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: "agent:screening_call",
    actorUserId: null,
    orgId,
    action: "compensation.recorded",
    entityType: "compensation_details",
    entityId: detailId,
    detail: { applicationId: app.id, source: "screening_call", fields },
  });
  // Expected CTC and notice now known: the open form is no longer needed, and
  // the Offer agent may proceed — as when TA records them.
  const view = await detailsFor(orgId, app.id);
  if (view.complete) {
    await db
      .update(compensationRequests)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(compensationRequests.orgId, orgId),
          eq(compensationRequests.applicationId, app.id),
          eq(compensationRequests.status, "sent"),
        ),
      );
    await tellThread(
      orgId,
      app.requisitionId,
      `${app.name ?? "The candidate"} gave their pay and availability on the AI screening call.`,
    );
    await announce(orgId, app.id, null);
  }
  return { recorded: fields };
}

/** Email the form again (counted; the same link). */
export async function remindCompensation(
  orgId: string,
  requestId: string,
  by: Actor,
  now = new Date(),
): Promise<{ sent: true }> {
  const [r] = await db
    .select()
    .from(compensationRequests)
    .where(and(eq(compensationRequests.id, requestId), eq(compensationRequests.orgId, orgId)))
    .limit(1);
  if (!r) throw new Error("That request is not here.");
  if (!isOpen(r, now.getTime())) throw new Error("This form is no longer open.");
  const app = await loadApp(orgId, r.applicationId);
  if (!app.email) throw new Error("The candidate has no email address.");
  const k = r.remindersSent + 1;
  await emailForm(orgId, r, app, k);
  await db
    .update(compensationRequests)
    .set({ remindersSent: k, lastRemindedAt: now })
    .where(eq(compensationRequests.id, r.id));
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: by.label ?? by.memberEmail ?? "system:compensation",
    actorUserId: by.userId,
    orgId,
    action: "compensation.reminded",
    entityType: "compensation_request",
    entityId: r.id,
    detail: { reminder: k },
  });
  return { sent: true };
}

/* ------------------------------------------------------------ sweep */

/** Whether reminders may go without asking: an agent that sends the form is Autonomous for it. */
export async function payRemindersAutomatic(orgId: string): Promise<boolean> {
  const { loadPolicy, decideToolCall } = await import("../server/agents/policy");
  for (const agent of ["screening", "offer"] as const) {
    const p = await loadPolicy(orgId, agent);
    if (p.enabled && decideToolCall("external", p, "compensation_form") === "run") return true;
  }
  return false;
}

export type PaySweepCounts = {
  reminded: number;
  overdue: number;
  closed: number;
  reminderDue: number;
};

/** Reminders, the overdue flag and closing — the assessment policy's timeline. */
export async function runCompensationSweep(
  orgId?: string,
  now = new Date(),
): Promise<PaySweepCounts> {
  const counts: PaySweepCounts = { reminded: 0, overdue: 0, closed: 0, reminderDue: 0 };
  const { nextStep, assessmentPolicyOf } = await import("./assessment-timeline.server");
  const rows = await db
    .select()
    .from(compensationRequests)
    .where(
      and(
        eq(compensationRequests.status, "sent"),
        orgId ? eq(compensationRequests.orgId, orgId) : undefined,
      ),
    );
  const auto = new Map<string, boolean>();
  for (const r of rows) {
    const { timeZone } = await orgInfo(r.orgId);
    const policy = await assessmentPolicyOf(r.orgId);
    const step = nextStep(
      {
        sentAt: r.createdAt,
        dueAt: r.dueAt ?? new Date(r.createdAt.getTime() + 3 * DAY),
        closesAt: r.closesAt ?? new Date(r.createdAt.getTime() + 7 * DAY),
        remindersSent: r.remindersSent,
        lastRemindedAt: r.lastRemindedAt,
        // Overdue is tracked by the nudge, not a column: flag it once, on the day.
        overdueAt: null,
      },
      policy,
      now,
      timeZone,
    );
    if (step === "close") {
      const done = await db
        .update(compensationRequests)
        .set({ status: "expired" })
        .where(and(eq(compensationRequests.id, r.id), eq(compensationRequests.status, "sent")))
        .returning({ id: compensationRequests.id });
      if (done.length) {
        counts.closed++;
        const app = await loadApp(r.orgId, r.applicationId);
        await tellThread(
          r.orgId,
          app.requisitionId,
          `${app.name ?? "The candidate"} did not fill in the pay & availability form, so the link has closed. Ask them on a call and enter it on their page, or send a new form.`,
        );
      }
    } else if (step === "remind") {
      if (!auto.has(r.orgId)) auto.set(r.orgId, await payRemindersAutomatic(r.orgId));
      if (auto.get(r.orgId)) {
        try {
          await remindCompensation(r.orgId, r.id, { userId: null, memberEmail: null }, now);
          counts.reminded++;
        } catch {
          /* no email address: the overdue nudge asks a person */
        }
      } else counts.reminderDue++;
    } else if (step === "overdue") counts.overdue++;
  }
  return counts;
}

/** Whether this open request is past due by the policy's overdue margin (for the nudge). */
export function payOverdue(
  r: Pick<RequestRow, "dueAt" | "createdAt">,
  overdueAfterDays: number,
  now = new Date(),
): boolean {
  const due = r.dueAt ?? new Date(r.createdAt.getTime() + 3 * DAY);
  return now.getTime() >= due.getTime() + overdueAfterDays * DAY;
}

/** Open requests for an org (for nudges). */
export async function openPayRequests(orgId: string, now = new Date()) {
  return db
    .select({
      r: compensationRequests,
      name: candidates.fullName,
      stage: applications.stage,
    })
    .from(compensationRequests)
    .innerJoin(candidates, eq(candidates.id, compensationRequests.candidateId))
    .innerJoin(applications, eq(applications.id, compensationRequests.applicationId))
    .where(
      and(
        eq(compensationRequests.orgId, orgId),
        eq(compensationRequests.status, "sent"),
        inArray(applications.stage, PAY_STAGE_LIST),
        sql`coalesce(${compensationRequests.closesAt}, ${now.toISOString()}::timestamptz + interval '1 day') > ${now.toISOString()}::timestamptz`,
      ),
    );
}

/**
 * What an offer still lacks before it may go to approvers, be approved or be
 * released (or before pre-onboarding documents are asked for): the
 * candidate's expected CTC and notice period, and the offer's joining date.
 * Empty when the terms are settled. Org-scoped.
 */
export async function offerTermsMissing(
  orgId: string,
  applicationId: string,
  joiningDate: string | null,
): Promise<string[]> {
  const pay = await detailsFor(orgId, applicationId);
  return [
    pay.expectedCtc == null ? "the candidate's expected CTC" : null,
    pay.noticePeriodDays == null ? "their notice period" : null,
    joiningDate ? null : "a joining date on the offer",
  ].filter((x): x is string => x !== null);
}

/** "a, b and c". */
export const listWords = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
