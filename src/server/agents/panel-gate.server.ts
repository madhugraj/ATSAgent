/**
 * The panel approval gate (docs/interview-panel-plan.md, P2): the Interview
 * coordinator proposes who interviews for a role's round (propose_panel); the
 * role's hiring manager — or, when the role has none who can sign in, the HR
 * head — approves it or changes the people. The system states the round and
 * why each person fits; nobody outside the eligible list can be proposed.
 */
import { and, eq, sql } from "drizzle-orm";

import { agentTasks, orgMembers, requisitions } from "@db/schema";
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

type PanelGateInfo = {
  role: "hr_head" | null;
  assigneeUserId?: string;
  status: string;
  detail: string;
  subject: PanelApprovalSubject;
};

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

  // The role's hiring manager decides when they can sign in; else the HR head.
  let assigneeUserId: string | undefined;
  let decider = "the HR head (this role has no hiring manager who can sign in)";
  if (req.hmMemberId) {
    const [hm] = await db
      .select({ userId: orgMembers.userId, name: orgMembers.fullName, email: orgMembers.email })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.id, req.hmMemberId),
          eq(orgMembers.orgId, orgId),
          eq(orgMembers.status, "active"),
        ),
      )
      .limit(1);
    if (hm?.userId) {
      assigneeUserId = hm.userId;
      decider = `${hm.name || hm.email}, the role's hiring manager`;
    }
  }
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
