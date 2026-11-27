/**
 * One more interview round for a candidate (propose_extra_round): when the
 * hiring manager wants another round before deciding, the Evaluation agent
 * drafts it from the earlier rounds' feedback and the role's hiring manager
 * (else the HR head) edits and approves it. Approving adds the round to the
 * role's interview plan — so every candidate of the role has it — and moves
 * this candidate into it; the Interview coordinator then proposes the round's
 * panel and offers times, as for any round. The agent never adds a round.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { agentTasks, applications, candidates, interviews, requisitions } from "@db/schema";
import { db } from "../db";
import { deciderOf } from "./panel-gate.server";
import { registerTool } from "./registry";

/** The round as drafted, or as the hiring manager changed it on the card. */
export const ExtraRound = z.object({
  name: z.string().trim().min(2).max(60),
  focus: z.string().trim().max(300).default(""),
  competencies: z.array(z.string().trim().min(2).max(60)).min(1).max(8),
});
export type ExtraRoundT = z.infer<typeof ExtraRound>;

/** The plan numbers rounds itself: "L3 - Hands-on" is stored as "Hands-on". */
export function cleanRound(r: ExtraRoundT): ExtraRoundT {
  const name = r.name.replace(/^L\s?\d\s*[-–—·:.]?\s*/i, "").trim();
  return { ...r, name: name.length >= 2 ? name : r.name };
}

export type RoundAdditionSubject = {
  type: "round_addition";
  applicationId: string;
  requisitionId: string;
  round: ExtraRoundT;
  reason: string;
  /** Rounds in the role's plan when proposed — a stale card is refused. */
  expects?: string;
};

type Facts = {
  code: string;
  title: string;
  hmMemberId: string | null;
  candidate: string;
  stage: string;
  requisitionId: string;
};

async function factsOf(orgId: string, applicationId: string): Promise<Facts | null> {
  const [r] = await db
    .select({
      code: requisitions.code,
      title: requisitions.title,
      hmMemberId: requisitions.hiringManagerMemberId,
      candidate: candidates.fullName,
      stage: applications.stage,
      requisitionId: applications.requisitionId,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  return r ? { ...r, stage: String(r.stage) } : null;
}

/** Why another round cannot be proposed for this candidate now (null: it can). */
export async function extraRoundBlocked(
  orgId: string,
  applicationId: string,
  /** Deciding the card itself: it is the open request, so it does not block. */
  opts: { deciding?: boolean } = {},
): Promise<string | null> {
  const f = await factsOf(orgId, applicationId);
  if (!f) return "Application not found.";
  const { progressOf } = await import("@/lib/interview-plan.server");
  const p = await progressOf(orgId, applicationId);
  if (p.plan.rounds.length >= 3)
    return "The role already has three interview rounds, the most a plan can have.";
  if (!p.finalComplete)
    return `The role's final round (L${p.finalLevel}) is not complete yet — another round is added only after it.`;
  if (f.stage !== `l${p.finalLevel}`)
    return `The candidate is no longer at L${p.finalLevel} (now ${f.stage}); another round does not apply.`;
  if (opts.deciding) return null;
  const [waiting] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "gate"),
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'type' = 'round_addition'`,
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'requisitionId' = ${f.requisitionId}`,
      ),
    )
    .limit(1);
  if (waiting) return "Another round for this role is already waiting for the hiring manager.";
  return null;
}

/** Who decides, what the card says, or why the proposal is refused. */
export async function roundGateFor(
  orgId: string,
  subject: RoundAdditionSubject,
): Promise<
  | {
      role: "hr_head" | null;
      assigneeUserId?: string;
      status: string;
      detail: string;
      subject: RoundAdditionSubject;
    }
  | { error: string }
> {
  const blocked = await extraRoundBlocked(orgId, subject.applicationId);
  if (blocked) return { error: blocked };
  const f = (await factsOf(orgId, subject.applicationId))!;
  const { planFor } = await import("@/lib/interview-plan.server");
  const { plan } = await planFor(orgId, f.requisitionId);
  const level = plan.rounds.length + 1;
  const { assigneeUserId, decider } = await deciderOf(orgId, f.hmMemberId);
  subject = { ...subject, round: cleanRound(subject.round) };
  const detail = [
    `Add L${level} · ${subject.round.name} to ${f.code} ${f.title}, and move ${f.candidate} into it.`,
    subject.round.focus ? `Focus: ${subject.round.focus}` : "",
    `Rated on: ${subject.round.competencies.join(", ")}.`,
    `The round joins the role's plan, so every candidate of this role takes it before a select. Earlier rounds: ${plan.rounds.map((r) => `L${r.level} ${r.name}`).join(", ")}.`,
    `Decided by ${decider}. Change the name, focus or what it rates before approving; you are then asked who interviews for it.`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    role: assigneeUserId ? null : "hr_head",
    ...(assigneeUserId ? { assigneeUserId } : {}),
    status: String(plan.rounds.length),
    detail,
    subject: { ...subject, requisitionId: f.requisitionId, expects: String(plan.rounds.length) },
  };
}

/**
 * Apply an approved round: appended to the role's plan (as the hiring manager
 * left it), the candidate moved into it as that person — which raises
 * application.advanced, so the Interview coordinator proposes the panel and
 * offers times. Audited. Declining changes nothing.
 */
export async function performRoundGate(
  orgId: string,
  actor: { orgId: string; userId: string; memberEmail: string },
  subject: RoundAdditionSubject,
  decision: { status: string; args?: unknown; comment?: string | undefined },
): Promise<void> {
  if (decision.status !== "approved") return;
  const blocked = await extraRoundBlocked(orgId, subject.applicationId, { deciding: true });
  if (blocked) throw new Error(blocked);
  const f = (await factsOf(orgId, subject.applicationId))!;
  const { planFor, savePlan } = await import("@/lib/interview-plan.server");
  const { plan } = await planFor(orgId, f.requisitionId);
  if (subject.expects !== undefined && String(plan.rounds.length) !== subject.expects)
    throw new Error(
      "This role's interview plan changed since this was proposed; refresh to see it.",
    );
  const edited = (decision.args as { round?: unknown } | undefined)?.round;
  const round = cleanRound(edited === undefined ? subject.round : ExtraRound.parse(edited));
  const level = plan.rounds.length + 1;
  await savePlan(orgId, f.requisitionId, {
    ...plan,
    rounds: [...plan.rounds, { level, ...round, panelSize: 1 }],
  });
  const [already] = await db
    .select({ id: interviews.id })
    .from(interviews)
    .where(
      and(
        eq(interviews.orgId, orgId),
        eq(interviews.applicationId, subject.applicationId),
        eq(interviews.level, level),
      ),
    )
    .limit(1);
  if (!already)
    await db.insert(interviews).values({
      applicationId: subject.applicationId,
      orgId,
      level,
      status: "pending_scheduling",
      scheduledAt: null,
    });
  const pipeline = await import("@/lib/pipeline.server");
  await pipeline.moveStageCore(actor, {
    applicationId: subject.applicationId,
    toStage: `l${level}` as never,
    reason: `Another round before the hiring decision: L${level} ${round.name}`,
    note: decision.comment?.trim() || null,
  });
  // The card keeps the agent's draft; the thread says what was actually added.
  try {
    const desk = await import("../desk/desk.server");
    const conv = await desk.conversationForRequisition(orgId, f.requisitionId);
    if (conv)
      await desk.postMessage(conv, {
        role: "desk",
        body: `Added L${level} · ${round.name} to the interview plan${round.focus ? ` — ${round.focus}` : ""}. Rated on: ${round.competencies.join(", ")}. ${f.candidate} is now in L${level}.`,
      });
  } catch {
    /* the thread is a courtesy; the plan and the audit trail have the record */
  }
  const { writeAudit } = await import("../audit");
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId,
    action: "interview_plan.round_added",
    entityType: "requisition",
    entityId: f.requisitionId,
    detail: {
      level,
      round,
      applicationId: subject.applicationId,
      changed: edited !== undefined,
    },
  });
}

/** What the agent is told once the round is approved. */
export async function roundAddedWords(orgId: string, subject: RoundAdditionSubject) {
  const { planFor } = await import("@/lib/interview-plan.server");
  const { plan } = await planFor(orgId, subject.requisitionId);
  const r = plan.rounds[plan.rounds.length - 1]!;
  return `Approved. L${r.level} ${r.name} is now the role's final round and the candidate is in it; the Interview coordinator arranges the panel and times. Do not request a hiring decision until it is complete — finish with the debrief.`;
}

export function registerRoundTools(): void {
  registerTool({
    name: "propose_extra_round",
    capability: "recruiting.interviews",
    description:
      "When the hiring manager declines a hiring decision because they want another interview round, propose that round for them to edit and approve: a short name, a one-line focus and 1–8 competencies to rate, drawn from the gaps and open questions in the earlier rounds' scorecards (never a new requirement the role does not have). The round is added to the role's plan for every candidate; you never add it yourself.",
    input: z.object({
      applicationId: z.string().uuid(),
      round: ExtraRound,
      reason: z.string().min(10).max(600),
    }),
    risk: "write",
    describe: () => "Another interview round",
    precheck: async (ctx, i) => extraRoundBlocked(ctx.orgId, i.applicationId),
    proposes: async (ctx, i) => {
      const f = await factsOf(ctx.orgId, i.applicationId);
      if (!f) throw new Error("Application not found.");
      return {
        title: `One more round for ${f.candidate}?`,
        summary: i.reason,
        subject: {
          type: "round_addition",
          applicationId: i.applicationId,
          requisitionId: f.requisitionId,
          round: cleanRound(i.round),
          reason: i.reason,
        },
      };
    },
    run: async () => {
      throw new Error("A round is added by a person.");
    },
  });
}
