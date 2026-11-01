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
  const rounds = plan.rounds.map((r) => {
    const b = brief.rounds.find((x) => x.level === r.level);
    return b ? { ...r, focus: b.focus || r.focus, competencies: b.competencies } : r;
  });
  if (brief.rounds.length) await savePlan(orgId, subject.requisitionId, { ...plan, rounds });
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
      replaced: Boolean(req.brief),
    },
  });
}
