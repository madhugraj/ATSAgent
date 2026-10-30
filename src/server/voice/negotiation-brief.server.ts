/**
 * The facts for one negotiation call (docs/negotiator-voice-agent.md): the
 * pay discussion it follows up, and the two figures it may say. The figures
 * stay here, in code, for the in-call tools — the prompt gets names and the
 * reason for the call only. The ceiling and band are never loaded at all.
 */
import { and, eq } from "drizzle-orm";

import {
  applications,
  candidates,
  offerNegotiations,
  organizations,
  requisitions,
  screeningCalls,
  type NegotiationStatus,
} from "@db/schema";
import { CALLABLE_NEGOTIATION } from "@/lib/negotiation.server";
import { db } from "../db";
import type { NegotiationFigures } from "./negotiation-call-tools";
import type { NegotiationFacts } from "./negotiation-prompt";
import { phoneScreeningPolicyOf } from "./settings.server";

/** Hard limit for a negotiation call, in minutes. */
export const NEGOTIATION_MAX_MINUTES = 8;

/** Why the call, from the discussion's state (pure). */
export function whyOf(status: NegotiationStatus): NegotiationFacts["why"] {
  if (status === "call_requested") return "they_asked";
  if (status === "countered") return "they_replied";
  if (status === "expired") return "no_reply";
  return "follow_up";
}

export type NegotiationBrief = {
  negotiationId: string;
  status: NegotiationStatus;
  /** The discussion can still be called about (otherwise the call is not placed). */
  open: boolean;
  candidateName: string;
  facts: NegotiationFacts;
  figures: NegotiationFigures;
};

export async function loadNegotiationBrief(
  orgId: string,
  callId: string,
): Promise<NegotiationBrief | null> {
  const [row] = await db
    .select({
      negotiationId: offerNegotiations.id,
      status: offerNegotiations.status,
      proposedCtc: offerNegotiations.proposedCtc,
      callStepCtc: offerNegotiations.callStepCtc,
      levers: offerNegotiations.levers,
      fullName: candidates.fullName,
      roleTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(screeningCalls)
    .innerJoin(offerNegotiations, eq(offerNegotiations.id, screeningCalls.negotiationId))
    .innerJoin(applications, eq(applications.id, offerNegotiations.applicationId))
    .innerJoin(candidates, eq(candidates.id, offerNegotiations.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, screeningCalls.orgId))
    .where(
      and(
        eq(screeningCalls.id, callId),
        eq(screeningCalls.orgId, orgId),
        eq(screeningCalls.purpose, "negotiation"),
        eq(offerNegotiations.orgId, orgId),
        eq(applications.orgId, orgId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const policy = await phoneScreeningPolicyOf(orgId);
  return {
    negotiationId: row.negotiationId,
    status: row.status,
    open: CALLABLE_NEGOTIATION.includes(row.status),
    candidateName: row.fullName,
    facts: {
      assistantName: policy.assistantName,
      orgName: row.orgName,
      candidateFirstName: row.fullName.trim().split(/\s+/)[0] ?? row.fullName,
      roleTitle: row.roleTitle,
      why: whyOf(row.status),
      maxMinutes: NEGOTIATION_MAX_MINUTES,
    },
    figures: {
      proposalCtc: Number(row.proposedCtc),
      stepCtc: row.callStepCtc == null ? null : Number(row.callStepCtc),
      levers: row.levers ?? {},
    },
  };
}
