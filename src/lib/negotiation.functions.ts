/**
 * Pay discussions: the candidate's private answer page and TA / HR's view of a
 * discussion (the call brief) and its outcome. Rules: src/lib/negotiation.server.ts.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { assertRole, requireOrg } from "./auth.middleware";

const Token = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });

export const getNegotiationPage = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => Token.parse(d))
  .handler(async ({ data }) => {
    const { publicNegotiationView } = await import("./negotiation.server");
    return publicNegotiationView(data.token);
  });

export const answerNegotiationPage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Token.extend({ answer: z.unknown() }).parse(d))
  .handler(async ({ data }) => {
    const { answerNegotiation, AnswerInput } = await import("./negotiation.server");
    const parsed = AnswerInput.safeParse(data.answer);
    if (!parsed.success)
      throw new Error("Please choose an answer (and a figure, if you suggest one).");
    return answerNegotiation(data.token, parsed.data);
  });

/** One discussion with its brief, for TA / HR / CBO / owners only. */
export const getNegotiation = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ applicationId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { PAY_ROLES } = await import("./compensation.server");
    await assertRole(
      context.userId,
      context.orgId,
      [...PAY_ROLES],
      "Only TA, the HR head or the CBO can see a pay discussion.",
    );
    const { latestNegotiation } = await import("./negotiation.server");
    const n = await latestNegotiation(context.orgId, data.applicationId);
    if (!n) return null;
    return {
      id: n.id,
      status: n.status,
      expectedCtc: n.expectedCtc == null ? null : Number(n.expectedCtc),
      ceiling: Number(n.ceiling),
      ceilingApprovedBy: n.ceilingApprovedBy,
      proposedCtc: Number(n.proposedCtc),
      levers: n.levers,
      talkTrack: n.talkTrack,
      message: n.message,
      answer: n.answer,
      outcome: n.outcome,
      dueAt: n.dueAt?.toISOString() ?? null,
      // The AI pay call (docs/negotiator-voice-agent.md): its one improved figure,
      // what it heard (pre-fills the confirm), its latest call and whether one may be arranged.
      callStepCtc: n.callStepCtc == null ? null : Number(n.callStepCtc),
      callOutcome: n.callOutcome ?? null,
      ...(await aiCallState(context.orgId, n.id)),
    };
  });

/** The latest AI pay call for a discussion, and why another cannot be arranged (or null). */
async function aiCallState(orgId: string, negotiationId: string) {
  const { db } = await import("../server/db");
  const { screeningCalls } = await import("@db/schema");
  const { and, desc, eq } = await import("drizzle-orm");
  const [c] = await db
    .select({
      status: screeningCalls.status,
      endReason: screeningCalls.endReason,
      dueAt: screeningCalls.dueAt,
      attempt: screeningCalls.attempt,
    })
    .from(screeningCalls)
    .where(and(eq(screeningCalls.orgId, orgId), eq(screeningCalls.negotiationId, negotiationId)))
    .orderBy(desc(screeningCalls.createdAt))
    .limit(1);
  const { checkNegotiationCall } = await import("../server/voice/negotiation-request.server");
  const check = await checkNegotiationCall(orgId, negotiationId, { byPerson: true });
  return {
    aiCall: c
      ? {
          status: c.status,
          endReason: c.endReason,
          dueAt: c.dueAt?.toISOString() ?? null,
          attempt: c.attempt,
        }
      : null,
    aiCallBlocked: check.ok ? null : check.reason,
  };
}

/** TA / HR arrange an AI pay call, with at most one improved figure (≤ the ceiling). */
export const arrangeNegotiationCall = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        negotiationId: z.string().uuid(),
        improvedCtc: z.number().positive().max(500_000_000).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { PAY_ROLES } = await import("./compensation.server");
    await assertRole(
      context.userId,
      context.orgId,
      [...PAY_ROLES],
      "Only TA, the HR head or the CBO can arrange a pay call.",
    );
    const { requestNegotiationCall } = await import("../server/voice/negotiation-request.server");
    const r = await requestNegotiationCall({
      orgId: context.orgId,
      negotiationId: data.negotiationId,
      step: data.improvedCtc,
      requestedBy: context.userId,
      requestedRunId: null,
      actor: context.memberEmail,
      byPerson: true,
    });
    return { callId: r.callId, dueAt: r.dueAt.toISOString() };
  });

export const recordNegotiationCall = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ negotiationId: z.string().uuid(), outcome: z.unknown() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { recordNegotiationOutcome, OutcomeInput } = await import("./negotiation.server");
    const parsed = OutcomeInput.safeParse(data.outcome);
    if (!parsed.success)
      throw new Error("Enter the agreed figure (rupees), or say why no figure was agreed.");
    return recordNegotiationOutcome(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data.negotiationId,
      parsed.data,
    );
  });
