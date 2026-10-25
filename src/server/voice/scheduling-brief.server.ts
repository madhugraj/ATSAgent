/**
 * The facts for one scheduling call (docs/voice-scheduling-call-plan.md): the
 * e-mailed offer it follows up, the times it may book — the offer's times still
 * far enough ahead, then the call's pre-checked alternates — and how to say
 * them in the organisation's time zone.
 */
import { and, eq } from "drizzle-orm";

import {
  applications,
  candidates,
  interviewSlotOffers,
  organizations,
  requisitions,
  screeningCalls,
} from "@db/schema";
import { db } from "../db";
import type { SchedulingFacts } from "./scheduling-prompt";
import { MAX_OPTIONS } from "./scheduling-call-tools";
import { phoneScreeningPolicyOf } from "./settings.server";

const ROUND = ["first-round", "second-round", "third-round"];
const FORMAT: Record<string, string> = {
  online: "online (video call)",
  onsite: "in person",
  phone: "by phone",
};

/** "Tuesday 27 October at 11:30" in the time zone — as the assistant says it (pure). */
export function spokenWhen(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(iso));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("day")} ${p("month")} at ${p("hour")}:${p("minute")}`;
}

/**
 * The times a call may book, in order (pure; unit-tested): the offer's times,
 * then the alternates — each at least `leadMs` from now, no repeats, at most
 * MAX_OPTIONS.
 */
export function bookableOptions(
  offered: string[],
  alternates: string[],
  now: number,
  leadMs: number,
): { at: string; alternate: boolean }[] {
  const seen = new Set<string>();
  const out: { at: string; alternate: boolean }[] = [];
  for (const [list, alternate] of [
    [offered, false],
    [alternates.slice(0, 3), true],
  ] as const)
    for (const raw of list) {
      const t = new Date(raw).getTime();
      if (Number.isNaN(t) || t < now + leadMs) continue;
      const at = new Date(t).toISOString();
      if (seen.has(at)) continue;
      seen.add(at);
      out.push({ at, alternate });
    }
  return out.slice(0, MAX_OPTIONS);
}

export type SchedulingBrief = {
  facts: SchedulingFacts;
  /** ISO start times, index = option number − 1. */
  options: string[];
  offer: typeof interviewSlotOffers.$inferSelect;
  candidateId: string;
};

export async function loadSchedulingBrief(
  orgId: string,
  callId: string,
  now = Date.now(),
): Promise<SchedulingBrief | null> {
  const [row] = await db
    .select({
      call: screeningCalls,
      offer: interviewSlotOffers,
      candidateId: candidates.id,
      fullName: candidates.fullName,
      roleTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(screeningCalls)
    .innerJoin(interviewSlotOffers, eq(interviewSlotOffers.id, screeningCalls.slotOfferId))
    .innerJoin(applications, eq(applications.id, screeningCalls.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, screeningCalls.orgId))
    .where(
      and(
        eq(screeningCalls.id, callId),
        eq(screeningCalls.orgId, orgId),
        eq(screeningCalls.purpose, "scheduling"),
        eq(interviewSlotOffers.orgId, orgId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const { SLOT_OFFER } = await import("@/lib/slot-offers.server");
  const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const policy = await phoneScreeningPolicyOf(orgId);
  const options = bookableOptions(
    row.offer.slots,
    row.call.alternates,
    now,
    SLOT_OFFER.pickLeadHours * 3600_000,
  );
  return {
    offer: row.offer,
    candidateId: row.candidateId,
    options: options.map((o) => o.at),
    facts: {
      assistantName: policy.assistantName,
      orgName: row.orgName,
      candidateFirstName: row.fullName.trim().split(/\s+/)[0] ?? row.fullName,
      roleTitle: row.roleTitle,
      roundLabel: `${ROUND[row.offer.level - 1] ?? `round ${row.offer.level}`} interview`,
      durationMins: row.offer.durationMins,
      format: FORMAT[row.offer.mode] ?? row.offer.mode,
      // A person's name, or "a member of the hiring team" — never a guess from an
      // e-mail address ("agent-demo@…" was said as "Agent", heard as an AI interviewer).
      interviewerName: row.offer.interviewerName?.trim() || "a member of the hiring team",
      panelSize: 1 + (row.offer.panel?.length ?? 0),
      options: options.map((o) => ({ spoken: spokenWhen(o.at, tz), alternate: o.alternate })),
      maxMinutes: 4,
      isCallback: row.call.bookedByCandidate,
      callbackAllowed: row.call.reschedules < 1,
    },
  };
}
