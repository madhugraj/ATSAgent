/**
 * Candidate self-scheduling (docs/agentic-plan.md §13.4). An offer is a few
 * interview times for one round with one interviewer; the candidate opens a
 * private link (/schedule/<token>) and picks one. Only then is the round
 * booked — meeting link, the candidate's invite and the interviewer's brief —
 * through the same scheduling core as the Interviews page. "None of these
 * work" is recorded with the candidate's words; unanswered offers expire.
 *
 * The token is the only key on the public side: it reveals the round, the
 * role, the organisation, the interviewer's name and the times — nothing else
 * about the candidate or the organisation.
 */
import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  applications,
  candidates,
  interviewSlotOffers,
  orgMembers,
  organizations,
  requisitions,
} from "@db/schema";
import { env } from "../server/env";
import { writeAudit } from "../server/audit";

export const SLOT_OFFER = {
  minSlots: 2,
  maxSlots: 5,
  /** A slot must start at least this far ahead when offered (hours). */
  leadHours: 12,
  /** …and when picked (hours). */
  pickLeadHours: 2,
  /** How long the link works at most (hours) — never past the first slot. */
  expiresHours: 72,
} as const;

export type OfferInput = {
  applicationId: string;
  level: number;
  interviewerEmail: string;
  slots: string[];
  durationMins: number;
  mode: "online" | "onsite" | "phone";
  meetingProvider?: "zoom" | "google_meet" | "teams" | undefined;
  agenda?: string | undefined;
  /** Further interviewers on the panel (active members). */
  panelEmails?: string[] | undefined;
};

const site = () => env.PUBLIC_SITE_URL.replace(/\/$/, "");

/** Offer interview times to the candidate and email them the private link. */
export async function offerSlotsCore(
  orgId: string,
  by: { userId: string | null; runId: string | null },
  input: OfferInput,
): Promise<{ offerId: string; slots: string[]; expiresAt: string; checkedWith: string | null }> {
  const slots = [
    ...new Set(
      input.slots
        .map((x) => new Date(x))
        .filter((d) => !Number.isNaN(d.getTime()))
        .map((d) => d.toISOString()),
    ),
  ]
    .map((x) => new Date(x))
    .sort((a, b) => a.getTime() - b.getTime());
  if (slots.length < SLOT_OFFER.minSlots || slots.length > SLOT_OFFER.maxSlots)
    throw new Error(`Offer ${SLOT_OFFER.minSlots}–${SLOT_OFFER.maxSlots} distinct valid times.`);
  const now = Date.now();
  if (slots.some((d) => d.getTime() < now + SLOT_OFFER.leadHours * 3600_000))
    throw new Error(`Every time must be at least ${SLOT_OFFER.leadHours} hours ahead.`);
  if (slots.some((d) => d.getTime() > now + 60 * 864e5))
    throw new Error("Offer times within the next 60 days.");
  const [member] = await db
    .select({ name: orgMembers.fullName, email: orgMembers.email })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, "active"),
        sql`lower(${orgMembers.email}) = ${input.interviewerEmail.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (!member) throw new Error("Interviewers must be active members of the organisation.");
  const panel: { name: string | null; email: string }[] = [];
  for (const e of [...new Set((input.panelEmails ?? []).map((x) => x.trim().toLowerCase()))]) {
    if (e === member.email.toLowerCase()) continue;
    const [m] = await db
      .select({ name: orgMembers.fullName, email: orgMembers.email })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, orgId),
          eq(orgMembers.status, "active"),
          sql`lower(${orgMembers.email}) = ${e}`,
        ),
      )
      .limit(1);
    if (!m) throw new Error(`Panel members must be active members of the organisation: ${e}.`);
    panel.push({ name: m.name ?? null, email: m.email.toLowerCase() });
  }
  if (panel.length > 2) throw new Error("A panel has at most three interviewers.");
  const [app] = await db
    .select({
      id: applications.id,
      candidateName: candidates.fullName,
      candidateEmail: candidates.email,
      jobTitle: requisitions.title,
      orgName: organizations.name,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .where(and(eq(applications.id, input.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!app) throw new Error("Application not found.");
  if (!app.candidateEmail) throw new Error("The candidate has no email address.");

  // Every offered time must still be free for the interviewer.
  const { isFree, busyFor } = await import("./calendar-availability.server");
  const taken: string[] = [];
  for (const d of slots) {
    for (const who of [member.email, ...panel.map((p) => p.email)]) {
      const f = await isFree(orgId, who, d.toISOString(), input.durationMins);
      if (!f.free) {
        taken.push(`${d.toISOString()} (${who}: ${f.reason})`);
        break;
      }
    }
  }
  if (taken.length)
    throw new Error(`These times are not free: ${taken.join("; ")}. Use find_interview_slots.`);
  const probe = await busyFor(orgId, [member.email], slots[0]!, slots[0]!);

  // A newer offer replaces an open one for the same round.
  await db
    .update(interviewSlotOffers)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(interviewSlotOffers.orgId, orgId),
        eq(interviewSlotOffers.applicationId, app.id),
        eq(interviewSlotOffers.level, input.level),
        eq(interviewSlotOffers.status, "offered"),
      ),
    );
  const expiresAt = new Date(
    Math.min(
      now + SLOT_OFFER.expiresHours * 3600_000,
      slots[0]!.getTime() - SLOT_OFFER.pickLeadHours * 3600_000,
    ),
  );
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const [offer] = await db
    .insert(interviewSlotOffers)
    .values({
      orgId,
      applicationId: app.id,
      level: input.level,
      interviewerName: member.name ?? null,
      interviewerEmail: member.email.toLowerCase(),
      durationMins: input.durationMins,
      mode: input.mode,
      meetingProvider: input.meetingProvider ?? null,
      agenda: input.agenda?.trim() || null,
      panel,
      slots: slots.map((d) => d.toISOString()),
      token,
      expiresAt,
      createdBy: by.userId,
      agentRunId: by.runId,
    })
    .returning({ id: interviewSlotOffers.id });

  const { enqueueEmail, formatInOrgTZ, getOrgEmailSettings } =
    await import("./email-outbox.server");
  const tz = (await getOrgEmailSettings(orgId)).timezone;
  await enqueueEmail({
    orgId,
    kind: "interview_slots",
    templateName: "interview_slots",
    toEmail: app.candidateEmail,
    applicationId: app.id,
    idempotencyKey: `interview-slots:${offer!.id}`,
    templateData: {
      candidateName: app.candidateName,
      orgName: app.orgName,
      jobTitle: app.jobTitle,
      roundLabel: `L${input.level} interview`,
      durationMins: String(input.durationMins),
      modeLabel: input.mode === "online" ? "Online" : input.mode === "onsite" ? "Onsite" : "Phone",
      slotsText: slots.map((d) => formatInOrgTZ(d, tz)).join("\n"),
      chooseUrl: `${site()}/schedule/${token}`,
      expiresText: formatInOrgTZ(expiresAt, tz),
    },
  });
  await writeAudit({
    actor: by.runId ? `agent:interview:${by.runId}` : `user:${by.userId ?? "?"}`,
    actorUserId: by.userId,
    orgId,
    action: "interview.slots_offered",
    entityType: "application",
    entityId: app.id,
    detail: { offerId: offer!.id, level: input.level, slots: slots.length },
  });
  return {
    offerId: offer!.id,
    slots: slots.map((d) => d.toISOString()),
    expiresAt: expiresAt.toISOString(),
    checkedWith: probe.source,
  };
}

async function byToken(token: string) {
  const [o] = await db
    .select({
      offer: interviewSlotOffers,
      orgName: organizations.name,
      jobTitle: requisitions.title,
      requisitionId: requisitions.id,
      candidateName: candidates.fullName,
    })
    .from(interviewSlotOffers)
    .innerJoin(applications, eq(applications.id, interviewSlotOffers.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(organizations, eq(organizations.id, interviewSlotOffers.orgId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(eq(interviewSlotOffers.token, token))
    .limit(1);
  return o ?? null;
}

export type PublicOffer = {
  orgName: string;
  jobTitle: string;
  roundLabel: string;
  durationMins: number;
  mode: string;
  interviewerName: string | null;
  timeZone: string;
  status: "offered" | "booked" | "declined" | "expired" | "cancelled";
  slots: string[];
  bookedAt: string | null;
};

export async function publicOffer(token: string): Promise<PublicOffer | null> {
  const o = await byToken(token);
  if (!o) return null;
  const { getOrgEmailSettings } = await import("./email-outbox.server");
  const expired = o.offer.status === "offered" && o.offer.expiresAt.getTime() < Date.now();
  const pickable = o.offer.slots.filter(
    (s) => Date.parse(s) > Date.now() + SLOT_OFFER.pickLeadHours * 3600_000,
  );
  return {
    orgName: o.orgName,
    jobTitle: o.jobTitle,
    roundLabel: `L${o.offer.level} interview`,
    durationMins: o.offer.durationMins,
    mode: o.offer.mode,
    // First name only on the public page.
    interviewerName: o.offer.interviewerName?.split(/\s+/)[0] ?? null,
    timeZone: (await getOrgEmailSettings(o.offer.orgId)).timezone,
    status: expired ? "expired" : (o.offer.status as PublicOffer["status"]),
    slots: o.offer.status === "offered" && !expired ? pickable : [],
    bookedAt: o.offer.status === "booked" ? (o.offer.chosenAt?.toISOString() ?? null) : null,
  };
}

/** The candidate picked a time: book it (or say plainly why it cannot be booked). */
export async function chooseSlot(
  token: string,
  slot: string,
): Promise<{ booked: true; at: string } | { booked: false; reason: string }> {
  const o = await byToken(token);
  if (!o) return { booked: false, reason: "This link is not valid." };
  const offer = o.offer;
  if (offer.status !== "offered" || offer.expiresAt.getTime() < Date.now())
    return {
      booked: false,
      reason: "This link is no longer open. The hiring team will be in touch.",
    };
  const at = new Date(slot);
  if (!offer.slots.includes(at.toISOString()))
    return { booked: false, reason: "Please choose one of the times offered." };
  if (at.getTime() < Date.now() + SLOT_OFFER.pickLeadHours * 3600_000)
    return { booked: false, reason: "That time is too soon now — please choose a later one." };
  const { isFree } = await import("./calendar-availability.server");
  let free: { free: boolean; reason: string | null } = { free: true, reason: null };
  for (const who of [offer.interviewerEmail, ...(offer.panel ?? []).map((p) => p.email)]) {
    free = await isFree(offer.orgId, who, at.toISOString(), offer.durationMins);
    if (!free.free) break;
  }
  if (!free.free)
    return {
      booked: false,
      reason: "That time has just been taken — please choose another one.",
    };
  // Claim the offer first, so a double click or a second tab cannot book twice.
  const claimed = await db
    .update(interviewSlotOffers)
    .set({ status: "booked", chosenAt: at, updatedAt: new Date() })
    .where(and(eq(interviewSlotOffers.id, offer.id), eq(interviewSlotOffers.status, "offered")))
    .returning({ id: interviewSlotOffers.id });
  if (!claimed.length) return { booked: false, reason: "This time has already been booked." };

  try {
    let meetingLink: string | null = null;
    if (offer.mode === "online" && offer.meetingProvider) {
      try {
        const { createMeetingLinkCore } = await import("./meetings.functions");
        meetingLink = (
          await createMeetingLinkCore(offer.orgId, {
            provider: offer.meetingProvider as "zoom" | "google_meet" | "teams",
            topic: `L${offer.level} interview: ${o.jobTitle}`,
            startIso: at.toISOString(),
            durationMins: offer.durationMins,
            attendees: [offer.interviewerEmail, ...(offer.panel ?? []).map((p) => p.email)],
            agenda: offer.agenda,
          })
        ).joinUrl;
      } catch {
        meetingLink = null; // the round is booked; the team adds a link if it failed
      }
    }
    const { scheduleInterviewCore } = await import("./interviews.functions");
    const r = await scheduleInterviewCore(
      { orgId: offer.orgId, actor: "candidate (chose the time)" },
      {
        applicationId: offer.applicationId,
        level: offer.level,
        interviewer: offer.interviewerName,
        interviewerEmail: offer.interviewerEmail,
        scheduledAt: at.toISOString(),
        durationMins: offer.durationMins,
        mode: offer.mode as "online" | "onsite" | "phone",
        meetingLink,
        agenda: offer.agenda,
        panel: offer.panel ?? [],
      },
    );
    await db
      .update(interviewSlotOffers)
      .set({ interviewId: r.interviewId ?? null, updatedAt: new Date() })
      .where(eq(interviewSlotOffers.id, offer.id));
    await writeAudit({
      actor: "candidate",
      orgId: offer.orgId,
      action: "interview.slot_chosen",
      entityType: "application",
      entityId: offer.applicationId,
      detail: { offerId: offer.id, at: at.toISOString(), interviewId: r.interviewId },
    });
    await tellThread(
      offer.orgId,
      o.requisitionId,
      `${o.candidateName} chose ${await whenText(offer.orgId, at)} for their L${offer.level} interview with ${offer.interviewerName ?? offer.interviewerEmail}. It is booked${meetingLink ? " with a meeting link" : ""}, and both of them have their invites.`,
    );
    return { booked: true, at: at.toISOString() };
  } catch (e) {
    // Booking failed after the claim: reopen the offer so the candidate can retry.
    await db
      .update(interviewSlotOffers)
      .set({ status: "offered", chosenAt: null, updatedAt: new Date() })
      .where(eq(interviewSlotOffers.id, offer.id));
    throw e;
  }
}

/** None of the times work: record the candidate's words and tell the team. */
export async function declineSlots(token: string, note: string): Promise<boolean> {
  const o = await byToken(token);
  if (!o || o.offer.status !== "offered") return false;
  const clean = note.replace(/\s+/g, " ").trim().slice(0, 500);
  const done = await db
    .update(interviewSlotOffers)
    .set({ status: "declined", candidateNote: clean || null, updatedAt: new Date() })
    .where(and(eq(interviewSlotOffers.id, o.offer.id), eq(interviewSlotOffers.status, "offered")))
    .returning({ id: interviewSlotOffers.id });
  if (!done.length) return false;
  await writeAudit({
    actor: "candidate",
    orgId: o.offer.orgId,
    action: "interview.slots_declined",
    entityType: "application",
    entityId: o.offer.applicationId,
    detail: { offerId: o.offer.id },
  });
  await tellThread(
    o.offer.orgId,
    o.requisitionId,
    `${o.candidateName} said none of the offered times for their L${o.offer.level} interview work${clean ? `: "${clean}"` : "."} Offer other times, or book a time with them directly on the Interviews page.`,
  );
  return true;
}

/** Offers past their expiry close, and the team hears about it (scheduler). */
export async function expireOffers(orgId?: string): Promise<number> {
  const rows = await db
    .update(interviewSlotOffers)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        orgId ? eq(interviewSlotOffers.orgId, orgId) : undefined,
        eq(interviewSlotOffers.status, "offered"),
        lt(interviewSlotOffers.expiresAt, new Date()),
      ),
    )
    .returning({
      orgId: interviewSlotOffers.orgId,
      applicationId: interviewSlotOffers.applicationId,
      level: interviewSlotOffers.level,
    });
  for (const r of rows) {
    const [a] = await db
      .select({ requisitionId: applications.requisitionId, name: candidates.fullName })
      .from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .where(eq(applications.id, r.applicationId))
      .limit(1);
    if (a)
      await tellThread(
        r.orgId,
        a.requisitionId,
        `${a.name} did not choose a time for their L${r.level} interview before the link expired. Offer new times, or call them and book it on the Interviews page.`,
      );
  }
  return rows.length;
}

async function whenText(orgId: string, at: Date) {
  const { formatInOrgTZ, getOrgEmailSettings } = await import("./email-outbox.server");
  return formatInOrgTZ(at, (await getOrgEmailSettings(orgId)).timezone);
}

async function tellThread(orgId: string, requisitionId: string, body: string) {
  try {
    const desk = await import("../server/desk/desk.server");
    const conv = await desk.conversationForRequisition(orgId, requisitionId);
    if (conv) await desk.postMessage(conv, { role: "desk", body });
  } catch {
    /* the thread is a courtesy; the audit trail has the record */
  }
}
