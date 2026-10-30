/**
 * When an AI negotiation call may be asked for, and arranging it
 * (docs/negotiator-voice-agent.md, step N3). Every rule is the system's:
 *  - phone calls switched on and placeable (line + voice key);
 *  - a pay discussion that is not settled (open, message sent, countered,
 *    call requested, or its link closed unanswered);
 *  - an Indian mobile on file, and no opt-out from AI calls;
 *  - no call for this discussion already waiting or under way; an agent never
 *    asks again once the assistant spoke with them about it (a person may);
 *  - the one improved figure, if any, above the proposal and at or under the
 *    approved ceiling.
 * Amounts never reach the audit entry.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  applications,
  candidates,
  offerNegotiations,
  screeningCalls,
  type NegotiationCallBrief,
} from "@db/schema";
import { CALLABLE_NEGOTIATION } from "@/lib/negotiation.server";
import { writeAudit } from "../audit";
import { db } from "../db";
import { dialNumber } from "./phone";
import { callBriefProblem } from "./negotiation-call-tools";
import { nextWindowStart } from "./schedule";
import { phoneScreeningPolicyOf, phoneScreeningReadiness } from "./settings.server";

type Negotiation = typeof offerNegotiations.$inferSelect;

/** A call row in one of these is waiting for, or on, the line. */
const LIVE_CALL = [
  "requested",
  "approved",
  "dialling",
  "in_progress",
  "callback",
  "no_answer",
  "failed",
];

/** Whether `step` may be the call's one improved figure (pure; unit-tested). */
export function stepProblem(
  step: number | null,
  n: { proposedCtc: number; ceiling: number },
): string | null {
  if (step == null) return null;
  if (!(step > n.proposedCtc))
    return "The improved figure must be above the proposal — or leave it empty to hold.";
  if (step > n.ceiling) return "The improved figure must be at or under the approved ceiling.";
  return null;
}

export type NegotiationCallCheck =
  { ok: true; negotiation: Negotiation; requisitionId: string } | { ok: false; reason: string };

export async function checkNegotiationCall(
  orgId: string,
  negotiationId: string,
  opts: { byPerson?: boolean; step?: number | null; brief?: NegotiationCallBrief | null } = {},
): Promise<NegotiationCallCheck> {
  const ready = await phoneScreeningReadiness(orgId);
  if (!ready.enabled)
    return { ok: false, reason: "Phone calls are switched off for this organisation." };
  if (!ready.phoneLine)
    return { ok: false, reason: "The voice worker with its phone line is not running right now." };
  if (!ready.voice)
    return { ok: false, reason: "The organisation has not stored an AI voice key yet." };

  const [row] = await db
    .select({
      n: offerNegotiations,
      requisitionId: applications.requisitionId,
      phone: candidates.phone,
      optedOut: candidates.aiCallOptOutAt,
    })
    .from(offerNegotiations)
    .innerJoin(applications, eq(applications.id, offerNegotiations.applicationId))
    .innerJoin(candidates, eq(candidates.id, offerNegotiations.candidateId))
    .where(
      and(
        eq(offerNegotiations.id, negotiationId),
        eq(offerNegotiations.orgId, orgId),
        eq(applications.orgId, orgId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, reason: "That pay discussion is not here." };
  if (!CALLABLE_NEGOTIATION.includes(row.n.status))
    return {
      ok: false,
      reason: `This pay discussion is ${row.n.status.replace(/_/g, " ")} — nothing to call about.`,
    };
  if (row.optedOut)
    return { ok: false, reason: "The candidate asked not to be called by the AI assistant." };
  if (!dialNumber(row.phone))
    return { ok: false, reason: "The candidate has no Indian mobile number on file." };
  const step = stepProblem(opts.step ?? null, {
    proposedCtc: Number(row.n.proposedCtc),
    ceiling: Number(row.n.ceiling),
  });
  if (step) return { ok: false, reason: step };
  const briefProblem = opts.brief
    ? callBriefProblem(opts.brief, {
        proposedCtc: Number(row.n.proposedCtc),
        ceiling: Number(row.n.ceiling),
      })
    : null;
  if (briefProblem) return { ok: false, reason: briefProblem };

  const [live] = await db
    .select({ id: screeningCalls.id })
    .from(screeningCalls)
    .where(
      and(
        eq(screeningCalls.orgId, orgId),
        eq(screeningCalls.negotiationId, negotiationId),
        inArray(screeningCalls.status, LIVE_CALL as never[]),
      ),
    )
    .limit(1);
  if (live) return { ok: false, reason: "A pay call for this discussion is already arranged." };
  if (!opts.byPerson) {
    const [spoken] = await db
      .select({ id: screeningCalls.id })
      .from(screeningCalls)
      .where(
        and(
          eq(screeningCalls.orgId, orgId),
          eq(screeningCalls.negotiationId, negotiationId),
          sql`${screeningCalls.consentAt} is not null`,
        ),
      )
      .limit(1);
    if (spoken)
      return {
        ok: false,
        reason: "The assistant already spoke with them about pay; a person takes it from here.",
      };
  }
  return { ok: true, negotiation: row.n, requisitionId: row.requisitionId };
}

/**
 * Arrange the call (approved — a person approved it, or arranged it), due at
 * the next moment inside the calling window, and record the one improved
 * figure on the discussion (null = hold). Audited without amounts.
 */
export async function requestNegotiationCall(input: {
  orgId: string;
  negotiationId: string;
  step: number | null;
  /** What the call may explain (split, ESOPs, review, benefits, why the team wants them). */
  brief?: NegotiationCallBrief | null;
  requestedBy: string;
  requestedRunId: string | null;
  actor: string;
  byPerson?: boolean;
  now?: number;
}): Promise<{ callId: string; dueAt: Date }> {
  const now = input.now ?? Date.now();
  const check = await checkNegotiationCall(input.orgId, input.negotiationId, {
    byPerson: Boolean(input.byPerson),
    step: input.step,
    brief: input.brief ?? null,
  });
  if (!check.ok) throw new Error(check.reason);
  const n = check.negotiation;
  const policy = await phoneScreeningPolicyOf(input.orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(input.orgId)).timezone;
  const dueAt = nextWindowStart(now, policy, tz);
  const row = await db.transaction(async (tx) => {
    await tx
      .update(offerNegotiations)
      .set({
        callStepCtc: input.step == null ? null : String(input.step),
        callBrief: input.brief ?? null,
        updatedAt: new Date(now),
      })
      .where(and(eq(offerNegotiations.id, n.id), eq(offerNegotiations.orgId, input.orgId)));
    const [r] = await tx
      .insert(screeningCalls)
      .values({
        orgId: input.orgId,
        candidateId: n.candidateId,
        applicationId: n.applicationId,
        requisitionId: check.requisitionId,
        purpose: "negotiation",
        negotiationId: n.id,
        requestedRunId: input.requestedRunId,
        requestedBy: input.requestedBy,
        status: "approved",
        dueAt,
      })
      .returning({ id: screeningCalls.id });
    return r!;
  });
  await writeAudit({
    actor: input.actor,
    actorUserId: input.requestedBy,
    orgId: input.orgId,
    action: "negotiation.voice_call_requested",
    entityType: "offer_negotiation",
    entityId: n.id,
    detail: {
      callId: row.id,
      applicationId: n.applicationId,
      // Whether the call may move once — never the figure.
      improvedFigure: input.step != null,
      // Which parts the call may explain — never their amounts.
      explains: Object.keys(input.brief ?? {}).filter(
        (k) => (input.brief as Record<string, unknown>)[k] != null,
      ),
      byPerson: Boolean(input.byPerson),
      dueAt: dueAt.toISOString(),
    },
  });
  return { callId: row.id, dueAt };
}
