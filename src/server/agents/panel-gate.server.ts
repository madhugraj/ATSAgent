/**
 * The panel approval gate (docs/interview-panel-plan.md, P2): the Interview
 * coordinator proposes who interviews for a role's round (propose_panel); the
 * role's hiring manager — or, when the role has none who can sign in, the HR
 * head — approves it or changes the people. The system states the round and
 * why each person fits; nobody outside the eligible list can be proposed.
 */
import { and, eq, sql } from "drizzle-orm";

import {
  agentTasks,
  applications,
  candidates,
  interviews,
  orgMembers,
  requisitions,
  roundSubstitutes,
} from "@db/schema";
import { db } from "../db";

export type PanelApprovalSubject = {
  type: "panel_approval";
  requisitionId: string;
  level: number;
  memberIds: string[];
  reason: string;
  /** The approved panel's version when proposed (0: none) — a stale card is refused. */
  expects?: string;
};

type PanelGateInfo<S = PanelApprovalSubject> = {
  role: "hr_head" | null;
  assigneeUserId?: string;
  status: string;
  detail: string;
  subject: S;
};

/** The role's hiring manager decides when they can sign in; else the HR head. */
export async function deciderOf(
  orgId: string,
  hmMemberId: string | null,
): Promise<{ assigneeUserId: string | undefined; decider: string }> {
  if (hmMemberId) {
    const [hm] = await db
      .select({ userId: orgMembers.userId, name: orgMembers.fullName, email: orgMembers.email })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.id, hmMemberId),
          eq(orgMembers.orgId, orgId),
          eq(orgMembers.status, "active"),
        ),
      )
      .limit(1);
    if (hm?.userId)
      return {
        assigneeUserId: hm.userId,
        decider: `${hm.name || hm.email}, the role's hiring manager`,
      };
  }
  return {
    assigneeUserId: undefined,
    decider: "the HR head (this role has no hiring manager who can sign in)",
  };
}

/** Who decides, what the card says, or why the proposal is refused. */
export async function panelGateFor(
  orgId: string,
  subject: PanelApprovalSubject,
): Promise<PanelGateInfo | { error: string }> {
  const [req] = await db
    .select({
      code: requisitions.code,
      title: requisitions.title,
      hmMemberId: requisitions.hiringManagerMemberId,
    })
    .from(requisitions)
    .where(and(eq(requisitions.id, subject.requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req) return { error: "Requisition not found." };
  const { planFor } = await import("@/lib/interview-plan.server");
  const { roundOf } = await import("@/lib/interview-plan");
  const round = roundOf((await planFor(orgId, subject.requisitionId)).plan, subject.level);
  if (!round) return { error: `This role's interview plan has no round L${subject.level}.` };
  const ids = [...new Set(subject.memberIds)];
  if (ids.length > round.panelSize)
    return {
      error: `Round L${subject.level} has a panel of ${round.panelSize}; propose at most ${round.panelSize}.`,
    };
  const { eligibleInterviewers, approvedPanel } = await import("@/lib/panels.server");
  const { registered, people, full } = await eligibleInterviewers(
    orgId,
    subject.requisitionId,
    subject.level,
  );
  const outside = ids.filter((id) => !people.some((p) => p.memberId === id));
  if (outside.length)
    return {
      error: `Only eligible interviewers can be proposed for L${subject.level}: ${
        people.map((p) => `${p.name} (memberId ${p.memberId})`).join(", ") || "nobody is eligible"
      }.${full.length ? ` At their weekly limit: ${full.join(", ")}.` : ""}`,
    };
  const [waiting] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "gate"),
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'type' = 'panel_approval'`,
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'requisitionId' = ${subject.requisitionId}`,
        sql`(${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'level')::int = ${subject.level}`,
      ),
    )
    .limit(1);
  if (waiting)
    return { error: `A panel for L${subject.level} of this role is already waiting for a person.` };
  const current = await approvedPanel(orgId, subject.requisitionId, subject.level);

  const { assigneeUserId, decider } = await deciderOf(orgId, req.hmMemberId);
  const chosen = ids.map((id) => people.find((p) => p.memberId === id)!);
  const lines = chosen.map(
    (p) =>
      `- ${p.name}: ${p.covers.length ? `assesses ${p.covers.join(", ")}` : "no listed area matches this round"}${
        p.pastRounds ? `; ${p.pastRounds} earlier round(s) for this role` : ""
      }; ${p.load} interview(s) in the next 7 days${p.cap ? ` (limit ${p.cap} a week)` : ""}`,
  );
  const detail = [
    `Panel for L${round.level} · ${round.name} — ${req.code} ${req.title}.`,
    round.focus ? `Focus: ${round.focus}` : "",
    `Rated on: ${round.competencies.join(", ")}. Panel size in the plan: ${round.panelSize}.`,
    `Proposed:\n${lines.join("\n")}`,
    current ? `Replaces the approved panel: ${current.members.map((m) => m.name).join(", ")}.` : "",
    registered
      ? ""
      : "No interviewers are registered on the Team page yet, so every active member was eligible.",
    `Decided by ${decider}. Approve to use this panel for every candidate in this round until someone changes it; or change the people.`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    role: assigneeUserId ? null : "hr_head",
    ...(assigneeUserId ? { assigneeUserId } : {}),
    status: String(current?.version ?? 0),
    detail,
    subject: { ...subject, memberIds: ids, expects: String(current?.version ?? 0) },
  };
}

/** Apply the person's decision: approved (as proposed or changed) is stored and audited. */
export async function performPanelGate(
  orgId: string,
  userId: string,
  subject: PanelApprovalSubject,
  decision: { status: string; args?: unknown },
): Promise<void> {
  if (decision.status !== "approved") return; // declining stores nothing; the agent is told
  const { approvedPanel, savePanel } = await import("@/lib/panels.server");
  const current = await approvedPanel(orgId, subject.requisitionId, subject.level);
  if (subject.expects !== undefined && String(current?.version ?? 0) !== subject.expects)
    throw new Error("This round's panel changed since this was proposed; refresh to see it.");
  const changedTo = (decision.args as { memberIds?: unknown } | undefined)?.memberIds;
  const memberIds =
    Array.isArray(changedTo) && changedTo.every((x) => typeof x === "string")
      ? (changedTo as string[])
      : subject.memberIds;
  const changed =
    [...memberIds].sort().join(",") !== [...new Set(subject.memberIds)].sort().join(",");
  await savePanel(orgId, userId, subject.requisitionId, subject.level, memberIds, changed);
}

/** What the agent is told once the panel is approved: who is on it, as stored. */
export async function approvedPanelWords(
  orgId: string,
  subject: PanelApprovalSubject,
): Promise<string> {
  const { approvedPanel } = await import("@/lib/panels.server");
  const p = await approvedPanel(orgId, subject.requisitionId, subject.level);
  if (!p) return "Approved, but the panel has no active members now — propose it again.";
  return `Approved. The L${subject.level} panel is ${p.members
    .map((m) => `${m.name} (${m.email})`)
    .join(
      ", ",
    )} — use exactly these people: the first as interviewerEmail, the rest as panelEmails.`;
}

/* ------------------------------------------------ a stand-in for one round */

export type PanelSubstituteSubject = {
  type: "panel_substitute";
  applicationId: string;
  level: number;
  replaceMemberId: string;
  withMemberId: string;
  reason: string;
  /** The booked interview when proposed ("none": not booked) — a stale card is refused. */
  expects?: string;
};

/** Who decides a stand-in, what the card says, or why it is refused. */
export async function substituteGateFor(
  orgId: string,
  subject: PanelSubstituteSubject,
): Promise<PanelGateInfo<PanelSubstituteSubject> | { error: string }> {
  const [app] = await db
    .select({
      code: requisitions.code,
      title: requisitions.title,
      hmMemberId: requisitions.hiringManagerMemberId,
      candidate: candidates.fullName,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, subject.applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!app) return { error: "Application not found." };
  const { roundPanel, substituteOptions } = await import("@/lib/panels.server");
  let found: Awaited<ReturnType<typeof substituteOptions>>;
  try {
    found = await substituteOptions(
      orgId,
      subject.applicationId,
      subject.level,
      subject.replaceMemberId,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const pick = found.options.find((o) => o.memberId === subject.withMemberId);
  if (!pick)
    return {
      error: `Only eligible interviewers not already on the panel can stand in: ${
        found.options.map((o) => `${o.name} (memberId ${o.memberId})`).join(", ") ||
        "nobody is eligible"
      }.`,
    };
  const [waiting] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "gate"),
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'type' = 'panel_substitute'`,
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'applicationId' = ${subject.applicationId}`,
        sql`(${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'level')::int = ${subject.level}`,
      ),
    )
    .limit(1);
  if (waiting)
    return { error: "A stand-in for this candidate's round is already waiting for a person." };
  const panel = (await roundPanel(orgId, subject.applicationId, subject.level))!;
  const out = panel.members.find((m) => m.memberId === subject.replaceMemberId)!;
  const { bookedRound } = await import("@/lib/panels.server");
  const booked = await bookedRound(orgId, subject.applicationId, subject.level);
  let when = "Not booked yet: the stand-in is used when times are offered.";
  if (booked?.scheduledAt) {
    const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
    const { localWhen } = await import("@/lib/local-time");
    const at = localWhen(booked.scheduledAt, (await getOrgEmailSettings(orgId)).timezone);
    when = pick.freeAtBookedTime
      ? `Booked for ${at}: ${pick.name} is free then, so the time stays and the candidate sees no change.`
      : `Booked for ${at}: ${pick.name} is not free then, so that time is cancelled and the candidate is offered new times.`;
  }
  const { assigneeUserId, decider } = await deciderOf(orgId, app.hmMemberId);
  const detail = [
    `Stand-in for ${app.candidate}'s L${subject.level} interview — ${app.code} ${app.title}.`,
    `${pick.name} replaces ${out.name} for this candidate only; the role's panel is unchanged.`,
    `${pick.name}: ${pick.covers.length ? `assesses ${pick.covers.join(", ")}` : "no listed area matches this round"}; ${pick.load} interview(s) in the next 7 days${pick.cap ? ` (limit ${pick.cap} a week)` : ""}.`,
    when,
    `Decided by ${decider}.`,
  ].join("\n");
  return {
    role: assigneeUserId ? null : "hr_head",
    ...(assigneeUserId ? { assigneeUserId } : {}),
    status: booked?.id ?? "none",
    detail,
    subject: { ...subject, expects: booked?.id ?? "none" },
  };
}

/**
 * Apply an approved stand-in: recorded for the candidate's round (audited);
 * a booked interview keeps its time when the stand-in is free then (they get
 * the invite and brief), else it is cancelled and new times are offered.
 */
export async function performSubstituteGate(
  orgId: string,
  userId: string,
  memberEmail: string,
  subject: PanelSubstituteSubject,
  decision: { status: string },
): Promise<void> {
  if (decision.status !== "approved") return;
  const { bookedRound } = await import("@/lib/panels.server");
  const booked = await bookedRound(orgId, subject.applicationId, subject.level);
  if (subject.expects !== undefined && (booked?.id ?? "none") !== subject.expects)
    throw new Error("This candidate's round changed since this was proposed; refresh to see it.");
  const people = await db
    .select({
      id: orgMembers.id,
      name: sql<string>`coalesce(nullif(${orgMembers.fullName}, ''), ${orgMembers.email})`,
      email: orgMembers.email,
    })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, "active")));
  const out = people.find((p) => p.id === subject.replaceMemberId);
  const sub = people.find((p) => p.id === subject.withMemberId);
  if (!out || !sub) throw new Error("Both people must be active members of your organisation.");
  await db
    .insert(roundSubstitutes)
    .values({
      orgId,
      applicationId: subject.applicationId,
      level: subject.level,
      replaceMemberId: out.id,
      withMemberId: sub.id,
      reason: subject.reason,
      approvedBy: userId,
    })
    .onConflictDoUpdate({
      target: [
        roundSubstitutes.applicationId,
        roundSubstitutes.level,
        roundSubstitutes.replaceMemberId,
      ],
      set: {
        withMemberId: sub.id,
        reason: subject.reason,
        approvedBy: userId,
        approvedAt: new Date(),
      },
    });
  const { writeAudit } = await import("../audit");
  let outcome: "swapped" | "re-offer" | "not booked" = "not booked";
  if (booked?.scheduledAt) {
    const { isFree } = await import("@/lib/calendar-availability.server");
    const free = (
      await isFree(orgId, sub.email, booked.scheduledAt.toISOString(), booked.durationMins)
    ).free;
    if (free) {
      outcome = "swapped";
      const isLead = (booked.interviewerEmail ?? "").toLowerCase() === out.email.toLowerCase();
      const panel = (booked.panel ?? []).map((m) =>
        m.email.toLowerCase() === out.email.toLowerCase()
          ? { name: sub.name, email: sub.email }
          : m,
      );
      await db
        .update(interviews)
        .set(isLead ? { interviewer: sub.name, interviewerEmail: sub.email, panel } : { panel })
        .where(and(eq(interviews.id, booked.id), eq(interviews.orgId, orgId)));
      const [app] = await db
        .select({ candidateId: applications.candidateId })
        .from(applications)
        .where(and(eq(applications.id, subject.applicationId), eq(applications.orgId, orgId)))
        .limit(1);
      const names = [
        isLead ? sub.name : booked.interviewer,
        ...panel.map((m) => m.name ?? m.email),
      ];
      try {
        const { sendInterviewerBrief } = await import("@/lib/interviewer-brief.server");
        await sendInterviewerBrief(orgId, {
          interviewId: booked.id,
          applicationId: subject.applicationId,
          candidateId: app!.candidateId,
          level: subject.level,
          interviewerName: sub.name,
          interviewerEmail: sub.email,
          scheduledAt: booked.scheduledAt,
          durationMins: booked.durationMins,
          mode: booked.mode,
          meetingLink: booked.teamsLink,
          agenda: booked.agenda,
          panelNames: names,
        });
      } catch {
        /* the swap stands even if the brief cannot be queued */
      }
    } else {
      outcome = "re-offer";
      const { markInterviewOutcomeCore } = await import("@/lib/interviews.functions");
      await markInterviewOutcomeCore(
        { orgId, userId, email: memberEmail },
        {
          interviewId: booked.id,
          outcome: "interviewer_unavailable",
          note: `${out.name} could not make it; ${sub.name} stands in but is not free at that time`,
        },
      );
    }
  }
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId,
    action: "round_substitute.approved",
    entityType: "application",
    entityId: subject.applicationId,
    detail: { level: subject.level, replaced: out.email, with: sub.email, outcome },
  });
}
