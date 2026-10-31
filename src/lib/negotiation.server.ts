/**
 * Agreeing the figure with a candidate before the offer (docs/agentic-plan.md
 * §4.8), when their expected CTC is above what the organisation will pay.
 *
 *   Offer agent: the HR head sets a ceiling (the CBO too when it is above the
 *   band) ─▶ propose_negotiation: proposed figure ≤ ceiling, levers (joining
 *   bonus, early review, split / ESOPs), a talk track for a call, a draft
 *   message ─▶ open (TA sees the brief and may call)
 *   ─▶ send_negotiation_message: a person ALWAYS approves (and may edit) the
 *   exact words, whatever the agent's autonomy ─▶ message_sent, private
 *   /negotiate/<token> link: accept · propose another figure · ask for a call
 *   ─▶ agreed (raises negotiation.agreed: the Offer agent drafts at that figure)
 *      | countered / call_requested (a pop-up asks TA / HR to talk to them)
 *   TA may record a call's outcome at any point (agreed ≤ ceiling, or not).
 *   No answer by the closing date ─▶ expired: the HR head raises the ceiling,
 *   calls, or stops.
 *
 * Amounts stay with TA, the HR head, the CBO and owners: thread messages,
 * nudges and audit entries never carry them.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import {
  agentTasks,
  applications,
  candidates,
  offerNegotiations,
  organizations,
  requisitions,
  type NegotiationLevers,
  type NegotiationStatus,
} from "@db/schema";
import { rupees } from "./money";

const MAX_RUPEES = 500_000_000;
const DAY = 864e5;
export const OPEN_NEGOTIATION: NegotiationStatus[] = [
  "open",
  "message_sent",
  "countered",
  "call_requested",
];

/** An AI negotiation call may follow up these (a closed link too: the call reaches a non-responder). */
export const CALLABLE_NEGOTIATION: NegotiationStatus[] = [...OPEN_NEGOTIATION, "expired"];

type Row = typeof offerNegotiations.$inferSelect;
const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

/** A person with one of `roles` answered this run's question (the task system checked the role). */
export async function answeredInRun(runId: string, roles: string[]): Promise<boolean> {
  const [t] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.runId, runId),
        eq(agentTasks.kind, "clarification"),
        eq(agentTasks.status, "answered"),
        inArray(agentTasks.assigneeRole, roles as never[]),
      ),
    )
    .limit(1);
  return !!t;
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
      jobTitle: requisitions.title,
      bandMax: requisitions.ctcBandMax,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!a) throw new Error("Application not found.");
  return a;
}

/** The latest negotiation for an application (org-scoped). */
export async function latestNegotiation(orgId: string, applicationId: string): Promise<Row | null> {
  const [r] = await db
    .select()
    .from(offerNegotiations)
    .where(
      and(eq(offerNegotiations.orgId, orgId), eq(offerNegotiations.applicationId, applicationId)),
    )
    .orderBy(desc(offerNegotiations.createdAt))
    .limit(1);
  return r ?? null;
}

async function loadRow(orgId: string, id: string): Promise<Row> {
  const [r] = await db
    .select()
    .from(offerNegotiations)
    .where(and(eq(offerNegotiations.id, id), eq(offerNegotiations.orgId, orgId)))
    .limit(1);
  if (!r) throw new Error("That pay discussion is not here.");
  return r;
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

async function audit(
  orgId: string,
  actor: string,
  actorUserId: string | null,
  action: string,
  id: string,
  detail: Record<string, unknown>,
) {
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor,
    actorUserId,
    orgId,
    action,
    entityType: "offer_negotiation",
    entityId: id,
    detail,
  });
}

async function raise(
  orgId: string,
  type: "negotiation.agreed" | "negotiation.needs_call",
  applicationId: string,
  by: string | null,
  payload: Record<string, unknown> = {},
) {
  const { emitAgentEvent } = await import("../server/agents/events");
  await emitAgentEvent({
    orgId,
    type,
    subjectType: "application",
    subjectId: applicationId,
    actorUserId: by,
    payload: { applicationId, ...payload },
  });
}

/* ------------------------------------------------------------ prepare */

export const LeversInput = z.object({
  joiningBonus: z.number().min(0).max(MAX_RUPEES).nullable().optional(),
  reviewMonths: z.number().int().min(3).max(24).nullable().optional(),
  other: z.string().trim().max(500).nullable().optional(),
});

export const PrepareInput = z.object({
  applicationId: z.string().uuid(),
  ceiling: z.number().positive().max(MAX_RUPEES),
  proposedCtc: z.number().positive().max(MAX_RUPEES),
  levers: LeversInput.default({}),
  talkTrack: z.string().trim().min(40).max(3000),
  message: z.string().trim().min(80).max(3000),
});

/**
 * Why a negotiation cannot be prepared (pure; unit-tested), or null: the
 * proposal sits at or under the ceiling and under the candidate's ask; a
 * ceiling above the band needs the CBO, otherwise the HR head (or CBO).
 */
export function negotiationProblem(i: {
  expectedCtc: number | null;
  ceiling: number;
  proposedCtc: number;
  bandMax: number | null;
  hrAnswered: boolean;
  cboAnswered: boolean;
}): string | null {
  if (i.expectedCtc == null)
    return "The candidate's expected CTC is not known — send the pay & availability form first.";
  if (i.proposedCtc > i.ceiling)
    return `The proposal ${rupees(i.proposedCtc)} is above the ceiling ${rupees(i.ceiling)}.`;
  if (i.expectedCtc <= i.ceiling)
    return `The candidate's expectation ${rupees(i.expectedCtc)} is within the ceiling — draft the offer at it instead of negotiating.`;
  if (i.bandMax != null && i.ceiling > i.bandMax && !i.cboAnswered)
    return `The ceiling ${rupees(i.ceiling)} is above the band maximum ${rupees(i.bandMax)}: ask_human with assignee_role president_cbo for the exception first.`;
  if (!i.hrAnswered && !i.cboAnswered)
    return "The ceiling must come from the HR head: ask_human with assignee_role hr_head first.";
  return null;
}

/** The Offer agent prepares the discussion (no contact yet). Idempotent per application. */
export async function prepareNegotiation(
  ctx: { orgId: string; runId: string; actor: string; principalUserId: string },
  input: z.infer<typeof PrepareInput>,
): Promise<{ negotiationId: string; status: NegotiationStatus; existing: boolean }> {
  const i = PrepareInput.parse(input);
  const app = await loadApp(ctx.orgId, i.applicationId);
  const open = await latestNegotiation(ctx.orgId, app.id);
  if (open && OPEN_NEGOTIATION.includes(open.status))
    return { negotiationId: open.id, status: open.status, existing: true };
  const { detailsFor } = await import("./compensation.server");
  const pay = await detailsFor(ctx.orgId, app.id);
  const cboAnswered = await answeredInRun(ctx.runId, ["president_cbo"]);
  const problem = negotiationProblem({
    expectedCtc: pay.expectedCtc,
    ceiling: i.ceiling,
    proposedCtc: i.proposedCtc,
    bandMax: num(app.bandMax),
    hrAnswered: await answeredInRun(ctx.runId, ["hr_head"]),
    cboAnswered,
  });
  if (problem) throw new Error(problem);
  const [row] = await db
    .insert(offerNegotiations)
    .values({
      orgId: ctx.orgId,
      applicationId: app.id,
      candidateId: app.candidateId,
      status: "open",
      expectedCtc: String(pay.expectedCtc),
      ceiling: String(i.ceiling),
      // The CBO's answer covers a ceiling above the band; otherwise the HR head set it.
      ceilingApprovedBy: cboAnswered ? "president_cbo" : "hr_head",
      proposedCtc: String(i.proposedCtc),
      levers: i.levers as NegotiationLevers,
      talkTrack: i.talkTrack,
      message: i.message,
      runId: ctx.runId,
    })
    .returning({ id: offerNegotiations.id });
  await audit(ctx.orgId, ctx.actor, ctx.principalUserId, "negotiation.prepared", row!.id, {
    applicationId: app.id,
  });
  await tellThread(
    ctx.orgId,
    app.requisitionId,
    `${app.name}'s pay expectation is above what has been approved, so the Offer agent prepared a pay discussion: a call brief for TA on the candidate's page, and a message that the HR head approves (and can edit) before it is sent. No offer is drafted until a figure is agreed.`,
  );
  return { negotiationId: row!.id, status: "open", existing: false };
}

/* ------------------------------------------------------------ send (after a person's approval) */

/** Email the approved message with the private answer link. Runs as the approving person. */
export async function sendNegotiationMessage(
  orgId: string,
  negotiationId: string,
  message: string,
  by: { userId: string | null; actor: string },
  now = new Date(),
): Promise<{ sent: true; due: string }> {
  const r = await loadRow(orgId, negotiationId);
  if (r.status !== "open")
    throw new Error(`This pay discussion is ${r.status.replace(/_/g, " ")}; nothing to send.`);
  const text = message.trim();
  if (text.length < 80) throw new Error("The message is too short to send.");
  const app = await loadApp(orgId, r.applicationId);
  if (!app.email) throw new Error("The candidate has no email address.");
  const { getOrgEmailSettings, enqueueEmail } = await import("./email-outbox.server");
  const settings = await getOrgEmailSettings(orgId);
  if (!settings.enabled || !settings.offerEnabled)
    throw new Error(
      "Offer emails are turned off for this organisation — call the candidate instead.",
    );
  const tl = await import("./assessment-timeline.server");
  const t = tl.timelineFor(now, await tl.assessmentPolicyOf(orgId), settings.timezone);
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const claimed = await db
    .update(offerNegotiations)
    .set({
      status: "message_sent",
      message: text,
      token,
      dueAt: t.dueAt,
      closesAt: t.closesAt,
      updatedAt: now,
    })
    .where(and(eq(offerNegotiations.id, r.id), eq(offerNegotiations.status, "open")))
    .returning({ id: offerNegotiations.id });
  if (!claimed.length) throw new Error("This pay discussion has already moved on.");
  const [o] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const { env } = await import("../server/env");
  await enqueueEmail({
    orgId,
    kind: "offer_negotiation",
    templateName: "offer_negotiation",
    toEmail: app.email,
    applicationId: app.id,
    idempotencyKey: `negotiation:${r.id}`,
    templateData: {
      candidateName: app.name ?? undefined,
      orgName: o?.name ?? "",
      jobTitle: app.jobTitle,
      message: text,
      responseUrl: `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/negotiate/${token}`,
      dueDate: `${tl.dayText(t.dueAt, settings.timezone)} (end of day)`,
    },
  });
  await audit(orgId, by.actor, by.userId, "negotiation.message_sent", r.id, {
    applicationId: app.id,
    edited: text !== (r.message ?? "").trim(),
  });
  await tellThread(
    orgId,
    app.requisitionId,
    `The approved pay message went to ${app.name}; they can accept, suggest another figure or ask for a call by ${tl.dayText(t.dueAt, settings.timezone)}.`,
  );
  return { sent: true, due: tl.dayText(t.dueAt, settings.timezone) };
}

/* ------------------------------------------------------------ the candidate (public) */

export async function publicNegotiationView(token: string, now = new Date()) {
  const [r] = await db
    .select({
      n: offerNegotiations,
      name: candidates.fullName,
      jobTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(offerNegotiations)
    .innerJoin(candidates, eq(candidates.id, offerNegotiations.candidateId))
    .innerJoin(applications, eq(applications.id, offerNegotiations.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, offerNegotiations.orgId))
    .where(eq(offerNegotiations.token, token))
    .limit(1);
  if (!r) throw new Error("This link is not valid.");
  const { n } = r;
  const answered = n.status !== "message_sent";
  if (!answered && n.closesAt && n.closesAt.getTime() <= now.getTime())
    throw new Error("This link has closed. Reply to the email and the hiring team will call you.");
  if (answered && !n.answer)
    throw new Error("This discussion has moved on. The hiring team will be in touch.");
  return {
    status: answered ? ("answered" as const) : ("open" as const),
    candidateName: r.name,
    jobTitle: r.jobTitle,
    orgName: r.orgName,
    message: n.message ?? "",
    proposedCtc: Number(n.proposedCtc),
    levers: n.levers,
  };
}

export const AnswerInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept"), note: z.string().trim().max(1000).optional() }),
  z.object({
    decision: z.literal("propose"),
    amount: z.number().positive().max(MAX_RUPEES),
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({ decision: z.literal("call"), note: z.string().trim().max(1000).optional() }),
]);

/** The candidate answers once; the status guard is in the UPDATE. */
export async function answerNegotiation(
  token: string,
  input: z.infer<typeof AnswerInput>,
  now = new Date(),
): Promise<{ ok: true }> {
  const a = AnswerInput.parse(input);
  const [r] = await db
    .select()
    .from(offerNegotiations)
    .where(eq(offerNegotiations.token, token))
    .limit(1);
  if (!r) throw new Error("This link is not valid.");
  if (r.status !== "message_sent") throw new Error("You have already answered. Thank you.");
  if (r.closesAt && r.closesAt.getTime() <= now.getTime()) throw new Error("This link has closed.");
  const status: NegotiationStatus =
    a.decision === "accept" ? "agreed" : a.decision === "propose" ? "countered" : "call_requested";
  const answer = {
    decision: a.decision,
    amount: a.decision === "propose" ? a.amount : null,
    note: a.note || null,
    at: now.toISOString(),
  };
  const done = await db
    .update(offerNegotiations)
    .set({
      status,
      answer,
      ...(status === "agreed"
        ? {
            outcome: {
              agreedCtc: Number(r.proposedCtc),
              joiningBonus: r.levers?.joiningBonus ?? null,
              note: a.note || null,
              source: "candidate_link" as const,
            },
            decidedAt: now,
          }
        : {}),
      updatedAt: now,
    })
    .where(and(eq(offerNegotiations.id, r.id), eq(offerNegotiations.status, "message_sent")))
    .returning({ id: offerNegotiations.id });
  if (!done.length) throw new Error("You have already answered. Thank you.");
  await audit(r.orgId, `candidate:${r.candidateId}`, null, "negotiation.answered", r.id, {
    decision: a.decision,
  });
  const app = await loadApp(r.orgId, r.applicationId);
  await tellThread(
    r.orgId,
    app.requisitionId,
    a.decision === "accept"
      ? `${app.name} accepted the proposed figure. The Offer agent drafts the offer at it, and it goes to the HR head and the CBO for approval.`
      : a.decision === "propose"
        ? `${app.name} suggested another figure. TA or the HR head decides — the details are on the candidate's page.`
        : `${app.name} asked for a call about the offer. TA: the call brief is on the candidate's page; record the outcome there.`,
  );
  if (status === "agreed") await raise(r.orgId, "negotiation.agreed", r.applicationId, null);
  // A counter or a call request: the Offer agent may ask for the AI pay call.
  else
    await raise(r.orgId, "negotiation.needs_call", r.applicationId, null, {
      negotiationId: r.id,
      why: status,
    });
  return { ok: true };
}

/* ------------------------------------------------------------ TA / HR: a call's outcome */

export const OutcomeInput = z.discriminatedUnion("agreed", [
  z.object({
    agreed: z.literal(true),
    agreedCtc: z.number().positive().max(MAX_RUPEES),
    joiningBonus: z.number().min(0).max(MAX_RUPEES).nullable().optional(),
    joiningDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({ agreed: z.literal(false), note: z.string().trim().min(3).max(1000) }),
]);

/**
 * Record what was agreed on a call (or that nothing was). The figure must sit
 * within the approved ceiling — above it, the HR head (and the CBO above the
 * band) must raise it first. Role-checked, audited without amounts.
 */
export async function recordNegotiationOutcome(
  actor: { orgId: string; userId: string; memberEmail: string },
  negotiationId: string,
  input: z.infer<typeof OutcomeInput>,
  now = new Date(),
): Promise<{ ok: true; status: NegotiationStatus }> {
  const { assertRole } = await import("./auth.middleware");
  const { PAY_ROLES } = await import("./compensation.server");
  await assertRole(
    actor.userId,
    actor.orgId,
    [...PAY_ROLES],
    "Only TA, the HR head or the CBO can record a pay discussion.",
  );
  const o = OutcomeInput.parse(input);
  const r = await loadRow(actor.orgId, negotiationId);
  if (!OPEN_NEGOTIATION.includes(r.status) && r.status !== "expired")
    throw new Error(`This pay discussion is already ${r.status.replace(/_/g, " ")}.`);
  if (o.agreed && o.agreedCtc > Number(r.ceiling))
    throw new Error(
      `${rupees(o.agreedCtc)} is above the approved ceiling ${rupees(Number(r.ceiling))}. Ask the HR head (and the CBO above the band) to raise it before agreeing.`,
    );
  const status: NegotiationStatus = o.agreed ? "agreed" : "no_agreement";
  const done = await db
    .update(offerNegotiations)
    .set({
      status,
      outcome: o.agreed
        ? {
            agreedCtc: o.agreedCtc,
            joiningBonus: o.joiningBonus ?? null,
            joiningDate: o.joiningDate ?? null,
            note: o.note || null,
            source: "call" as const,
            by: actor.memberEmail,
          }
        : { note: o.note, source: "call" as const, by: actor.memberEmail },
      decidedAt: now,
      updatedAt: now,
    })
    .where(and(eq(offerNegotiations.id, r.id), eq(offerNegotiations.status, r.status)))
    .returning({ id: offerNegotiations.id });
  if (!done.length) throw new Error("This pay discussion has just moved on; refresh to see it.");
  await audit(actor.orgId, actor.memberEmail, actor.userId, "negotiation.outcome_recorded", r.id, {
    agreed: o.agreed,
  });
  const app = await loadApp(actor.orgId, r.applicationId);
  await tellThread(
    actor.orgId,
    app.requisitionId,
    o.agreed
      ? `${actor.memberEmail} agreed the figure with ${app.name} on a call. The Offer agent drafts the offer at it for HR head and CBO approval.`
      : `${actor.memberEmail} could not agree a figure with ${app.name}: "${o.note}". The HR head decides whether to raise the ceiling or stop.`,
  );
  if (o.agreed) await raise(actor.orgId, "negotiation.agreed", r.applicationId, actor.userId);
  return { ok: true, status };
}

/* ------------------------------------------------------------ what the Offer agent may draft */

/**
 * An agreed figure the Offer agent may draft at (and above the band only if
 * the CBO approved that ceiling), or null.
 */
export async function agreedTerms(
  orgId: string,
  applicationId: string,
): Promise<{
  agreedCtc: number;
  ceiling: number;
  cboApproved: boolean;
  joiningBonus: number | null;
  joiningDate: string | null;
} | null> {
  const r = await latestNegotiation(orgId, applicationId);
  if (r?.status !== "agreed" || r.outcome?.agreedCtc == null) return null;
  return {
    agreedCtc: r.outcome.agreedCtc,
    ceiling: Number(r.ceiling),
    cboApproved: r.ceilingApprovedBy === "president_cbo",
    joiningBonus: r.outcome.joiningBonus ?? null,
    joiningDate: r.outcome.joiningDate ?? null,
  };
}

/* ------------------------------------------------------------ sweep */

/** Links past their closing date with no answer expire; the thread is told. */
export async function runNegotiationSweep(orgId?: string, now = new Date()): Promise<number> {
  const rows = await db
    .update(offerNegotiations)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(offerNegotiations.status, "message_sent"),
        sql`${offerNegotiations.closesAt} <= ${now.toISOString()}::timestamptz`,
        orgId ? eq(offerNegotiations.orgId, orgId) : undefined,
      ),
    )
    .returning();
  for (const r of rows) {
    const app = await loadApp(r.orgId, r.applicationId);
    await tellThread(
      r.orgId,
      app.requisitionId,
      `${app.name} did not answer the pay message, so its link has closed. Call them (the brief is on the candidate's page), or the HR head decides whether to raise the ceiling or stop.`,
    );
    await raise(r.orgId, "negotiation.needs_call", r.applicationId, null, {
      negotiationId: r.id,
      why: "expired",
    });
  }
  return rows.length;
}

/** Whether an open discussion has waited past its due date (for the nudge; pure). */
export const negotiationOverdue = (r: Pick<Row, "status" | "dueAt">, now = new Date()) =>
  r.status === "message_sent" && !!r.dueAt && now.getTime() > r.dueAt.getTime() + DAY;
