/**
 * The expert brief gate (Role expert interview agent): the agent writes the
 * brief from the hiring manager's own answers and proposes it
 * (propose_expert_brief); the role's hiring manager — the expert it came from
 * — approves it, or the HR head when the role has no hiring manager who can
 * sign in. The system states the brief and what it changes in the interview
 * plan; approving stores it on the role and applies each round's focus and
 * rubric.
 */
import { and, eq, sql } from "drizzle-orm";

import { agentTasks, requisitions } from "@db/schema";
import { ExpertBriefContent } from "@/lib/expert-brief";
import { writeAudit } from "../audit";
import { db } from "../db";
import { deciderOf } from "./panel-gate.server";

export type ExpertBriefSubject = {
  type: "expert_brief";
  requisitionId: string;
  brief: ExpertBriefContent;
  /** When the role's current brief was approved ("none") — a stale card is refused. */
  expects?: string;
};

/** The brief as the approver reads it, stated by the system (pure; unit-tested). */
export function expertBriefDetail(
  role: { code: string; title: string },
  brief: ExpertBriefContent,
  plan: { level: number; name: string; competencies: string[] }[],
): string {
  const rounds = brief.rounds
    .map((r) => {
      const now = plan.find((p) => p.level === r.level);
      if (!now) return `- L${r.level}: not in this role's plan — left out.`;
      return `- L${r.level} · ${now.name}: rates ${r.competencies.join(", ")}${
        r.focus ? ` — ${r.focus}` : ""
      } (now: ${now.competencies.join(", ")})`;
    })
    .join("\n");
  return [
    `Role expert brief — ${role.code} ${role.title}.`,
    `Must-haves:\n${brief.mustHaves.map((m) => `- ${m.skill}: ${m.why}`).join("\n")}`,
    brief.niceToHaves.length ? `Nice to have: ${brief.niceToHaves.join(", ")}` : "",
    brief.dealBreakers.length
      ? `Deal-breakers:\n${brief.dealBreakers.map((d) => `- ${d}`).join("\n")}`
      : "",
    `First months: ${brief.firstMonthsWork}`,
    `Success after six months: ${brief.successAfterSixMonths}`,
    `Screening must ask:\n${brief.screeningQuestions
      .map((q) => `- ${q.question}\n  Strong: ${q.strongAnswer}\n  Weak: ${q.weakAnswer}`)
      .join("\n")}`,
    rounds ? `Interview plan changes on approval:\n${rounds}` : "",
    brief.roundCount && brief.roundCount < plan.length
      ? `Rounds: ${brief.roundCount} (the plan has ${plan.length} — the later rounds are removed on approval).`
      : "",
    brief.panel.length
      ? `Panels named:\n${brief.panel.map((p) => `- L${p.level}: ${p.people.join(", ")}`).join("\n")}\nPeople in the panel directory are set as the round's panel on approval; anyone else is flagged for HR to add.`
      : "",
    "Approve if this is what the role needs: screening kits ask these questions and the interview rounds rate these areas. Send back with what to change, or decline.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function expertBriefGateFor(
  orgId: string,
  subject: ExpertBriefSubject,
): Promise<
  | {
      role: "hr_head" | null;
      assigneeUserId?: string;
      status: string;
      detail: string;
      subject: ExpertBriefSubject;
    }
  | { error: string }
> {
  const parsed = ExpertBriefContent.safeParse(subject.brief);
  if (!parsed.success)
    return {
      error: `The brief is incomplete: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}.`,
    };
  const [req] = await db
    .select({
      code: requisitions.code,
      title: requisitions.title,
      status: requisitions.status,
      hmMemberId: requisitions.hiringManagerMemberId,
      brief: requisitions.expertBrief,
    })
    .from(requisitions)
    .where(and(eq(requisitions.id, subject.requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req) return { error: "Requisition not found." };
  if (req.status === "closed" || req.status === "rejected")
    return { error: `${req.code} is ${req.status}; it needs no expert brief.` };
  const [waiting] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "gate"),
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'type' = 'expert_brief'`,
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'requisitionId' = ${subject.requisitionId}`,
      ),
    )
    .limit(1);
  if (waiting) return { error: "An expert brief for this role is already waiting for a person." };
  const { planFor } = await import("@/lib/interview-plan.server");
  const { plan } = await planFor(orgId, subject.requisitionId);
  const { assigneeUserId } = await deciderOf(orgId, req.hmMemberId);
  const expects = req.brief?.approvedAt ?? "none";
  return {
    role: assigneeUserId ? null : "hr_head",
    ...(assigneeUserId ? { assigneeUserId } : {}),
    status: expects,
    detail: expertBriefDetail(req, parsed.data, plan.rounds),
    subject: { ...subject, brief: parsed.data, expects },
  };
}

/** Approved: store the brief on the role and apply each round's focus and rubric; audited. */
export async function performExpertBriefGate(
  orgId: string,
  userId: string,
  subject: ExpertBriefSubject,
  decision: { status: string },
): Promise<void> {
  if (decision.status !== "approved") return; // the agent is told and revises
  const brief = ExpertBriefContent.parse(subject.brief);
  const [req] = await db
    .select({ brief: requisitions.expertBrief, hmMemberId: requisitions.hiringManagerMemberId })
    .from(requisitions)
    .where(and(eq(requisitions.id, subject.requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req) throw new Error("Requisition not found.");
  if (subject.expects !== undefined && (req.brief?.approvedAt ?? "none") !== subject.expects)
    throw new Error("This role's expert brief changed since this was proposed; refresh to see it.");
  const { planFor, savePlan } = await import("@/lib/interview-plan.server");
  const { plan } = await planFor(orgId, subject.requisitionId);
  let rounds = plan.rounds.map((r) => {
    const b = brief.rounds.find((x) => x.level === r.level);
    return b ? { ...r, focus: b.focus || r.focus, competencies: b.competencies } : r;
  });
  // The number of rounds the expert asked for (a round already in use is kept).
  let roundsKept: string | null = null;
  if (brief.roundCount && brief.roundCount < rounds.length) {
    const { roundsInUse } = await import("@/lib/interview-plan.server");
    const inUse = await roundsInUse(orgId, subject.requisitionId);
    const keep = Math.max(brief.roundCount, inUse);
    if (keep > brief.roundCount) roundsKept = `L${keep} is already in use, so ${keep} rounds stay.`;
    rounds = rounds.slice(0, keep);
  }
  if (brief.rounds.length || rounds.length !== plan.rounds.length)
    await savePlan(orgId, subject.requisitionId, { ...plan, rounds });
  await db
    .update(requisitions)
    .set({
      expertBrief: {
        ...brief,
        approvedBy: userId,
        approvedAt: new Date().toISOString(),
        expertMemberId: req.hmMemberId ?? null,
      },
    })
    .where(and(eq(requisitions.id, subject.requisitionId), eq(requisitions.orgId, orgId)));
  // Panels the expert named: people in the directory become the round's panel (the
  // hiring manager approving the brief is the panel's decider); others are flagged.
  const panels = await applyNamedPanels(orgId, userId, subject.requisitionId, brief, rounds.length);
  const { activeOrgOf } = await import("@/lib/auth.middleware");
  const org = await activeOrgOf(userId);
  await writeAudit({
    actor: org?.memberEmail ?? userId,
    actorUserId: userId,
    orgId,
    action: "requisition.expert_brief_approved",
    entityType: "requisition",
    entityId: subject.requisitionId,
    detail: {
      mustHaves: brief.mustHaves.length,
      screeningQuestions: brief.screeningQuestions.length,
      roundsChanged: brief.rounds.map((r) => r.level),
      roundCount: rounds.length,
      panelsSet: panels.set.map((p) => p.level),
      notInDirectory: panels.missing.map((m) => m.who),
      replaced: Boolean(req.brief),
    },
  });
  await tellDesk(orgId, subject.requisitionId, rounds.length, roundsKept, panels);
}

/** Match each named person to the panel directory by e-mail, else by name (exact, any case). */
async function applyNamedPanels(
  orgId: string,
  userId: string,
  requisitionId: string,
  brief: ExpertBriefContent,
  roundCount: number,
): Promise<{
  set: { level: number; names: string[] }[];
  missing: { level: number; who: string }[];
}> {
  const set: { level: number; names: string[] }[] = [];
  const missing: { level: number; who: string }[] = [];
  if (!brief.panel.length) return { set, missing };
  const { panelists } = await import("@db/schema");
  const { syncMemberPanelists, savePanel } = await import("@/lib/panels.server");
  await syncMemberPanelists(orgId);
  const directory = await db
    .select({ id: panelists.id, name: panelists.fullName, email: panelists.email })
    .from(panelists)
    .where(and(eq(panelists.orgId, orgId), eq(panelists.active, true)));
  for (const p of brief.panel) {
    if (p.level > roundCount) continue;
    const ids: string[] = [];
    const names: string[] = [];
    for (const who of p.people) {
      const w = who.trim().toLowerCase();
      const hit =
        directory.find((d) => d.email.toLowerCase() === w) ??
        directory.find((d) => d.name.trim().toLowerCase() === w);
      if (hit) {
        ids.push(hit.id);
        names.push(hit.name);
      } else missing.push({ level: p.level, who: who.trim() });
    }
    if (!ids.length) continue;
    try {
      await savePanel(orgId, userId, requisitionId, p.level, ids.slice(0, 3), true);
      set.push({ level: p.level, names });
    } catch {
      for (const n of names) missing.push({ level: p.level, who: n });
    }
  }
  return { set, missing };
}

/** On the role's hiring-desk thread: what changed, who to add, and to confirm the plan. */
async function tellDesk(
  orgId: string,
  requisitionId: string,
  roundCount: number,
  roundsKept: string | null,
  panels: { set: { level: number; names: string[] }[]; missing: { level: number; who: string }[] },
): Promise<void> {
  const desk = await import("../desk/desk.server");
  const convId = await desk.conversationForSubject(orgId, "requisition", requisitionId);
  if (!convId) return;
  const conv = await desk.loadConversation(orgId, convId);
  if (!conv) return;
  const lines = [
    `The hiring manager's brief is approved and applied: the plan now has ${roundCount} round${roundCount === 1 ? "" : "s"}.${roundsKept ? ` ${roundsKept}` : ""}`,
    ...panels.set.map((p) => `L${p.level} panel set to ${p.names.join(", ")}.`),
    ...(panels.missing.length
      ? [
          `Not in the panel directory yet: ${panels.missing.map((m) => `${m.who} (L${m.level})`).join(", ")}. Add them in the hiring plan's full editor (Panels → Add someone new) — the HR head or an owner.`,
        ]
      : []),
  ];
  await desk.postMessage(conv, { role: "desk", body: lines.join(" ") });
  await desk.showInterviewPlan(conv);
}
