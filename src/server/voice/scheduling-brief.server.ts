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
  interviews,
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

const ORDINAL = ["first", "second", "third"];
const NUMBER = ["one", "two", "three"];

/**
 * Where the candidate stands, in plain words the assistant may say (pure;
 * unit-tested): screening done, earlier rounds done or booked, which round
 * this is of how many, and what happens after. Never a score, feedback,
 * verdict or ranking.
 */
export function progressWords(p: {
  screened: boolean;
  /** Earlier rounds: done (scored) or booked (with when, already spoken). */
  earlier: { level: number; done: boolean; when: string | null }[];
  level: number;
  totalRounds: number;
  roundName: string | null;
  /** How many interviewers this round has: one person or a panel. */
  panelSize?: number;
}): string {
  const round = (l: number) => `${ORDINAL[l - 1] ?? `round ${l}`}-round interview`;
  const done = [
    ...(p.screened ? ["the screening"] : []),
    ...p.earlier.filter((r) => r.done).map((r) => `the ${round(r.level)}`),
  ];
  const booked = p.earlier.filter((r) => !r.done && r.when);
  const parts: string[] = [];
  if (done.length)
    parts.push(
      `You have completed ${done.length > 1 ? `${done.slice(0, -1).join(", ")} and ${done.at(-1)}` : done[0]}.`,
    );
  for (const r of booked) parts.push(`Your ${round(r.level)} is booked for ${r.when}.`);
  const total = NUMBER[p.totalRounds - 1] ?? String(p.totalRounds);
  parts.push(
    `This call is about the ${round(p.level)}${p.roundName ? ` (${p.roundName})` : ""} — round ${p.level} of ${total}.`,
  );
  parts.push(
    p.level >= p.totalRounds
      ? "It is the last interview round: after it, the hiring team makes its decision and will e-mail you."
      : `After this round, ${(p.panelSize ?? 1) > 1 ? "the panel shares its" : "the interviewer shares their"} feedback with the hiring team, who will e-mail you about the next step.`,
  );
  return parts.join(" ");
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
  // Where they stand: the role's plan, their earlier rounds, the screening.
  const { progressOf } = await import("@/lib/interview-plan.server");
  const { screeningOnRecord } = await import("@/lib/pipeline.server");
  const prog = await progressOf(orgId, row.offer.applicationId);
  const booked = await db
    .select({ level: interviews.level, at: interviews.scheduledAt, status: interviews.status })
    .from(interviews)
    .where(and(eq(interviews.orgId, orgId), eq(interviews.applicationId, row.offer.applicationId)));
  const earlier = [...new Set(booked.map((b) => b.level))]
    .filter((l) => l < row.offer.level)
    .sort((a, b) => a - b)
    .map((level) => {
      const done = prog.rounds.some((r) => r.level === level && r.complete);
      const next = booked.find(
        (b) => b.level === level && b.at && !["cancelled", "no_show"].includes(b.status),
      );
      return {
        level,
        done,
        when: !done && next?.at ? spokenWhen(next.at.toISOString(), tz) : null,
      };
    });
  const planRound = prog.plan.rounds.find((r) => r.level === row.offer.level);
  const progress = progressWords({
    screened: await screeningOnRecord(orgId, row.offer.applicationId),
    earlier,
    level: row.offer.level,
    totalRounds: prog.plan.rounds.length,
    roundName: planRound?.name ?? null,
    panelSize: 1 + (row.offer.panel?.length ?? 0),
  });
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
      // How many interviewers — never who (staff are confidential).
      panelSize: 1 + (row.offer.panel?.length ?? 0),
      progress,
      options: options.map((o) => ({ spoken: spokenWhen(o.at, tz), alternate: o.alternate })),
      maxMinutes: 4,
      isCallback: row.call.bookedByCandidate,
      callbackAllowed: row.call.reschedules < 1,
    },
  };
}
