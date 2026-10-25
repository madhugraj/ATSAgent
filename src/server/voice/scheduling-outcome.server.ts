/**
 * What a scheduling call does to the world (docs/voice-scheduling-call-plan.md):
 * book a chosen time through the same core as the e-mailed link, hand "none of
 * these work" to the same decline path, and close the call — retry, give up
 * (the link still works), or honour an opt-out. Used by the text-mode tools
 * (evals) now and by the live call (step S2).
 */
import { and, eq } from "drizzle-orm";

import { screeningCalls, type ScreeningCallStatus } from "@db/schema";
import { db } from "../db";
import { log } from "../log";
import type { Availability, SchedulingEndReason } from "./scheduling-call-tools";
import { spokenWhen } from "./scheduling-brief.server";

/** A scheduling call is tried at most twice (no answer → once more, two hours later). */
export const SCHEDULING_MAX_ATTEMPTS = 2;

type Call = typeof screeningCalls.$inferSelect;

/** Book the chosen time; the result is what the assistant reads back, or why it could not. */
export async function bookByPhone(
  orgId: string,
  call: Call,
  at: string,
): Promise<{ ok: true; booked_for: string } | { ok: false; error: string }> {
  if (!call.slotOfferId) return { ok: false, error: "This call has no interview offer." };
  const { chooseSlotByOffer } = await import("@/lib/slot-offers.server");
  const r = await chooseSlotByOffer(orgId, call.slotOfferId, at, {
    callId: call.id,
    alternates: call.alternates,
  });
  if (!r.booked) return { ok: false, error: r.reason };
  await db
    .update(screeningCalls)
    .set({ status: "completed", endReason: "booked", updatedAt: new Date() })
    .where(and(eq(screeningCalls.id, call.id), eq(screeningCalls.orgId, orgId)));
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  return { ok: true, booked_for: spokenWhen(r.at, tz) };
}

/** None of the times work: their words go on the call and down the offer's decline path. */
export async function noteAvailability(orgId: string, call: Call, a: Availability): Promise<void> {
  const words = a.their_words.replace(/\s+/g, " ").trim().slice(0, 300);
  await db
    .update(screeningCalls)
    .set({ details: { ...call.details, note: words }, updatedAt: new Date() })
    .where(and(eq(screeningCalls.id, call.id), eq(screeningCalls.orgId, orgId)));
  if (!call.slotOfferId) return;
  const { declineSlotsByOffer } = await import("@/lib/slot-offers.server");
  await declineSlotsByOffer(orgId, call.slotOfferId, words);
}

/**
 * The call-back the candidate asked for: once per offer (the call has not been
 * moved before), at most three hours away and inside the calling hours.
 * Returns the time to read back; writes nothing (see `saveCallback`).
 */
export async function callbackTime(
  orgId: string,
  call: Call,
  minutes: number,
  now = Date.now(),
): Promise<{ ok: true; at: Date; back_at: string } | { ok: false; error: string }> {
  if (call.reschedules >= 1)
    return {
      ok: false,
      error:
        "Not possible: a call-back was already arranged for these times. Point them to the link in their e-mail.",
    };
  const { phoneScreeningPolicyOf } = await import("./settings.server");
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const { inWindow } = await import("./schedule");
  const policy = await phoneScreeningPolicyOf(orgId);
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const at = new Date(now + Math.min(Math.max(minutes, 5), 180) * 60_000);
  if (!inWindow(at.getTime(), policy, tz))
    return {
      ok: false,
      error:
        "Not possible: that is outside the calling hours. Point them to the link in their e-mail.",
    };
  return { ok: true, at, back_at: spokenWhen(at.toISOString(), tz) };
}

/** Make the call a call-back at `at` (the dispatcher dials it then; no attempt used). */
export async function saveCallback(orgId: string, call: Call, at: Date): Promise<void> {
  await db
    .update(screeningCalls)
    .set({
      status: "callback",
      endReason: "callback",
      dueAt: at,
      callbackAt: at,
      bookedByCandidate: true,
      reschedules: call.reschedules + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(screeningCalls.id, call.id), eq(screeningCalls.orgId, orgId)));
}

/** Where a scheduling call's ending leaves it (pure; unit-tested). */
export function scheduledEnd(
  reason: SchedulingEndReason,
  attempt: number,
): "completed" | "fell_back" | "retry" {
  switch (reason) {
    case "callback":
      return "completed"; // the call-back itself was saved when it was agreed
    case "booked":
    case "availability_noted":
    case "not_now":
    case "declined":
    case "opt_out":
      return "completed";
    case "wrong_person":
      return "fell_back";
    default:
      // Voicemail, they left, anything else: once more, then the e-mail link stands.
      return attempt < SCHEDULING_MAX_ATTEMPTS ? "retry" : "fell_back";
  }
}

/** Close the call by how it ended. An opt-out is recorded and honoured for every AI call. */
export async function endSchedulingCall(
  orgId: string,
  call: Call,
  reason: SchedulingEndReason,
  actor: string,
  now = Date.now(),
): Promise<ScreeningCallStatus> {
  const next = scheduledEnd(reason, call.attempt);
  let status: ScreeningCallStatus = next === "retry" ? "no_answer" : next;
  let dueAt: Date | null = null;
  if (next === "retry") {
    const { phoneScreeningPolicyOf } = await import("./settings.server");
    const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
    const { retryAt } = await import("./schedule");
    dueAt = retryAt(
      now,
      call.attempt,
      await phoneScreeningPolicyOf(orgId),
      (await getOrgEmailSettings(orgId)).timezone,
    );
  }
  // A booking already closed the call: keep it completed whatever the closing words.
  const [current] = await db
    .select({ status: screeningCalls.status })
    .from(screeningCalls)
    .where(eq(screeningCalls.id, call.id))
    .limit(1);
  // A booking or an agreed call-back already settled the call: keep it.
  const settled = current?.status === "completed" || current?.status === "callback";
  if (settled) status = current!.status;
  await db
    .update(screeningCalls)
    .set({
      status,
      ...(settled ? {} : { endReason: reason, dueAt }),
      endedAt: new Date(now),
      updatedAt: new Date(now),
    })
    .where(and(eq(screeningCalls.id, call.id), eq(screeningCalls.orgId, orgId)));
  if (reason === "opt_out") {
    const { recordAiCallOptOut } = await import("./opt-out.server");
    await recordAiCallOptOut({
      orgId,
      candidateId: call.candidateId,
      source: "call",
      actor,
      callId: call.id,
    }).catch((e) => log.warn("scheduling_call.opt_out_failed", { call_id: call.id, error: e }));
  }
  return status;
}
