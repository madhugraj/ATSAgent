/**
 * The candidate's answer to a released offer, from the private link in the
 * offer email (/offer/<token>): accept, decline (with a reason) or ask for
 * changes (expected CTC, joining date, a note). Each is recorded on the offer
 * (trail entry "candidate") and the application stage, audited, told to the
 * role's hiring-desk thread, and raised as offer.status_changed so the agents
 * react — a request for changes reaches the Offer agent, which proposes a
 * revision inside the band that is approved again (docs/agentic-plan.md §13.4).
 *
 * The token is the only key: the page shows the offer's own facts (role,
 * organisation, CTC, joining date, letter) and nothing else.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../server/db";
import { applications, candidates, offers, organizations, requisitions } from "@db/schema";
import { writeAudit } from "../server/audit";

async function byToken(token: string) {
  const [o] = await db
    .select({
      offer: offers,
      orgName: organizations.name,
      jobTitle: requisitions.title,
      requisitionId: requisitions.id,
      candidateName: candidates.fullName,
      stage: applications.stage,
    })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(organizations, eq(organizations.id, offers.orgId))
    .where(eq(offers.responseToken, token))
    .limit(1);
  return o ?? null;
}

export type PublicOfferView = {
  orgName: string;
  jobTitle: string;
  candidateFirstName: string;
  offeredCtc: number;
  joiningDate: string | null;
  revision: number;
  status: "released" | "accepted" | "declined" | "countered" | "closed";
  letter: {
    subject: string;
    opening: string;
    sections: { heading: string; body: string }[];
  } | null;
};

export async function publicOfferView(token: string): Promise<PublicOfferView | null> {
  const o = await byToken(token);
  if (!o) return null;
  const letter = o.offer.letter as {
    subject?: string;
    opening?: string;
    sections?: { heading?: string; body?: string }[];
  } | null;
  const st = o.offer.status;
  return {
    orgName: o.orgName,
    jobTitle: o.jobTitle,
    candidateFirstName: o.candidateName.split(/\s+/)[0] ?? o.candidateName,
    offeredCtc: Number(o.offer.offeredCtc),
    joiningDate: o.offer.joiningDate ? String(o.offer.joiningDate) : null,
    revision: o.offer.revision,
    status:
      st === "released" || st === "accepted" || st === "declined" || st === "countered"
        ? st
        : "closed",
    letter: letter
      ? {
          subject: letter.subject ?? "",
          opening: letter.opening ?? "",
          sections: (letter.sections ?? []).map((s) => ({
            heading: s.heading ?? "",
            body: s.body ?? "",
          })),
        }
      : null,
  };
}

export type OfferAnswer =
  | { action: "accept" }
  | { action: "decline"; reason: string }
  | {
      action: "ask_changes";
      expectedCtc: number | null;
      joiningDate: string | null;
      note: string;
    };

const STAGE_FOR: Record<OfferAnswer["action"], string | null> = {
  accept: "offer_accepted",
  decline: "offer_declined",
  ask_changes: null,
};
const STATUS_FOR: Record<OfferAnswer["action"], "accepted" | "declined" | "countered"> = {
  accept: "accepted",
  decline: "declined",
  ask_changes: "countered",
};

/** Record the candidate's answer. Only a released offer can be answered, once. */
export async function respondToOffer(
  token: string,
  answer: OfferAnswer,
): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  const o = await byToken(token);
  if (!o) return { ok: false, reason: "This link is not valid." };
  if (o.offer.status !== "released")
    return { ok: false, reason: "This offer has already been answered or is no longer open." };
  const to = STATUS_FOR[answer.action];
  const now = new Date();
  const counter =
    answer.action === "ask_changes"
      ? {
          expectedCtc: answer.expectedCtc,
          joiningDate: answer.joiningDate,
          note: answer.note.replace(/\s+/g, " ").trim().slice(0, 1000) || null,
          at: now.toISOString(),
        }
      : null;
  const reason =
    answer.action === "decline" ? answer.reason.replace(/\s+/g, " ").trim().slice(0, 500) : null;
  const trail = [
    ...(Array.isArray(o.offer.approvalTrail) ? (o.offer.approvalTrail as unknown[]) : []),
    {
      from: "released",
      to,
      actor: "candidate",
      decision: to,
      ...(reason ? { comment: reason } : {}),
      ...(counter ? { counter } : {}),
      at: now.toISOString(),
    },
  ];
  // Claim the answer in the update itself, so two clicks cannot both record.
  const done = await db
    .update(offers)
    .set({
      status: to,
      approvalTrail: trail as never,
      respondedAt: now,
      ...(counter ? { counter } : {}),
    })
    .where(and(eq(offers.id, o.offer.id), eq(offers.status, "released")))
    .returning({ id: offers.id });
  if (!done.length) return { ok: false, reason: "This offer has already been answered." };

  const stage = STAGE_FOR[answer.action];
  if (stage) {
    await db
      .update(applications)
      .set({ stage: stage as never, stageReason: reason, lastActivityAt: now })
      .where(eq(applications.id, o.offer.applicationId));
    const { recordStageTransition } = await import("./stage-events.server");
    await recordStageTransition({
      orgId: o.offer.orgId!,
      applicationId: o.offer.applicationId,
      fromStage: o.stage as never,
      toStage: stage as never,
      actor: "candidate",
      reason: reason ?? (answer.action === "accept" ? "Accepted the offer" : null),
    });
  }
  await writeAudit({
    actor: "candidate",
    orgId: o.offer.orgId,
    action: `offer.${to}`,
    entityType: "offer",
    entityId: o.offer.id,
    detail: {
      revision: o.offer.revision,
      ...(counter ? { counter } : {}),
      ...(reason ? { reason } : {}),
    },
  });
  const { emitAgentEvent } = await import("../server/agents/events");
  await emitAgentEvent({
    orgId: o.offer.orgId!,
    type: "offer.status_changed",
    subjectType: "offer",
    subjectId: o.offer.id,
    actorUserId: null,
    payload: { from: "released", to, applicationId: o.offer.applicationId, via: "candidate" },
  });
  const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const told =
    answer.action === "accept"
      ? `${o.candidateName} accepted the offer (${money(Number(o.offer.offeredCtc))}${o.offer.joiningDate ? `, joining ${o.offer.joiningDate}` : ""}).`
      : answer.action === "decline"
        ? `${o.candidateName} declined the offer${reason ? `: "${reason}"` : "."}`
        : `${o.candidateName} asked for changes to the offer (now ${money(Number(o.offer.offeredCtc))})${
            counter?.expectedCtc ? `: expects ${money(counter.expectedCtc)}` : ""
          }${counter?.joiningDate ? `, joining ${counter.joiningDate}` : ""}${
            counter?.note ? ` — "${counter.note}"` : ""
          }. The Offer agent proposes a revision inside the band, which is approved again.`;
  try {
    const desk = await import("../server/desk/desk.server");
    const conv = await desk.conversationForRequisition(o.offer.orgId!, o.requisitionId);
    if (conv) await desk.postMessage(conv, { role: "desk", body: told });
  } catch {
    /* the thread is a courtesy; the trail and audit have the record */
  }
  return { ok: true, status: to };
}
