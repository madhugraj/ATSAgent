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
export type ConfirmState = "pending" | "accepted" | "declined" | "superseded";

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
  return live.every((r) => r.state === "accepted");
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
): Promise<{ token: string; state: ConfirmState }> {
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
      ),
    )
    .limit(1);
  if (have) return have;
  const agreed = await agreedOnOffer(orgId, interviewId, email, scheduledAt);
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
  return { token, state };
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

async function rowByToken(token: string) {
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

/** A panelist's or candidate's answer. `note` is their own words (untrusted, stored as text). */
export async function answerConfirmation(
  token: string,
  accept: boolean,
  note: string | null,
): Promise<AnswerResult> {
  const r = await rowByToken(token);
  if (!r) return { ok: false, error: "This link is not valid." };
  const c = await contextOf(r);
  if (!c || c.closed || r.state === "superseded")
    return { ok: false, error: "This time no longer stands; the team will be in touch." };
  if (r.state !== "pending")
    return { ok: false, error: `You already ${r.state === "accepted" ? "accepted" : "declined"}.` };
  const state: ConfirmState = accept ? "accepted" : "declined";
  const clean = note?.trim().slice(0, 500) || null;
  const [updated] = await db
    .update(interviewConfirmations)
    .set({ state, note: clean, respondedAt: new Date() })
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
    detail: { party: r.party, level: c.level, note: clean },
  });

  if (r.offerId) await afterOfferAnswer(r.orgId, r.offerId, r, accept, clean, c);
  else if (r.interviewId) await afterRoundAnswer(r.orgId, r.interviewId, r, accept, clean, c);
  return { ok: true, state };
}

type Ctx = NonNullable<Awaited<ReturnType<typeof contextOf>>>;
type Row = typeof interviewConfirmations.$inferSelect;

async function afterOfferAnswer(
  orgId: string,
  offerId: string,
  r: Row,
  accept: boolean,
  note: string | null,
  c: Ctx,
) {
  if (accept) {
    if (!panelAgreed(await liveRows(orgId, { offerId }))) return;
    // The candidate's clock starts now: the link's life and the wait before any
    // follow-up are counted from when they are first contacted.
    const { SLOT_OFFER, contactCandidate } = await import("./slot-offers.server");
    const now = Date.now();
    const first = Math.min(...c.times.map((t) => Date.parse(t)));
    const [claimed] = await db
      .update(interviewSlotOffers)
      .set({
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
  // One panelist cannot do these times: the offer never reaches the candidate.
  await db
    .update(interviewSlotOffers)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(interviewSlotOffers.id, offerId), eq(interviewSlotOffers.orgId, orgId)));
  const { withdrawOfferEmails } = await import("./slot-offers.server");
  await withdrawOfferEmails(orgId, [offerId]);
  await tellDesk(
    orgId,
    c.applicationId,
    (cand) =>
      `${r.name ?? r.email} cannot do the L${c.level} times proposed for ${cand}${note ? ` ("${note}")` : ""}. The times were not sent to the candidate; offer new ones.`,
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
        `${r.name ?? r.email} cannot make ${cand}'s L${c.level} interview at the booked time${note ? ` ("${note}")` : ""}. The candidate has not been sent the invite; the Interview coordinator proposes a stand-in for you to approve, or re-schedule the round.`,
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

async function tellDesk(orgId: string, applicationId: string, body: (cand: string) => string) {
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
