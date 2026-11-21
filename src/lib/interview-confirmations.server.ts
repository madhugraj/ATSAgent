/**
 * Interview time confirmations (migration 0085). Nobody is told a time the
 * panel has not agreed:
 *
 * - Times offered for the candidate to pick (slot offers): each panelist is
 *   asked first; only when every panelist accepts is the candidate contacted —
 *   voice first (the AI call, else the e-mailed link). One decline cancels the
 *   offer and tells the hiring team.
 * - A round a person (or the Interview coordinator) books directly: each
 *   panelist accepts or declines from their brief; the candidate's invite is
 *   `held` until the whole panel accepts, and then asks the candidate to
 *   confirm. A round the candidate picked is already confirmed by them.
 *
 * Answers come through private token links (public, rate-limited server fns).
 * The hiring team can release a held invite themselves (audited).
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  applications,
  candidates,
  interviewConfirmations,
  interviewSlotOffers,
  interviews,
  organizations,
  requisitions,
} from "@db/schema";

type Person = { name: string | null; email: string };
/** `lapsed`: a panelist's answer window closed unanswered and the round went ahead. */
export type ConfirmState = "pending" | "accepted" | "declined" | "superseded" | "lapsed";

const newToken = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

/** The candidate's invite for this round and time — its outbox key prefix. */
export const invitePrefix = (interviewId: string) => `interview-invite:${interviewId}:`;
/** The slot-offer e-mail's outbox key. */
export const offerKey = (offerId: string) => `interview-slots:${offerId}`;

/** Whether a booking's actor label means the candidate chose the time themselves. */
export const candidatePicked = (actor: string) => /^candidate\b/i.test(actor);

/**
 * Every panelist has accepted (pure). No panelists with an email: nothing to
 * wait for.
 */
export function panelAgreed(rows: { party: string; state: string }[]): boolean {
  const live = rows.filter((r) => r.party === "panelist" && r.state !== "superseded");
  return live.every((r) => r.state === "accepted" || r.state === "lapsed");
}

/** Old answers no longer apply once the round moves to another time. */
export async function supersedeForInterview(
  orgId: string,
  interviewId: string,
  keepAt: Date,
): Promise<void> {
  await db
    .update(interviewConfirmations)
    .set({ state: "superseded" })
    .where(
      and(
        eq(interviewConfirmations.orgId, orgId),
        eq(interviewConfirmations.interviewId, interviewId),
        sql`${interviewConfirmations.state} <> 'superseded'`,
        sql`${interviewConfirmations.scheduledAt} is distinct from ${keepAt.toISOString()}::timestamptz`,
      ),
    );
  const { dropHeldEmails } = await import("./email-outbox.server");
  // The held invite for the old time never goes out; the new one carries the new time.
  await dropHeldEmails(orgId, invitePrefix(interviewId)).catch(() => {});
}

/** A panelist stood down from a round: their answer no longer counts. */
export async function supersedePanelist(
  orgId: string,
  interviewId: string,
  email: string,
): Promise<void> {
  await db
    .update(interviewConfirmations)
    .set({ state: "superseded" })
    .where(
      and(
        eq(interviewConfirmations.orgId, orgId),
        eq(interviewConfirmations.interviewId, interviewId),
        eq(interviewConfirmations.party, "panelist"),
        eq(interviewConfirmations.email, email.toLowerCase()),
      ),
    );
}

/**
 * The panelist's confirmation row for this round and time — created once.
 * `accepted` when they already agreed this time on an offer.
 */
export async function panelistConfirmation(
  orgId: string,
  interviewId: string,
  scheduledAt: Date,
  p: Person,
): Promise<{ token: string; state: ConfirmState; created: boolean }> {
  const email = p.email.toLowerCase();
  const [have] = await db
    .select({ token: interviewConfirmations.token, state: interviewConfirmations.state })
    .from(interviewConfirmations)
    .where(
      and(
        eq(interviewConfirmations.orgId, orgId),
        eq(interviewConfirmations.interviewId, interviewId),
        eq(interviewConfirmations.party, "panelist"),
        eq(interviewConfirmations.email, email),
        eq(interviewConfirmations.scheduledAt, scheduledAt),
        sql`${interviewConfirmations.state} <> 'superseded'`,
      ),
    )
    .limit(1);
  if (have) return { ...have, created: false };
  const agreed =
    (await agreedOnOffer(orgId, interviewId, email, scheduledAt)) ||
    (await suggestedThis(orgId, interviewId, email, scheduledAt));
  const token = newToken();
  const state: ConfirmState = agreed ? "accepted" : "pending";
  await db.insert(interviewConfirmations).values({
    orgId,
    interviewId,
    party: "panelist",
    email,
    name: p.name,
    token,
    state,
    scheduledAt,
    respondedAt: agreed ? new Date() : null,
  });
  return { token, state, created: true };
}

/** Did this panelist suggest this very time for the round? */
async function suggestedThis(
  orgId: string,
  interviewId: string,
  email: string,
  at: Date,
): Promise<boolean> {
  const [x] = await db
    .select({ id: interviewConfirmations.id })
    .from(interviewConfirmations)
    .where(
      and(
        eq(interviewConfirmations.orgId, orgId),
        eq(interviewConfirmations.interviewId, interviewId),
        eq(interviewConfirmations.email, email),
        eq(interviewConfirmations.suggestedAt, at),
      ),
    )
    .limit(1);
  return Boolean(x);
}

/** Did this panelist accept an offer for this round that included this time? */
async function agreedOnOffer(
  orgId: string,
  interviewId: string,
  email: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .select({ slots: interviewSlotOffers.slots })
    .from(interviewConfirmations)
    .innerJoin(interviewSlotOffers, eq(interviewSlotOffers.id, interviewConfirmations.offerId))
    .where(
      and(
        eq(interviewConfirmations.orgId, orgId),
        eq(interviewConfirmations.email, email),
        eq(interviewConfirmations.state, "accepted"),
        eq(interviewSlotOffers.interviewId, interviewId),
      ),
    );
  return rows.some((r) => r.slots.some((s) => Date.parse(s) === at.getTime()));
}

/** The candidate's confirmation row for a round a person booked. */
export async function candidateConfirmation(
  orgId: string,
  interviewId: string,
  scheduledAt: Date,
  c: Person,
  state: ConfirmState,
): Promise<string> {
  // One live answer per booking: an earlier one for the same time is replaced.
  await db
    .update(interviewConfirmations)
    .set({ state: "superseded" })
    .where(
      and(
        eq(interviewConfirmations.orgId, orgId),
        eq(interviewConfirmations.interviewId, interviewId),
        eq(interviewConfirmations.party, "candidate"),
        sql`${interviewConfirmations.state} <> 'superseded'`,
      ),
    );
  const token = newToken();
  await db.insert(interviewConfirmations).values({
    orgId,
    interviewId,
    party: "candidate",
    email: c.email.toLowerCase(),
    name: c.name,
    token,
    state,
    scheduledAt,
    respondedAt: state === "accepted" ? new Date() : null,
  });
  return token;
}

/** Live rows for a round. */
async function liveRows(orgId: string, where: { interviewId?: string; offerId?: string }) {
  return db
    .select()
    .from(interviewConfirmations)
    .where(
      and(
        eq(interviewConfirmations.orgId, orgId),
        where.interviewId
          ? eq(interviewConfirmations.interviewId, where.interviewId)
          : eq(interviewConfirmations.offerId, where.offerId!),
        sql`${interviewConfirmations.state} <> 'superseded'`,
      ),
    );
}

/** Send the held candidate invite once the whole panel has accepted. */
export async function releaseIfAgreed(orgId: string, interviewId: string): Promise<boolean> {
  const rows = await liveRows(orgId, { interviewId });
  if (!panelAgreed(rows)) return false;
  const { releaseHeldEmails } = await import("./email-outbox.server");
  return (await releaseHeldEmails(orgId, invitePrefix(interviewId))) > 0;
}

/**
 * Ask each panelist whether the offered times work, before the candidate's
 * (held) e-mail goes out.
 */
export async function askPanelAboutOffer(
  orgId: string,
  offer: {
    id: string;
    level: number;
    durationMins: number;
    slots: Date[];
    people: Person[];
    applicationId: string;
  },
): Promise<void> {
  const { enqueueEmail, formatInOrgTZ, getOrgEmailSettings } =
    await import("./email-outbox.server");
  const { env } = await import("../server/env");
  const site = env.PUBLIC_SITE_URL.replace(/\/$/, "");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const [ctx] = await db
    .select({
      jobTitle: requisitions.title,
      orgName: organizations.name,
      candidateName: candidates.fullName,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, offer.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  const seen = new Set<string>();
  for (const p of offer.people) {
    const email = p.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const token = newToken();
    await db.insert(interviewConfirmations).values({
      orgId,
      offerId: offer.id,
      party: "panelist",
      email,
      name: p.name,
      token,
    });
    await enqueueEmail({
      orgId,
      kind: "panel_time_check",
      templateName: "panel_time_check",
      toEmail: email,
      applicationId: offer.applicationId,
      idempotencyKey: `panel-time-check:${offer.id}:${email}`,
      templateData: {
        interviewerName: p.name ?? undefined,
        orgName: ctx?.orgName,
        candidateName: ctx?.candidateName ?? undefined,
        jobTitle: ctx?.jobTitle,
        roundLabel: `L${offer.level} interview`,
        durationMins: String(offer.durationMins),
        slotsText: offer.slots.map((d) => formatInOrgTZ(d, tz)).join("\n"),
        confirmUrl: `${site}/confirm/${token}`,
      },
    });
  }
}

/* ------------------------------------------------------------ public page */

export type PublicConfirmation = {
  party: "panelist" | "candidate";
  /** offer: times to tick before the candidate is offered them; round: one booked time. */
  kind: "offer" | "round";
  state: ConfirmState;
  candidateName: string | null;
  jobTitle: string;
  orgName: string;
  roundLabel: string;
  durationMins: number;
  timeZone: string;
  /** The booked time, or the times on offer. */
  times: string[];
  /** The round no longer happens, or the offer is closed. */
  closed: boolean;
};

export async function rowByToken(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const [r] = await db
    .select()
    .from(interviewConfirmations)
    .where(eq(interviewConfirmations.token, token))
    .limit(1);
  return r ?? null;
}

async function contextOf(r: typeof interviewConfirmations.$inferSelect) {
  if (r.interviewId) {
    const [i] = await db
      .select({
        applicationId: interviews.applicationId,
        level: interviews.level,
        durationMins: interviews.durationMins,
        scheduledAt: interviews.scheduledAt,
        status: interviews.status,
        unavailable: interviews.unavailable,
      })
      .from(interviews)
      .where(and(eq(interviews.id, r.interviewId), eq(interviews.orgId, r.orgId)))
      .limit(1);
    if (!i) return null;
    return {
      applicationId: i.applicationId,
      level: i.level,
      durationMins: i.durationMins,
      times: r.scheduledAt ? [r.scheduledAt.toISOString()] : [],
      closed:
        !["scheduled", "rescheduled"].includes(i.status) ||
        !i.scheduledAt ||
        i.scheduledAt.getTime() <= Date.now(),
    };
  }
  const [o] = await db
    .select({
      applicationId: interviewSlotOffers.applicationId,
      level: interviewSlotOffers.level,
      durationMins: interviewSlotOffers.durationMins,
      slots: interviewSlotOffers.slots,
      status: interviewSlotOffers.status,
    })
    .from(interviewSlotOffers)
    .where(and(eq(interviewSlotOffers.id, r.offerId!), eq(interviewSlotOffers.orgId, r.orgId)))
    .limit(1);
  if (!o) return null;
  return {
    applicationId: o.applicationId,
    level: o.level,
    durationMins: o.durationMins,
    times: o.slots,
    closed: o.status !== "offered",
  };
}

export async function publicConfirmation(token: string): Promise<PublicConfirmation | null> {
  const r = await rowByToken(token);
  if (!r) return null;
  const c = await contextOf(r);
  if (!c) return null;
  const [ctx] = await db
    .select({
      jobTitle: requisitions.title,
      orgName: organizations.name,
      candidateName: candidates.fullName,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, c.applicationId), eq(applications.orgId, r.orgId)))
    .limit(1);
  if (!ctx) return null;
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  return {
    party: r.party,
    kind: r.offerId ? "offer" : "round",
    state: r.state,
    // The candidate sees only their own role; the panelist sees whom they interview.
    candidateName: r.party === "panelist" ? ctx.candidateName : null,
    jobTitle: ctx.jobTitle,
    orgName: ctx.orgName,
    roundLabel: `L${c.level} interview`,
    durationMins: c.durationMins,
    timeZone: (await getOrgEmailSettings(r.orgId)).timezone,
    times: c.times,
    closed: c.closed || r.state === "superseded",
  };
}

export type AnswerResult = { ok: true; state: ConfirmState } | { ok: false; error: string };

/** What a person answers. `note` is their own words (untrusted, stored as text). */
export type Answer = {
  accept: boolean;
  note?: string | null;
  /** Offers: the offered times (ISO) this panelist can do; absent = all of them. */
  okSlots?: string[];
  /** Another time that suits them (ISO). */
  suggestedAt?: string | null;
};

/** Which of `times` a panelist can do (pure): the ones ticked, or all when accepting without ticks. */
export function workableTimes(times: string[], a: Answer): string[] {
  if (!a.accept) return [];
  if (!a.okSlots) return times;
  const ok = new Set(a.okSlots.map((t) => Date.parse(t)));
  return times.filter((t) => ok.has(Date.parse(t)));
}

/** The times every panelist can do (pure); `null` okSlots on an accepted row means all. */
export function commonTimes(
  times: string[],
  rows: { party: string; state: string; okSlots: string[] | null }[],
): string[] {
  // A panelist whose answer window lapsed does not hold the others up; they are
  // asked again for the booked time.
  const panel = rows.filter(
    (r) => r.party === "panelist" && r.state !== "superseded" && r.state !== "lapsed",
  );
  return times.filter((t) =>
    panel.every((r) => {
      if (r.state !== "accepted") return false;
      if (!r.okSlots) return true;
      return r.okSlots.some((x) => Date.parse(x) === Date.parse(t));
    }),
  );
}

/** A panelist's or candidate's answer. */
export async function answerConfirmation(
  token: string,
  acceptOrAnswer: boolean | Answer,
  note?: string | null,
): Promise<AnswerResult> {
  const a: Answer =
    typeof acceptOrAnswer === "boolean"
      ? { accept: acceptOrAnswer, note: note ?? null }
      : acceptOrAnswer;
  const r = await rowByToken(token);
  if (!r) return { ok: false, error: "This link is not valid." };
  const c = await contextOf(r);
  if (!c || c.closed || r.state === "superseded")
    return { ok: false, error: "This time no longer stands; the team will be in touch." };
  if (r.state !== "pending")
    return { ok: false, error: `You already ${r.state === "accepted" ? "accepted" : "declined"}.` };
  const okSlots = r.offerId ? workableTimes(c.times, a) : null;
  // Ticking none of the offered times is a "no".
  const accept = r.offerId ? okSlots!.length > 0 : a.accept;
  const state: ConfirmState = accept ? "accepted" : "declined";
  const clean = a.note?.trim().slice(0, 500) || null;
  let suggestedAt: Date | null = null;
  if (a.suggestedAt) {
    const t = new Date(a.suggestedAt);
    if (Number.isNaN(t.getTime()) || t.getTime() < Date.now() + 3600_000)
      return { ok: false, error: "Suggest a time at least an hour from now." };
    if (t.getTime() > Date.now() + 60 * 864e5)
      return { ok: false, error: "Suggest a time within the next 60 days." };
    suggestedAt = t;
  }
  const [updated] = await db
    .update(interviewConfirmations)
    .set({ state, note: clean, okSlots, suggestedAt, respondedAt: new Date() })
    .where(and(eq(interviewConfirmations.id, r.id), eq(interviewConfirmations.state, "pending")))
    .returning({ id: interviewConfirmations.id });
  if (!updated) return { ok: false, error: "You already answered." };

  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `${r.party}:${r.email}`,
    orgId: r.orgId,
    action: `interview.time_${state}`,
    entityType: r.interviewId ? "interview" : "interview_slot_offer",
    entityId: (r.interviewId ?? r.offerId)!,
    detail: {
      party: r.party,
      level: c.level,
      note: clean,
      ...(okSlots ? { okSlots } : {}),
      ...(suggestedAt ? { suggestedAt: suggestedAt.toISOString() } : {}),
    },
  });

  const row = { ...r, state, note: clean, okSlots, suggestedAt };
  if (r.offerId) await afterOfferAnswer(r.orgId, r.offerId, row, c);
  else if (r.interviewId) await afterRoundAnswer(r.orgId, r.interviewId, row, accept, clean, c);
  return { ok: true, state };
}

type Ctx = NonNullable<Awaited<ReturnType<typeof contextOf>>>;
type Row = typeof interviewConfirmations.$inferSelect;

/**
 * Once every panelist has answered an offer: the candidate is offered only the
 * times they can all do — voice first. With none in common the offer is
 * cancelled before the candidate hears of it and the Interview coordinator is
 * asked for new times, with the panel's suggestions.
 */
async function afterOfferAnswer(orgId: string, offerId: string, _r: Row, c: Ctx) {
  const rows = await liveRows(orgId, { offerId });
  if (rows.some((x) => x.party === "panelist" && x.state === "pending")) return;
  const common = commonTimes(c.times, rows);
  const { SLOT_OFFER, contactCandidate, withdrawOfferEmails } =
    await import("./slot-offers.server");
  if (common.length) {
    // The candidate's clock starts now: the link's life and the wait before any
    // follow-up are counted from when they are first contacted.
    const now = Date.now();
    const first = Math.min(...common.map((t) => Date.parse(t)));
    const [claimed] = await db
      .update(interviewSlotOffers)
      .set({
        slots: common,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        expiresAt: new Date(
          Math.min(
            now + SLOT_OFFER.expiresHours * 3600_000,
            first - SLOT_OFFER.pickLeadHours * 3600_000,
          ),
        ),
      })
      .where(
        and(
          eq(interviewSlotOffers.id, offerId),
          eq(interviewSlotOffers.orgId, orgId),
          eq(interviewSlotOffers.status, "offered"),
          sql`${interviewSlotOffers.linkEmailedAt} is null`,
        ),
      )
      .returning({ id: interviewSlotOffers.id });
    // Voice first: the AI call, else the e-mailed link.
    if (claimed) await contactCandidate(orgId, offerId);
    return;
  }
  // No time suits the whole panel: the offer never reaches the candidate.
  await db
    .update(interviewSlotOffers)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(interviewSlotOffers.id, offerId), eq(interviewSlotOffers.orgId, orgId)));
  await withdrawOfferEmails(orgId, [offerId]);
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  const { localWhen } = await import("./local-time");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const panel = rows.filter((x) => x.party === "panelist");
  const suggested = panel
    .filter((x) => x.suggestedAt)
    .map((x) => ({ email: x.email, at: x.suggestedAt!.toISOString() }));
  const said = panel
    .map((x) => {
      const ok = (x.okSlots ?? []).map((t) => localWhen(new Date(t), tz));
      return `${x.name ?? x.email}: ${ok.length ? `can do ${ok.join(", ")}` : "none of them"}${
        x.suggestedAt ? `; suggests ${localWhen(x.suggestedAt, tz)}` : ""
      }${x.note ? ` ("${x.note}")` : ""}`;
    })
    .join(". ");
  const [o] = await db
    .select({ panel: interviewSlotOffers.panel, lead: interviewSlotOffers.interviewerEmail })
    .from(interviewSlotOffers)
    .where(eq(interviewSlotOffers.id, offerId))
    .limit(1);
  const { emitAgentEvent } = await import("../server/agents/events");
  await emitAgentEvent({
    orgId,
    type: "interview.panel_times_rejected",
    subjectType: "application",
    subjectId: c.applicationId,
    actorUserId: null,
    payload: {
      offerId,
      level: c.level,
      interviewerEmail: o?.lead ?? null,
      panelEmails: (o?.panel ?? []).map((p) => p.email),
      suggested,
      said,
    },
  });
  await tellDesk(
    orgId,
    c.applicationId,
    (cand) =>
      `No proposed L${c.level} time suits the whole panel for ${cand} (${said}). The times were not sent to the candidate; the Interview coordinator offers new ones${suggested.length ? ", starting from the panel's suggestions" : ""}.`,
  );
}

async function afterRoundAnswer(
  orgId: string,
  interviewId: string,
  r: Row,
  accept: boolean,
  note: string | null,
  c: Ctx,
) {
  if (r.party === "panelist") {
    if (accept) {
      await releaseIfAgreed(orgId, interviewId);
      return;
    }
    // A time they suggest, while the candidate has not been told: move the round
    // there if the rest of the panel is free, and ask the panel again.
    if (r.suggestedAt && (await moveToSuggested(orgId, interviewId, r, c))) return;
    // Same record as "I can't make it" on My interviews: a stand-in is arranged.
    await db
      .update(interviews)
      .set({
        unavailable: sql`${interviews.unavailable} || ${JSON.stringify([
          { email: r.email, note, at: new Date().toISOString() },
        ])}::jsonb`,
      })
      .where(and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)));
    // …and the same event, so the Interview coordinator proposes a stand-in.
    await raiseUnavailable(orgId, c.applicationId, interviewId, c.level, r, note);
    await tellDesk(
      orgId,
      c.applicationId,
      (cand) =>
        `${r.name ?? r.email} cannot make ${cand}'s L${c.level} interview at the booked time${note ? ` ("${note}")` : ""}${r.suggestedAt ? `, and the suggested time ${r.suggestedAt.toISOString()} does not suit the rest of the panel or the candidate already has the invite` : ""}. The Interview coordinator proposes a stand-in for you to approve, or re-schedule the round.`,
    );
    return;
  }
  if (!accept)
    await tellDesk(
      orgId,
      c.applicationId,
      (cand) =>
        `${cand} cannot make their L${c.level} interview at the booked time${note ? ` ("${note}")` : ""}. Re-schedule it.`,
    );
}

/**
 * Are these people free at this time — no other round in ATSIQ (this round
 * itself aside) and nothing busy on a connected calendar? `checked` is false
 * when any of their calendars could not be read.
 */
export async function allFree(
  orgId: string,
  emails: string[],
  at: Date,
  durationMins: number,
  exceptInterviewId?: string,
): Promise<{ free: boolean; checked: boolean }> {
  const list = emails.map((e) => e.toLowerCase());
  if (!list.length) return { free: true, checked: true };
  const end = new Date(at.getTime() + durationMins * 60_000);
  const clash = await db
    .select({ id: interviews.id })
    .from(interviews)
    .where(
      and(
        eq(interviews.orgId, orgId),
        exceptInterviewId ? sql`${interviews.id} <> ${exceptInterviewId}` : sql`true`,
        sql`${interviews.status} not in ('cancelled','no_show','completed')`,
        sql`(lower(${interviews.interviewerEmail}) in (${sql.join(
          list.map((e) => sql`${e}`),
          sql`, `,
        )}) or ${sql.join(
          list.map((e) => sql`${interviews.panel} @> ${JSON.stringify([{ email: e }])}::jsonb`),
          sql` or `,
        )})`,
        sql`${interviews.scheduledAt} < ${end.toISOString()}::timestamptz`,
        sql`${interviews.scheduledAt} + make_interval(mins => ${interviews.durationMins}) > ${at.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  const { busyFor } = await import("./calendar-availability.server");
  const cal = await busyFor(orgId, list, at, end);
  const checked = Boolean(cal.source) && !list.some((e) => cal.unknown.includes(e));
  if (clash.length) return { free: false, checked };
  const hit = list.some((e) =>
    (cal.busy[e] ?? []).some((b) => b.start < end.getTime() && b.end > at.getTime()),
  );
  return { free: !hit, checked };
}

/** Is the candidate's invite for this round still waiting on the panel? */
async function inviteHeld(orgId: string, interviewId: string): Promise<boolean> {
  const { emailOutbox } = await import("@db/schema");
  const [h] = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.orgId, orgId),
        eq(emailOutbox.status, "held"),
        sql`${emailOutbox.idempotencyKey} like ${`${invitePrefix(interviewId)}%`}`,
      ),
    )
    .limit(1);
  return Boolean(h);
}

/**
 * Re-book the round at the panelist's suggested time when the candidate has not
 * been told and everyone else on the panel is free then. The panel is asked
 * again (the one who suggested it is already agreed). Returns whether it moved.
 */
async function moveToSuggested(
  orgId: string,
  interviewId: string,
  r: Row & { suggestedAt: Date | null },
  c: Ctx,
): Promise<boolean> {
  if (!r.suggestedAt || !(await inviteHeld(orgId, interviewId))) return false;
  const at = r.suggestedAt;
  const [i] = await db
    .select()
    .from(interviews)
    .where(and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)))
    .limit(1);
  if (!i || !i.scheduledAt) return false;
  const others = [
    ...(i.interviewerEmail ? [i.interviewerEmail] : []),
    ...(i.panel ?? []).map((p) => p.email),
  ]
    .map((e) => e.toLowerCase())
    .filter((e) => e !== r.email);
  const { assertAfterEarlierRounds } = await import("./calendar-availability.server");
  try {
    await assertAfterEarlierRounds(orgId, c.applicationId, i.level, [at]);
  } catch {
    return false;
  }
  if (others.length && !(await allFree(orgId, others, at, i.durationMins, interviewId)).free)
    return false;
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  const { localWhen } = await import("./local-time");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  const who = r.name ?? r.email;
  const { scheduleInterviewCore } = await import("./interviews.functions");
  await scheduleInterviewCore(
    { orgId, actor: `panel (time suggested by ${who})` },
    {
      applicationId: c.applicationId,
      level: i.level,
      interviewId,
      rescheduleReason: `${who} cannot make ${localWhen(i.scheduledAt, tz)} and suggested ${localWhen(at, tz)}; the rest of the panel is free then. The candidate had not been told.`,
      interviewer: i.interviewer,
      interviewerEmail: i.interviewerEmail,
      scheduledAt: at.toISOString(),
      durationMins: i.durationMins,
      mode: i.mode as "online" | "onsite" | "phone",
      meetingLink: i.teamsLink,
      agenda: i.agenda,
      panel: i.panel ?? [],
    },
  );
  await tellDesk(
    orgId,
    c.applicationId,
    (cand) =>
      `${who} cannot make ${cand}'s L${c.level} interview at ${localWhen(i.scheduledAt!, tz)} and suggested ${localWhen(at, tz)}${others.length ? "; the rest of the panel is free then" : ""}. The round moved there and the panel is asked to confirm; the candidate has not been told yet.`,
  );
  return true;
}

/** The `interview.panellist_unavailable` event, as "Can't make it" on My interviews raises it. */
export async function raiseUnavailable(
  orgId: string,
  applicationId: string,
  interviewId: string,
  level: number,
  who: { email: string; name: string | null },
  note: string | null,
): Promise<void> {
  try {
    const { orgMembers } = await import("@db/schema");
    const [a] = await db
      .select({ requisitionId: applications.requisitionId })
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    const [member] = await db
      .select({ id: orgMembers.id, name: orgMembers.fullName, userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), sql`lower(${orgMembers.email}) = ${who.email}`))
      .limit(1);
    const [i] = await db
      .select({ at: interviews.scheduledAt })
      .from(interviews)
      .where(and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)))
      .limit(1);
    const { getOrgEmailSettings } = await import("./email-outbox.server");
    const { localWhen } = await import("./local-time");
    const when = i?.at ? localWhen(i.at, (await getOrgEmailSettings(orgId)).timezone) : undefined;
    const { emitAgentEvent } = await import("../server/agents/events");
    await emitAgentEvent({
      orgId,
      type: "interview.panellist_unavailable",
      subjectType: "application",
      subjectId: applicationId,
      actorUserId: member?.userId ?? null,
      payload: {
        requisitionId: a?.requisitionId ?? null,
        level,
        interviewId,
        memberId: member?.id ?? null,
        name: member?.name || who.name || who.email,
        when,
        note,
      },
    });
  } catch {
    /* the desk message and the audit trail still carry it */
  }
}

export async function tellDesk(
  orgId: string,
  applicationId: string,
  body: (cand: string) => string,
) {
  try {
    const [a] = await db
      .select({ requisitionId: applications.requisitionId, name: candidates.fullName })
      .from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    if (!a) return;
    const desk = await import("../server/desk/desk.server");
    const conv = await desk.conversationForRequisition(orgId, a.requisitionId);
    if (conv) await desk.postMessage(conv, { role: "desk", body: body(a.name ?? "the candidate") });
  } catch {
    /* the thread is a courtesy; the audit trail has the record */
  }
}

/* ----------------------------------------------------- the hiring team's view */

export type RoundConfirmations = {
  panel: { name: string | null; email: string; state: ConfirmState }[];
  candidate: ConfirmState | null;
  /** The candidate's invite is waiting on the panel. */
  inviteHeld: boolean;
};

export async function confirmationsFor(
  orgId: string,
  interviewIds: string[],
): Promise<Record<string, RoundConfirmations>> {
  if (!interviewIds.length) return {};
  const rows = await db
    .select()
    .from(interviewConfirmations)
    .where(
      and(
        eq(interviewConfirmations.orgId, orgId),
        inArray(interviewConfirmations.interviewId, interviewIds),
        sql`${interviewConfirmations.state} <> 'superseded'`,
      ),
    );
  const { emailOutbox } = await import("@db/schema");
  const held = await db
    .select({ key: emailOutbox.idempotencyKey })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.orgId, orgId),
        eq(emailOutbox.status, "held"),
        eq(emailOutbox.kind, "interview_invite"),
      ),
    );
  const out: Record<string, RoundConfirmations> = {};
  for (const id of interviewIds) {
    const mine = rows.filter((r) => r.interviewId === id);
    if (!mine.length) continue;
    out[id] = {
      panel: mine
        .filter((r) => r.party === "panelist")
        .map((r) => ({ name: r.name, email: r.email, state: r.state })),
      candidate: mine.find((r) => r.party === "candidate")?.state ?? null,
      inviteHeld: held.some((h) => h.key.startsWith(invitePrefix(id))),
    };
  }
  return out;
}

/** The hiring team sends the held invite without waiting for the panel (audited). */
export async function releaseInviteNow(
  orgId: string,
  interviewId: string,
  by: { email: string; userId: string },
): Promise<number> {
  const { releaseHeldEmails } = await import("./email-outbox.server");
  const n = await releaseHeldEmails(orgId, invitePrefix(interviewId));
  if (n) {
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: by.email,
      actorUserId: by.userId,
      orgId,
      action: "interview.invite_released",
      entityType: "interview",
      entityId: interviewId,
      detail: { reason: "sent before the whole panel accepted" },
    });
  }
  return n;
}

/* ---------------------------------------------------- the panel's answer window */

/**
 * How long a panelist has to answer before the round goes ahead without them —
 * the hiring SLA (default 5 days from application to offer) leaves no room for
 * a day's silence.
 */
export const PANEL_ANSWER = { remindAfterHours: 1, windowHours: 2 } as const;

/**
 * Run by the agent tick. A pending panelist is reminded once at
 * `remindAfterHours`; when `windowHours` passes unanswered:
 * - their connected calendar shows them free → counted as yes (audited);
 * - offered times, calendar unknown or busy → `lapsed`: the candidate is offered
 *   the times the rest of the panel agreed, and the lapsed panelist is asked
 *   again for the booked time;
 * - a booked round, calendar unknown or busy → the Interview coordinator
 *   proposes a stand-in for the HR head (one click) and the desk is told;
 *   "Send invite now" stays on the Interviews page.
 */
export async function sweepPanelAnswers(orgId?: string, now = Date.now()): Promise<number> {
  const remindBefore = new Date(now - PANEL_ANSWER.remindAfterHours * 3600_000);
  const lapseBefore = new Date(now - PANEL_ANSWER.windowHours * 3600_000);
  const rows = await db
    .select()
    .from(interviewConfirmations)
    .where(
      and(
        orgId ? eq(interviewConfirmations.orgId, orgId) : sql`true`,
        eq(interviewConfirmations.party, "panelist"),
        eq(interviewConfirmations.state, "pending"),
        sql`${interviewConfirmations.lapsedAt} is null`,
        sql`${interviewConfirmations.createdAt} <= ${remindBefore.toISOString()}::timestamptz`,
      ),
    )
    .limit(200);
  let acted = 0;
  for (const r of rows) {
    try {
      const c = await contextOf(r);
      if (!c || c.closed) continue;
      if (r.createdAt <= lapseBefore) {
        await closeWindow(r, c);
        acted++;
      } else if (!r.remindedAt) {
        await remind(r, c, now);
        acted++;
      }
    } catch {
      /* one row never stops the sweep */
    }
  }
  return acted;
}

async function remind(r: Row, c: Ctx, now: number) {
  const [claimed] = await db
    .update(interviewConfirmations)
    .set({ remindedAt: new Date(now) })
    .where(
      and(eq(interviewConfirmations.id, r.id), sql`${interviewConfirmations.remindedAt} is null`),
    )
    .returning({ id: interviewConfirmations.id });
  if (!claimed) return;
  const { enqueueEmail, formatInOrgTZ, getOrgEmailSettings } =
    await import("./email-outbox.server");
  const { env } = await import("../server/env");
  const tz = (await getOrgEmailSettings(r.orgId)).timezone;
  const [ctx] = await db
    .select({ orgName: organizations.name, candidateName: candidates.fullName })
    .from(applications)
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, c.applicationId), eq(applications.orgId, r.orgId)))
    .limit(1);
  const left = PANEL_ANSWER.windowHours - PANEL_ANSWER.remindAfterHours;
  await enqueueEmail({
    orgId: r.orgId,
    kind: "panel_reminder",
    templateName: "panel_reminder",
    toEmail: r.email,
    applicationId: c.applicationId,
    idempotencyKey: `panel-reminder:${r.id}`,
    templateData: {
      interviewerName: r.name ?? undefined,
      orgName: ctx?.orgName,
      candidateName: ctx?.candidateName ?? undefined,
      roundLabel: `L${c.level} interview`,
      timesText: c.times.map((t) => formatInOrgTZ(new Date(t), tz)).join("\n"),
      leftText: `${left} hour${left === 1 ? "" : "s"}`,
      confirmUrl: `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/confirm/${r.token}`,
    },
  });
}

async function closeWindow(r: Row, c: Ctx) {
  // Which of the times their calendar shows them free for (when it can be read).
  const exceptId = r.interviewId ?? undefined;
  const freeTimes: string[] = [];
  let checked = true;
  for (const t of c.times) {
    const f = await allFree(r.orgId, [r.email], new Date(t), c.durationMins, exceptId);
    if (!f.checked) checked = false;
    if (f.checked && f.free) freeTimes.push(t);
  }
  const who = r.name ?? r.email;
  const hours = PANEL_ANSWER.windowHours;
  const { writeAudit } = await import("../server/audit");
  if (checked && freeTimes.length) {
    // Silence with a free calendar counts as yes.
    const [done] = await db
      .update(interviewConfirmations)
      .set({
        state: "accepted",
        okSlots: r.offerId ? freeTimes : null,
        note: `No answer within ${hours} hours; their calendar shows them free — counted as yes.`,
        respondedAt: new Date(),
        lapsedAt: new Date(),
      })
      .where(and(eq(interviewConfirmations.id, r.id), eq(interviewConfirmations.state, "pending")))
      .returning({ id: interviewConfirmations.id });
    if (!done) return;
    await writeAudit({
      actor: "system:panel-answer-window",
      orgId: r.orgId,
      action: "interview.time_accepted_by_calendar",
      entityType: r.interviewId ? "interview" : "interview_slot_offer",
      entityId: (r.interviewId ?? r.offerId)!,
      detail: { email: r.email, level: c.level, freeTimes },
    });
    if (r.offerId) await afterOfferAnswer(r.orgId, r.offerId, r, c);
    else await releaseIfAgreed(r.orgId, r.interviewId!);
    await tellDesk(
      r.orgId,
      c.applicationId,
      (cand) =>
        `${who} did not answer ${cand}'s L${c.level} interview time within ${hours} hours; their calendar shows them free, so it counts as yes and the candidate is contacted.`,
    );
    return;
  }
  if (r.offerId) {
    // The candidate is not kept waiting on one silent panelist.
    const [done] = await db
      .update(interviewConfirmations)
      .set({ state: "lapsed", lapsedAt: new Date() })
      .where(and(eq(interviewConfirmations.id, r.id), eq(interviewConfirmations.state, "pending")))
      .returning({ id: interviewConfirmations.id });
    if (!done) return;
    await writeAudit({
      actor: "system:panel-answer-window",
      orgId: r.orgId,
      action: "interview.time_lapsed",
      entityType: "interview_slot_offer",
      entityId: r.offerId,
      detail: { email: r.email, level: c.level },
    });
    await tellDesk(
      r.orgId,
      c.applicationId,
      (cand) =>
        `${who} did not answer the L${c.level} times proposed for ${cand} within ${hours} hours${checked ? " and their calendar is busy for them" : " and their calendar could not be checked"}. The candidate is offered the times the rest of the panel agreed; ${who} is asked again for the booked time.`,
    );
    await afterOfferAnswer(r.orgId, r.offerId, r, c);
    return;
  }
  // A booked round: a person decides, in one click.
  await db
    .update(interviewConfirmations)
    .set({ lapsedAt: new Date() })
    .where(eq(interviewConfirmations.id, r.id));
  await writeAudit({
    actor: "system:panel-answer-window",
    orgId: r.orgId,
    action: "interview.time_unanswered",
    entityType: "interview",
    entityId: r.interviewId!,
    detail: { email: r.email, level: c.level, calendarChecked: checked },
  });
  await raiseUnavailable(r.orgId, c.applicationId, r.interviewId!, c.level, r, null);
  await tellDesk(
    r.orgId,
    c.applicationId,
    (cand) =>
      `${who} has not answered ${cand}'s L${c.level} interview time within ${hours} hours${checked ? " and their calendar is busy then" : " and their calendar could not be checked"}. Approve the stand-in the Interview coordinator proposes, or press Send invite now on the Interviews page.`,
  );
}
