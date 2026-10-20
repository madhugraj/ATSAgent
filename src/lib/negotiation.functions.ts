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
    };
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
