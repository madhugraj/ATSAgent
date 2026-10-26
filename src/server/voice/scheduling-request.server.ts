/**
 * When a scheduling call may be asked for, and arranging it
 * (docs/voice-scheduling-call-plan.md). Every rule is checked here, by the
 * system — never left to the agent:
 *  - scheduling calls switched on, and calls can be placed (line + voice key);
 *  - an open e-mailed offer for the candidate, whose earliest bookable time is
 *    still at least a day away;
 *  - the offer has waited the organisation's hours unanswered — or it is a
 *    repeat offer (an earlier one for this round was declined or expired),
 *    which is called about straight away;
 *  - an Indian mobile on file, and the candidate has not opted out of AI calls;
 *  - one scheduling call per offer.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { applications, candidates, interviewSlotOffers, screeningCalls } from "@db/schema";
import { writeAudit } from "../audit";
import { db } from "../db";
import { dialNumber } from "./phone";
import { nextWindowStart } from "./schedule";
import { phoneScreeningPolicyOf, phoneScreeningReadiness } from "./settings.server";

type InterviewSlotOffer = typeof interviewSlotOffers.$inferSelect;

const DAY = 864e5;
const TERMINAL = ["rejected", "hired", "joined", "withdrawn", "no_show"];

export type SchedulingCheck =
  | {
      ok: true;
      offer: InterviewSlotOffer;
      candidateId: string;
      requisitionId: string;
      /** A repeat offer: called about without waiting. */
      repeat: boolean;
    }
  | { ok: false; reason: string };

export async function checkSchedulingCall(
  orgId: string,
  applicationId: string,
  now = Date.now(),
  /** A person arranging the call may call before the wait (agents never may). */
  opts: { byPerson?: boolean } = {},
): Promise<SchedulingCheck> {
  const policy = await phoneScreeningPolicyOf(orgId);
  if (!policy.schedulingEnabled)
    return { ok: false, reason: "Scheduling calls are switched off for this organisation." };
  const ready = await phoneScreeningReadiness(orgId);
  if (!ready.enabled)
    return { ok: false, reason: "Phone calls are switched off for this organisation." };
  if (!ready.phoneLine)
    return { ok: false, reason: "The voice worker with its phone line is not running right now." };
  if (!ready.voice)
    return { ok: false, reason: "The organisation has not stored an AI voice key yet." };

  const [app] = await db
    .select({
      stage: applications.stage,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      phone: candidates.phone,
      optedOut: candidates.aiCallOptOutAt,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!app) return { ok: false, reason: "Application not found." };
  if (TERMINAL.includes(app.stage))
    return { ok: false, reason: `The candidate is ${app.stage.replace(/_/g, " ")}.` };
  if (app.optedOut)
    return {
      ok: false,
      reason: "The candidate asked not to be called by the AI assistant — the e-mail link stands.",
    };
  if (!dialNumber(app.phone))
    return { ok: false, reason: "The candidate has no Indian mobile number on file." };

  const [offer] = await db
    .select()
    .from(interviewSlotOffers)
    .where(
      and(
        eq(interviewSlotOffers.orgId, orgId),
        eq(interviewSlotOffers.applicationId, applicationId),
        eq(interviewSlotOffers.status, "offered"),
        sql`${interviewSlotOffers.expiresAt} > ${new Date(now).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(interviewSlotOffers.createdAt))
    .limit(1);
  if (!offer)
    return {
      ok: false,
      reason: "No interview times are waiting for this candidate — offer times first.",
    };
  // Only for the round they are in (an older offer for a later round is never called about).
  const { roundNotYet } = await import("@/lib/slot-offers.server");
  const notYet = roundNotYet(app.stage, offer.level);
  if (notYet) return { ok: false, reason: notYet };
  const earliest = Math.min(...offer.slots.map((s) => new Date(s).getTime()));
  if (earliest < now + DAY)
    return {
      ok: false,
      reason:
        "The earliest offered time is less than a day away — too close for a call; a person can phone them.",
    };

  const [already] = await db
    .select({ id: screeningCalls.id })
    .from(screeningCalls)
    .where(
      and(
        eq(screeningCalls.orgId, orgId),
        eq(screeningCalls.slotOfferId, offer.id),
        ne(screeningCalls.status, "cancelled"),
      ),
    )
    .limit(1);
  if (already)
    return { ok: false, reason: "A scheduling call was already arranged for these times." };

  // One conversation per round: once the assistant has spoken with them about it,
  // later times go by e-mail only (no call → decline → re-offer → call loop).
  const [spoken] = await db
    .select({ id: screeningCalls.id })
    .from(screeningCalls)
    .innerJoin(interviewSlotOffers, eq(interviewSlotOffers.id, screeningCalls.slotOfferId))
    .where(
      and(
        eq(screeningCalls.orgId, orgId),
        eq(screeningCalls.applicationId, applicationId),
        eq(screeningCalls.purpose, "scheduling"),
        eq(interviewSlotOffers.level, offer.level),
        sql`${screeningCalls.consentAt} is not null`,
      ),
    )
    .limit(1);
  // An agent never calls again about a round; a person on the team may decide to.
  if (spoken && !opts.byPerson)
    return {
      ok: false,
      reason: "The assistant already spoke with them about this round; these times go by e-mail.",
    };

  const [earlier] = await db
    .select({ id: interviewSlotOffers.id })
    .from(interviewSlotOffers)
    .where(
      and(
        eq(interviewSlotOffers.orgId, orgId),
        eq(interviewSlotOffers.applicationId, applicationId),
        eq(interviewSlotOffers.level, offer.level),
        inArray(interviewSlotOffers.status, ["declined", "expired"]),
        ne(interviewSlotOffers.id, offer.id),
      ),
    )
    .limit(1);
  const repeat = Boolean(earlier);
  const callableAt = offer.createdAt.getTime() + policy.schedulingWaitHours * 3600_000;
  if (!repeat && !opts.byPerson && callableAt > now) {
    const hours = Math.ceil((callableAt - now) / 3600_000);
    return {
      ok: false,
      reason: `The times were e-mailed less than ${policy.schedulingWaitHours} hours ago; a call can be asked for in about ${hours} hour${hours === 1 ? "" : "s"}.`,
    };
  }
  return {
    ok: true,
    offer,
    candidateId: app.candidateId,
    requisitionId: app.requisitionId,
    repeat,
  };
}

/**
 * Up to three more times free for the interviewer(s), at least a day ahead and
 * after the candidate's earlier round, not already offered.
 */
export async function findAlternates(
  orgId: string,
  offer: InterviewSlotOffer,
  now = Date.now(),
): Promise<string[]> {
  const { findFreeSlots, roundNotBefore } = await import("@/lib/calendar-availability.server");
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const timeZone = (await getOrgEmailSettings(orgId)).timezone;
  const r = await findFreeSlots(orgId, {
    interviewerEmail: offer.interviewerEmail,
    panelEmails: (offer.panel ?? []).map((p) => p.email),
    durationMins: offer.durationMins,
    count: 8,
    timeZone,
    notBefore: await roundNotBefore(orgId, offer.applicationId, offer.level),
  });
  const offered = new Set(offer.slots.map((s) => new Date(s).toISOString()));
  return r.slots
    .map((s) => new Date(s).toISOString())
    .filter((s) => !offered.has(s) && new Date(s).getTime() >= now + DAY)
    .slice(0, 3);
}

/**
 * Arrange the call (status approved — a person approved it, or the request was
 * pre-approved), due at the next moment inside the calling window, with its
 * alternates checked now. Audited `scheduling_call.requested`.
 */
export async function requestSchedulingCall(input: {
  orgId: string;
  applicationId: string;
  requestedBy: string;
  requestedRunId: string | null;
  actor: string;
  now?: number;
  /** A person on the team arranged it (may call before the organisation's wait). */
  byPerson?: boolean;
}): Promise<{ callId: string; dueAt: Date; options: number }> {
  const now = input.now ?? Date.now();
  const check = await checkSchedulingCall(input.orgId, input.applicationId, now, {
    byPerson: Boolean(input.byPerson),
  });
  if (!check.ok) throw new Error(check.reason);
  const alternates = await findAlternates(input.orgId, check.offer, now);
  const policy = await phoneScreeningPolicyOf(input.orgId);
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(input.orgId)).timezone;
  const dueAt = nextWindowStart(now, policy, tz);
  const [row] = await db
    .insert(screeningCalls)
    .values({
      orgId: input.orgId,
      candidateId: check.candidateId,
      applicationId: input.applicationId,
      requisitionId: check.requisitionId,
      purpose: "scheduling",
      slotOfferId: check.offer.id,
      alternates,
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
    action: "scheduling_call.requested",
    entityType: "screening_call",
    entityId: row!.id,
    detail: {
      applicationId: input.applicationId,
      offerId: check.offer.id,
      alternates: alternates.length,
      repeat: check.repeat,
      byPerson: Boolean(input.byPerson),
      dueAt: dueAt.toISOString(),
    },
  });
  return { callId: row!.id, dueAt, options: check.offer.slots.length + alternates.length };
}

/**
 * Trigger: e-mailed times left unanswered for the organisation's wait (and
 * still callable). Raises `interview.slots_no_reply` once per offer so the
 * Interview coordinator can ask for a scheduling call. Run by the agent tick.
 */
export async function raiseUnansweredOffers(now = Date.now(), orgId?: string): Promise<number> {
  const rows = (await db.execute(sql`
    select o.id, o.org_id, o.application_id, o.level
    from interview_slot_offers o
    join phone_screening_settings s on s.org_id = o.org_id
    where o.status = 'offered'
      and s.enabled and s.scheduling_enabled
      ${orgId ? sql`and o.org_id = ${orgId}` : sql``}
      and o.expires_at > ${new Date(now).toISOString()}::timestamptz
      and o.created_at <= ${new Date(now).toISOString()}::timestamptz - make_interval(hours => s.scheduling_wait_hours)
      and not exists (select 1 from screening_calls c where c.slot_offer_id = o.id and c.status <> 'cancelled')
      and not exists (
        select 1 from agent_events e
        where e.org_id = o.org_id and e.type = 'interview.slots_no_reply'
          and e.payload ->> 'offerId' = o.id::text)
    limit 50`)) as unknown as {
    id: string;
    org_id: string;
    application_id: string;
    level: number;
  }[];
  const { emitAgentEvent } = await import("../agents/events");
  let raised = 0;
  for (const r of rows) {
    // Only offers a call could still help (a day ahead, a dialable candidate…).
    const c = await checkSchedulingCall(r.org_id, r.application_id, now);
    if (!c.ok) continue;
    await emitAgentEvent({
      orgId: r.org_id,
      type: "interview.slots_no_reply",
      subjectType: "application",
      subjectId: r.application_id,
      actorUserId: null,
      payload: { applicationId: r.application_id, offerId: r.id, level: r.level },
    });
    raised++;
  }
  return raised;
}
