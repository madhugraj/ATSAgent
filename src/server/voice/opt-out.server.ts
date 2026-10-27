/**
 * "Please don't call me": a candidate's opt-out from AI phone calls
 * (docs/voice-scheduling-call-plan.md). Once recorded, no AI call of any kind —
 * screening or scheduling — is requested, dialled or retried for them; calls
 * already waiting are cancelled. Only a person on the team can clear it, when
 * the candidate asks to be called again. Both are audited.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { candidates, screeningCalls } from "@db/schema";
import { writeAudit } from "../audit";
import { db } from "../db";

/** Calls that have not been placed yet (or are waiting for a retry or callback). */
const NOT_PLACED = ["requested", "approved", "callback", "no_answer", "failed"] as const;

export async function aiCallOptedOut(orgId: string, candidateId: string): Promise<boolean> {
  const [c] = await db
    .select({ at: candidates.aiCallOptOutAt })
    .from(candidates)
    .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)))
    .limit(1);
  return Boolean(c?.at);
}

/**
 * Record the opt-out (first time only) and cancel every call still waiting for
 * this candidate. `source` says who heard it: the assistant on a call, or a
 * person on the team. Returns how many waiting calls were cancelled.
 */
export async function recordAiCallOptOut(input: {
  orgId: string;
  candidateId: string;
  source: "call" | "team";
  actor: string;
  actorUserId?: string | null;
  callId?: string | null;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const set = await db
    .update(candidates)
    .set({ aiCallOptOutAt: now })
    .where(
      and(
        eq(candidates.id, input.candidateId),
        eq(candidates.orgId, input.orgId),
        isNull(candidates.aiCallOptOutAt),
      ),
    )
    .returning({ id: candidates.id });
  const cancelled = await db
    .update(screeningCalls)
    .set({
      status: "cancelled",
      lastError: "The candidate asked not to be called by the AI assistant.",
      updatedAt: now,
    })
    .where(
      and(
        eq(screeningCalls.orgId, input.orgId),
        eq(screeningCalls.candidateId, input.candidateId),
        inArray(screeningCalls.status, [...NOT_PLACED]),
      ),
    )
    .returning({ id: screeningCalls.id });
  if (set.length || cancelled.length)
    await writeAudit({
      actor: input.actor,
      actorUserId: input.actorUserId ?? null,
      orgId: input.orgId,
      action: "candidate.ai_call_opt_out",
      entityType: "candidate",
      entityId: input.candidateId,
      detail: {
        source: input.source,
        callId: input.callId ?? null,
        cancelledCalls: cancelled.map((c) => c.id),
      },
    });
  return cancelled.length;
}

/** The candidate asked to be called again (a person on the team records it). Audited. */
export async function clearAiCallOptOut(input: {
  orgId: string;
  candidateId: string;
  actor: string;
  actorUserId: string;
}): Promise<boolean> {
  const done = await db
    .update(candidates)
    .set({ aiCallOptOutAt: null })
    .where(
      and(
        eq(candidates.id, input.candidateId),
        eq(candidates.orgId, input.orgId),
        sql`${candidates.aiCallOptOutAt} is not null`,
      ),
    )
    .returning({ id: candidates.id });
  if (!done.length) return false;
  await writeAudit({
    actor: input.actor,
    actorUserId: input.actorUserId,
    orgId: input.orgId,
    action: "candidate.ai_call_opt_in",
    entityType: "candidate",
    entityId: input.candidateId,
    detail: {},
  });
  return true;
}
