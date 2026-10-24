/**
 * Asking for a phone screening call (docs/voice-screening-agent.md) — shared
 * by the Screening agent's request_screening_call and a person's "Call now",
 * so both refuse for the same reasons. The call itself is placed later by the
 * voice worker, inside the organisation's calling window.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { applications, candidates, screeningCalls, screeningKits } from "@db/schema";
import { writeAudit } from "../audit";
import { db } from "../db";
import { dialNumber } from "./phone";
import { nextWindowStart } from "./schedule";
import { phoneScreeningPolicyOf, phoneScreeningReadiness } from "./settings.server";

/** A call that is arranged or happening. */
export const OPEN_CALL = [
  "requested",
  "approved",
  "dialling",
  "in_progress",
  "callback",
  "no_answer",
  "failed",
] as const;

/** Stages a candidate can be phone-screened in. */
const SCREENABLE = ["shortlisted"];

export type CallCheck =
  | {
      ok: true;
      app: { id: string; candidateId: string; requisitionId: string; name: string | null };
      kitId: string;
    }
  | { ok: false; reason: string };

/** Whether a screening call may be asked for this application now — and why not. */
export async function checkScreeningCall(orgId: string, applicationId: string): Promise<CallCheck> {
  const ready = await phoneScreeningReadiness(orgId);
  if (!ready.enabled)
    return { ok: false, reason: "Phone screening is switched off for this organisation." };
  if (!ready.phoneLine)
    return { ok: false, reason: "The voice worker with its phone line is not running right now." };
  if (!ready.voice)
    return { ok: false, reason: "The organisation has not stored an AI voice key yet." };

  const [app] = await db
    .select({
      id: applications.id,
      stage: applications.stage,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      name: candidates.fullName,
      phone: candidates.phone,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!app) return { ok: false, reason: "Application not found." };
  if (!SCREENABLE.includes(app.stage))
    return {
      ok: false,
      reason: `The candidate is ${app.stage.replace(/_/g, " ")}, not shortlisted.`,
    };
  if (!dialNumber(app.phone))
    return {
      ok: false,
      reason:
        "The candidate has no Indian mobile number on file — send the written assessment instead.",
    };

  const [kit] = await db
    .select({ id: screeningKits.id })
    .from(screeningKits)
    .where(
      and(
        eq(screeningKits.orgId, orgId),
        eq(screeningKits.candidateId, app.candidateId),
        eq(screeningKits.requisitionId, app.requisitionId),
      ),
    )
    .orderBy(desc(screeningKits.createdAt))
    .limit(1);
  if (!kit) return { ok: false, reason: "Prepare the screening kit first." };

  const [last] = await db
    .select({ status: screeningCalls.status })
    .from(screeningCalls)
    .where(and(eq(screeningCalls.orgId, orgId), eq(screeningCalls.applicationId, app.id)))
    .orderBy(desc(screeningCalls.createdAt))
    .limit(1);
  if (last && (OPEN_CALL as readonly string[]).includes(last.status))
    return { ok: false, reason: "A screening call is already arranged for this candidate." };
  if (last?.status === "completed")
    return { ok: false, reason: "This candidate was already screened by phone." };
  if (last?.status === "consent_declined")
    return {
      ok: false,
      reason: "The candidate declined phone screening — send the written assessment instead.",
    };

  return {
    ok: true,
    app: {
      id: app.id,
      candidateId: app.candidateId,
      requisitionId: app.requisitionId,
      name: app.name,
    },
    kitId: kit.id,
  };
}

/**
 * Arrange the call (status approved — the person or the agent's approval
 * already happened), due at the next moment inside the calling window.
 * Audited `screening_call.requested`.
 */
export async function requestScreeningCall(input: {
  orgId: string;
  applicationId: string;
  requestedBy: string;
  requestedRunId: string | null;
  actor: string;
  now?: number;
}): Promise<{ callId: string; dueAt: Date }> {
  const check = await checkScreeningCall(input.orgId, input.applicationId);
  if (!check.ok) throw new Error(check.reason);
  const policy = await phoneScreeningPolicyOf(input.orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(input.orgId)).timezone;
  const dueAt = nextWindowStart(input.now ?? Date.now(), policy, tz);
  // Two requests racing: only one open call per application.
  const [open] = await db
    .select({ id: screeningCalls.id })
    .from(screeningCalls)
    .where(
      and(
        eq(screeningCalls.orgId, input.orgId),
        eq(screeningCalls.applicationId, check.app.id),
        inArray(screeningCalls.status, [...OPEN_CALL]),
      ),
    )
    .limit(1);
  if (open) throw new Error("A screening call is already arranged for this candidate.");
  const [row] = await db
    .insert(screeningCalls)
    .values({
      orgId: input.orgId,
      candidateId: check.app.candidateId,
      applicationId: check.app.id,
      requisitionId: check.app.requisitionId,
      kitId: check.kitId,
      requestedRunId: input.requestedRunId,
      requestedBy: input.requestedBy,
      status: "approved",
      dueAt,
    })
    .returning({ id: screeningCalls.id });
  await writeAudit({
    actor: input.actor,
    actorUserId: input.requestedBy,
    orgId: input.orgId,
    action: "screening_call.requested",
    entityType: "screening_call",
    entityId: row!.id,
    detail: { applicationId: check.app.id, dueAt: dueAt.toISOString() },
  });
  return { callId: row!.id, dueAt };
}
