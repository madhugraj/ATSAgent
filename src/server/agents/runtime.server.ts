/**
 * Agent runtime (docs/agentic-plan.md §3.2).
 *
 * A run is a row: its transcript is the checkpoint, so a crash, a deploy or a
 * week-long wait for an approver costs nothing. `runAgentTick` (called by the
 * scheduler through /api/public/agent-tick) reclaims expired leases, claims
 * queued runs and drives each one through model → tool → model turns until it
 * finishes, needs a person, or hits a budget.
 *
 * Safety properties, each enforced here rather than trusted to the model:
 *  - only tools the agent's definition lists can run, with zod-validated args;
 *  - write / external tools go through the org's autonomy policy;
 *  - tools run as the human principal, so existing role checks apply;
 *  - third-party text in tool output is fenced with untrusted();
 *  - every write/external action and every human decision is audited.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";

import {
  aiAgentStep,
  INJECTION_RULES,
  INVALID_TOOL_ARGS,
  toolParameters,
  untrusted,
  type AgentMessage,
  type AgentToolCall,
  type AgentToolSpec,
  type AiConfig,
} from "@/lib/ai-gateway.server";
import { assertRole, type AppRole } from "@/lib/auth.middleware";
import { db } from "../db";
import { writeAudit } from "../audit";
import { log } from "../log";
import {
  agentPolicies,
  agentRuns,
  agentSteps,
  agentTasks,
  applications,
  candidates,
  jobDescriptions,
  offers,
  onboardingDocuments,
  requisitions,
  type AgentTaskKind,
  type AgentType,
} from "@db/schema";
import { agentRunScope } from "./context";
import { ensureDefinition, manifestHash, RUNTIME_RULES } from "./manifest.server";
import { looksLikeInjection } from "./injection";
import { decideToolCall, loadPolicy } from "./policy";
import { getAgent, getTool, type ToolContext } from "./registry";

/**
 * Eval-only: run agents against a fixed model config instead of the org's
 * saved key (scripts/agent-eval.ts). Never set in the app.
 */
let modelOverride: AiConfig | null = null;
export function setEvalModelOverride(cfg: AiConfig | null): void {
  modelOverride = cfg;
}

const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 3;
/** Model turns per run per tick, so one long run cannot starve the queue. */
const TURNS_PER_TICK = 8;
const CONCURRENCY = 2;
const PREVIEW_CHARS = 600;

/** The harness limits every run executes under (shown in Agent observability). */
export const HARNESS_LIMITS = {
  leaseMinutes: LEASE_MINUTES,
  maxAttempts: MAX_ATTEMPTS,
  turnsPerTick: TURNS_PER_TICK,
  concurrency: CONCURRENCY,
  /** agent_runs.max_tokens default (per run). */
  maxTokensPerRun: 200_000,
  /** Budget-paused runs are re-checked after this many minutes. */
  budgetRecheckMinutes: 60,
} as const;

type AgentRun = typeof agentRuns.$inferSelect;
type PendingCall = { taskId: string; call: AgentToolCall };

import { HITL_TOOLS, isHitl, type HitlName } from "./hitl";

/* --------------------------------------------- gates tied to real records */

type RecordSubject = { type: "requisition" | "jd" | "offer"; id: string; expects?: string };
type RejectionSubject = {
  type: "rejection";
  items: { applicationId: string; reason: string; expects?: string }[];
};
type HiringDecisionSubject = {
  type: "hiring_decision";
  applicationId: string;
  recommendation: "select" | "hold" | "reject";
  rationale: string;
  expects?: string;
};
type OfferReleaseSubject = { type: "offer_release"; offerId: string; expects?: string };
type DocumentValidationSubject = {
  type: "document_validation";
  applicationId: string;
  documentIds: string[];
};
type GateSubject =
  | RecordSubject
  | RejectionSubject
  | HiringDecisionSubject
  | OfferReleaseSubject
  | DocumentValidationSubject;

const OFFER_APPROVER: Record<string, AppRole> = {
  pending_hr: "hr_head",
  pending_cbo: "president_cbo",
};
const OFFER_NEXT: Record<string, "pending_cbo" | "approved"> = {
  pending_hr: "pending_cbo",
  pending_cbo: "approved",
};

const DECISION_STAGES = new Set(["l1", "l2", "l3", "on_hold", "reserve", "offer_pending"]);

const TERMINAL_STAGES = new Set(["rejected", "hired", "joined", "withdrawn", "no_show"]);

/** Which role must decide `subject` now, or why it is not awaiting approval. */
type GateInfo = {
  role: AppRole | null;
  status: string;
  /** Rejection batches go to the person the agent works for. */
  toPrincipal?: boolean;
  /** Server-built detail appended to the agent's summary. */
  detail?: string;
  subject?: GateSubject;
};

async function gateFor(orgId: string, subject: GateSubject): Promise<GateInfo | { error: string }> {
  if (subject.type === "offer" || subject.type === "offer_release") {
    const offerId = "offerId" in subject ? subject.offerId : subject.id;
    const [o] = await db
      .select({
        status: offers.status,
        applicationId: offers.applicationId,
        ctc: offers.offeredCtc,
        name: candidates.fullName,
        title: requisitions.title,
      })
      .from(offers)
      .innerJoin(applications, eq(applications.id, offers.applicationId))
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(and(eq(offers.id, offerId), eq(offers.orgId, orgId)))
      .limit(1);
    if (!o) return { error: "Offer not found." };
    if (subject.type === "offer") {
      const role = OFFER_APPROVER[o.status];
      if (!role) return { error: `The offer is ${o.status}, not waiting for an approval.` };
      return {
        role,
        status: o.status,
        detail: `Offer for ${o.name} (${o.title}): ${Number(o.ctc).toLocaleString()} CTC — ${o.status}.`,
      };
    }
    if (o.status !== "approved")
      return { error: `The offer is ${o.status}; only approved offers are released.` };
    const { readinessFor, docTypeLabel } = await import("@/lib/onboarding.server");
    const ready = await readinessFor(orgId, o.applicationId);
    if (!ready.ready) {
      return {
        error: `Pre-onboarding is incomplete — still missing verified: ${ready.missing.map(docTypeLabel).join(", ")}.`,
      };
    }
    return {
      role: "hr_head",
      status: o.status,
      detail: `Release the approved offer to ${o.name} (${o.title}). All required pre-onboarding documents are verified.\n\nApprove to release the offer letter; decline to hold it.`,
      subject: { ...subject, expects: o.status },
    };
  }
  if (subject.type === "document_validation") {
    const docs = await db
      .select({
        id: onboardingDocuments.id,
        docType: onboardingDocuments.docType,
        fileName: onboardingDocuments.fileName,
        status: onboardingDocuments.status,
      })
      .from(onboardingDocuments)
      .where(
        and(
          inArray(onboardingDocuments.id, subject.documentIds),
          eq(onboardingDocuments.orgId, orgId),
          eq(onboardingDocuments.applicationId, subject.applicationId),
        ),
      );
    if (docs.length !== new Set(subject.documentIds).size) {
      return { error: "Some documents were not found for this application." };
    }
    const notPending = docs.filter((d) => d.status !== "pending");
    if (notPending.length)
      return { error: `Already reviewed: ${notPending.map((d) => d.fileName).join(", ")}` };
    const { docTypeLabel } = await import("@/lib/onboarding.server");
    return {
      role: "hr_head",
      status: "pending",
      detail: `Documents to validate (${docs.length}):\n${docs.map((d) => `• ${docTypeLabel(d.docType)} — ${d.fileName}`).join("\n")}\n\nApprove to mark them verified; decline to reject them (give the reason the candidate will see).`,
    };
  }
  if (subject.type === "hiring_decision") {
    const [row] = await db
      .select({
        stage: applications.stage,
        name: candidates.fullName,
        code: requisitions.code,
        title: requisitions.title,
      })
      .from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(and(eq(applications.id, subject.applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    if (!row) return { error: "Application not found." };
    if (!DECISION_STAGES.has(row.stage)) {
      return {
        error: `The candidate is ${row.stage}; a hiring decision follows the interview rounds.`,
      };
    }
    return {
      role: "hiring_manager",
      status: row.stage,
      detail: `Hiring decision for ${row.name} (${row.code} ${row.title}, ${row.stage}).\nRecommendation: ${subject.recommendation.toUpperCase()}\nRationale: ${subject.rationale}\n\nApprove to accept this recommendation; decline to leave the candidate where they are.`,
      subject: { ...subject, expects: row.stage },
    };
  }
  if (subject.type === "rejection") {
    const ids = subject.items.map((i) => i.applicationId);
    const rows = await db
      .select({
        id: applications.id,
        stage: applications.stage,
        name: candidates.fullName,
        code: requisitions.code,
      })
      .from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(and(inArray(applications.id, ids), eq(applications.orgId, orgId)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return { error: `Applications not found: ${missing.join(", ")}` };
    const closed = rows.filter((r) => TERMINAL_STAGES.has(r.stage));
    if (closed.length) {
      return { error: `Already closed: ${closed.map((r) => r.name).join(", ")}` };
    }
    const items = subject.items.map((i) => ({ ...i, expects: byId.get(i.applicationId)!.stage }));
    const detail = items
      .map((i) => {
        const r = byId.get(i.applicationId)!;
        return `• ${r.name} (${r.code}, ${r.stage}) — ${i.reason}`;
      })
      .join("\n");
    return {
      role: null,
      status: "batch",
      toPrincipal: true,
      detail: `Candidates to reject (${items.length}):\n${detail}`,
      subject: { type: "rejection", items },
    };
  }
  const { APPROVER_ROLE } = await import("@/lib/requisitions.server");
  if (subject.type === "requisition") {
    const [r] = await db
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(and(eq(requisitions.id, subject.id), eq(requisitions.orgId, orgId)))
      .limit(1);
    if (!r) return { error: "Requisition not found." };
    const role = APPROVER_ROLE[r.status];
    if (!role) return { error: `The requisition is ${r.status}, not waiting for an approval.` };
    return { role, status: r.status };
  }
  const [jd] = await db
    .select({ status: jobDescriptions.status })
    .from(jobDescriptions)
    .where(and(eq(jobDescriptions.id, subject.id), eq(jobDescriptions.orgId, orgId)))
    .limit(1);
  if (!jd) return { error: "Job description not found." };
  if (jd.status !== "pending_dh") {
    return { error: `The job description is ${jd.status}, not waiting for review.` };
  }
  return { role: "department_head", status: jd.status };
}

/**
 * Carry out the human decision on a gate tied to a requisition or JD, as the
 * person deciding — the lifecycle core checks their role exactly as on the
 * requisition page. Throws (and the task stays open) if they may not decide.
 */
async function performGate(
  orgId: string,
  userId: string,
  subject: GateSubject,
  decision: TaskDecision,
): Promise<void> {
  const lifecycle = await import("@/lib/requisitions.server");
  const { activeOrgOf } = await import("@/lib/auth.middleware");
  const org = await activeOrgOf(userId);
  if (!org || org.orgId !== orgId) throw new Error("You are not a member of this organisation.");
  const actor = { orgId, userId, memberEmail: org.memberEmail };
  if (subject.type === "offer" || subject.type === "offer_release") {
    if (decision.status !== "approved") return; // declining leaves the offer where it is
    const offerId = "offerId" in subject ? subject.offerId : subject.id;
    const [o] = await db
      .select({ status: offers.status })
      .from(offers)
      .where(and(eq(offers.id, offerId), eq(offers.orgId, orgId)))
      .limit(1);
    if (!o) throw new Error("Offer not found.");
    if (subject.expects && o.status !== subject.expects) {
      throw new Error("This offer has already moved on; refresh to see its current state.");
    }
    const { advanceOfferCore } = await import("@/lib/offers.functions");
    if (subject.type === "offer_release") {
      await advanceOfferCore(actor, {
        id: offerId,
        status: "released",
        applicationStage: "offer_released",
      });
      return;
    }
    const next = OFFER_NEXT[o.status];
    if (!next) throw new Error(`The offer is ${o.status}, not waiting for an approval.`);
    await advanceOfferCore(actor, { id: offerId, status: next });
    return;
  }
  if (subject.type === "document_validation") {
    const { reviewOnboardingDocCore } = await import("@/lib/onboarding.functions");
    const note =
      decision.status === "approved"
        ? (decision.comment ?? null)
        : decision.status === "rejected"
          ? decision.reason?.trim() || "Not accepted at HR validation — please resend a clear copy."
          : null;
    for (const id of subject.documentIds) {
      const [d] = await db
        .select({ status: onboardingDocuments.status })
        .from(onboardingDocuments)
        .where(and(eq(onboardingDocuments.id, id), eq(onboardingDocuments.orgId, orgId)))
        .limit(1);
      if (!d || d.status !== "pending") continue;
      await reviewOnboardingDocCore(actor, {
        id,
        decision: decision.status === "approved" ? "verified" : "rejected",
        note,
      });
    }
    return;
  }
  if (subject.type === "hiring_decision") {
    if (decision.status !== "approved") return; // declining changes nothing
    const [app] = await db
      .select({ stage: applications.stage, candidateId: applications.candidateId })
      .from(applications)
      .where(and(eq(applications.id, subject.applicationId), eq(applications.orgId, orgId)))
      .limit(1);
    if (!app) throw new Error("Application not found.");
    if (subject.expects && app.stage !== subject.expects) {
      throw new Error("This candidate has already moved on; refresh to see their current stage.");
    }
    const pipeline = await import("@/lib/pipeline.server");
    const note =
      decision.status === "approved" && decision.comment ? ` Comment: ${decision.comment}` : "";
    if (subject.recommendation === "select") {
      await pipeline.addCandidateNoteCore(actor, {
        candidateId: app.candidateId,
        body: `Hiring decision: SELECT. ${subject.rationale}${note}`,
      });
      const { emitAgentEvent } = await import("./events");
      await emitAgentEvent({
        orgId,
        type: "hiring.selected",
        subjectType: "application",
        subjectId: subject.applicationId,
        actorUserId: userId,
        payload: { rationale: subject.rationale },
      });
      return;
    }
    await pipeline.moveStageCore(actor, {
      applicationId: subject.applicationId,
      toStage: subject.recommendation === "reject" ? "rejected" : "on_hold",
      reason: subject.rationale,
      note: note.trim() || null,
    });
    return;
  }
  if (subject.type === "rejection") {
    if (decision.status !== "approved") return; // declining rejects nobody
    const { moveStageCore } = await import("@/lib/pipeline.server");
    for (const item of subject.items) {
      const [app] = await db
        .select({ stage: applications.stage })
        .from(applications)
        .where(and(eq(applications.id, item.applicationId), eq(applications.orgId, orgId)))
        .limit(1);
      // Skip anyone who moved since the batch was proposed.
      if (!app || (item.expects && app.stage !== item.expects)) continue;
      await moveStageCore(actor, {
        applicationId: item.applicationId,
        toStage: "rejected",
        reason: item.reason,
      });
    }
    return;
  }
  const reason =
    decision.status === "rejected"
      ? (decision.reason ?? null)
      : decision.status === "approved"
        ? (decision.comment ?? null)
        : null;
  if (subject.type === "requisition") {
    const [r] = await db
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(and(eq(requisitions.id, subject.id), eq(requisitions.orgId, orgId)))
      .limit(1);
    if (!r) throw new Error("Requisition not found.");
    if (subject.expects && r.status !== subject.expects) {
      throw new Error("This requisition has already moved on; refresh to see its current state.");
    }
    const to =
      decision.status === "approved" ? lifecycle.NEXT_APPROVAL[r.status] : ("rejected" as const);
    if (!to) throw new Error(`The requisition is ${r.status}, not waiting for an approval.`);
    await lifecycle.advanceRequisitionCore(actor, { id: subject.id, status: to, comment: reason });
    return;
  }
  if (decision.status === "approved") {
    await lifecycle.approveJobDescriptionCore(actor, { id: subject.id });
  } else {
    await lifecycle.requestJdChangesCore(actor, {
      id: subject.id,
      comment: reason?.trim() || "Changes requested.",
    });
  }
}

/**
 * Close gate tasks whose requisition or JD was decided outside the inbox
 * (e.g. on the requisition page), so the waiting agent run carries on.
 */
export async function syncGateTasks(
  orgId: string,
  subject: { type: "requisition" | "jd" | "offer"; id: string },
  decidedBy: string | null,
  /** The status the event moved the record away from; only gates waiting on it close. */
  fromStatus: string,
): Promise<number> {
  const open = await db
    .select()
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "gate"),
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'id' = ${subject.id}`,
      ),
    );
  let closed = 0;
  for (const t of open) {
    const expects = (t.proposedAction as { args?: { subject?: RecordSubject } } | null)?.args
      ?.subject?.expects;
    const current =
      subject.type === "offer"
        ? (
            await db
              .select({ status: offers.status })
              .from(offers)
              .where(eq(offers.id, subject.id))
              .limit(1)
          )[0]?.status
        : subject.type === "requisition"
          ? (
              await db
                .select({ status: requisitions.status })
                .from(requisitions)
                .where(eq(requisitions.id, subject.id))
                .limit(1)
            )[0]?.status
          : (
              await db
                .select({ status: jobDescriptions.status })
                .from(jobDescriptions)
                .where(eq(jobDescriptions.id, subject.id))
                .limit(1)
            )[0]?.status;
    if (expects !== fromStatus || !current || current === expects) continue;
    const declined = current === "rejected" || current === "changes_requested";
    const now = new Date();
    const done = await db
      .update(agentTasks)
      .set({
        status: declined ? "rejected" : "approved",
        response: {
          status: declined ? "rejected" : "approved",
          [declined ? "reason" : "comment"]: `Decided outside the inbox (now ${current}).`,
        } as never,
        decidedBy,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentTasks.id, t.id), eq(agentTasks.status, "open")))
      .returning({ id: agentTasks.id });
    if (!done.length) continue;
    closed++;
    await requeueIfUnblocked(t.runId);
  }
  return closed;
}

async function requeueIfUnblocked(runId: string) {
  const [stillOpen] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")))
    .limit(1);
  if (stillOpen) return;
  await db
    .update(agentRuns)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "awaiting_human")));
}

/* ------------------------------------------------------------ public API */

/** Queue a new run. The goal must not embed untrusted text without untrusted(). */
export async function startRun(input: {
  orgId: string;
  agentType: AgentType;
  principalUserId: string;
  goal: string;
  subjectType?: string | null;
  subjectId?: string | null;
  triggerEventId?: string | null;
  maxSteps?: number;
  /** Hiring-desk thread; defaults to the thread of the subject's requisition. */
  conversationId?: string | null;
}): Promise<{ runId: string }> {
  const def = getAgent(input.agentType);
  if (!def) throw new Error(`Unknown agent: ${input.agentType}`);
  const definition = await ensureDefinition(def);
  let conversationId = input.conversationId ?? null;
  if (!conversationId && input.subjectId) {
    try {
      const { conversationForSubject } = await import("../desk/desk.server");
      conversationId = await conversationForSubject(
        input.orgId,
        input.subjectType,
        input.subjectId,
      );
    } catch (e) {
      log.warn("desk.link_failed", { org_id: input.orgId, error: e as Error });
    }
  }
  const [run] = await db
    .insert(agentRuns)
    .values({
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: definition.hash,
      orgId: input.orgId,
      agentType: input.agentType,
      principalUserId: input.principalUserId,
      goal: input.goal,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      triggerEventId: input.triggerEventId ?? null,
      maxSteps: input.maxSteps ?? def.maxSteps ?? 20,
      conversationId,
      transcript: [{ role: "user", content: input.goal } satisfies AgentMessage],
    })
    .returning({ id: agentRuns.id });
  await writeAudit({
    actor: `agent:${input.agentType}:${run!.id}`,
    actorUserId: input.principalUserId,
    orgId: input.orgId,
    action: "agent.run.started",
    entityType: "agent_run",
    entityId: run!.id,
    detail: {
      on_behalf_of: input.principalUserId,
      definition_version: definition.version,
      definition_hash: definition.hash,
      subject: input.subjectId ? { type: input.subjectType ?? null, id: input.subjectId } : null,
      trigger_event_id: input.triggerEventId ?? null,
    },
  });
  return { runId: run!.id };
}

/** Statuses a run can be replayed from. */
const REPLAYABLE = new Set(["done", "failed", "cancelled"]);

/**
 * Queue a dry-run replay of a finished live run (docs/agentic-plan.md §11):
 * the same goal under the agent's current definition and the org's current
 * model settings. Read tools run for real; write, external and human steps
 * are simulated, so a replay changes nothing and asks nobody. Compare it with
 * the original via `compareRuns`.
 */
export async function startReplay(input: {
  orgId: string;
  runId: string;
  userId: string;
}): Promise<{ runId: string }> {
  const [orig] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.orgId, input.orgId)))
    .limit(1);
  if (!orig) throw new Error("Run not found");
  if (orig.mode !== "live") throw new Error("Replay the original run, not a replay.");
  if (!REPLAYABLE.has(orig.status)) throw new Error("Only finished runs can be replayed.");
  const def = getAgent(orig.agentType);
  if (!def) throw new Error(`Unknown agent: ${orig.agentType}`);
  const definition = await ensureDefinition(def);
  const [run] = await db
    .insert(agentRuns)
    .values({
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: definition.hash,
      orgId: orig.orgId,
      agentType: orig.agentType,
      // Reads run with the requester's own permissions.
      principalUserId: input.userId,
      goal: orig.goal,
      subjectType: orig.subjectType,
      subjectId: orig.subjectId,
      maxSteps: orig.maxSteps,
      mode: "replay",
      replayOf: orig.id,
      transcript: [{ role: "user", content: orig.goal } satisfies AgentMessage],
    })
    .returning({ id: agentRuns.id });
  await writeAudit({
    actor: `user:${input.userId}`,
    actorUserId: input.userId,
    orgId: input.orgId,
    action: "agent.run.replay_started",
    entityType: "agent_run",
    entityId: run!.id,
    detail: {
      replay_of: orig.id,
      original_definition_hash: orig.definitionHash,
      definition_version: definition.version,
      definition_hash: definition.hash,
    },
  });
  return { runId: run!.id };
}

export type TaskDecision =
  | { status: "approved"; args?: unknown; comment?: string | undefined }
  | { status: "rejected"; reason?: string | undefined }
  | { status: "answered"; answer: string };

/**
 * Record a person's decision on an open task and re-queue the run when no
 * other decision is outstanding. The decider must hold the task's role (the
 * org owner passes) or be its named assignee.
 */
export async function resolveTask(input: {
  orgId: string;
  taskId: string;
  userId: string;
  decision: TaskDecision;
}): Promise<void> {
  const [task] = await db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.id, input.taskId), eq(agentTasks.orgId, input.orgId)))
    .limit(1);
  if (!task) throw new Error("Task not found");
  if (task.status !== "open") throw new Error("This task has already been decided.");
  if (task.assigneeUserId && task.assigneeUserId !== input.userId) {
    throw new Error("This task is assigned to someone else.");
  }
  if (task.assigneeRole) await assertRole(input.userId, input.orgId, task.assigneeRole as AppRole);
  const { decision } = input;
  if (task.kind === "clarification" && decision.status !== "answered") {
    throw new Error("Answer the question to continue.");
  }
  if (task.kind !== "clarification" && decision.status === "answered") {
    throw new Error("Approve or reject this request.");
  }

  // A gate tied to a requisition or JD performs the real approval step first;
  // if the decider may not make it, this throws and the task stays open.
  const gateSubject = (task.proposedAction as { args?: { subject?: GateSubject } } | null)?.args
    ?.subject;
  if (task.kind === "gate" && gateSubject) {
    await performGate(input.orgId, input.userId, gateSubject, decision);
  }

  const now = new Date();
  const updated = await db
    .update(agentTasks)
    .set({
      status: decision.status,
      response: decision as never,
      decidedBy: input.userId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, "open")))
    .returning({ id: agentTasks.id });
  if (!updated.length) throw new Error("This task has already been decided.");

  await writeAudit({
    actor: `user:${input.userId}`,
    actorUserId: input.userId,
    orgId: input.orgId,
    action: `agent.task.${decision.status}`,
    entityType: "agent_task",
    entityId: task.id,
    detail: {
      run_id: task.runId,
      kind: task.kind,
      edited: decision.status === "approved" && decision.args !== undefined,
    },
  });

  await requeueIfUnblocked(task.runId);
}

/** Stop a run and close its open tasks. */
export async function cancelRun(input: { orgId: string; runId: string; userId: string }) {
  const now = new Date();
  const done = await db
    .update(agentRuns)
    .set({ status: "cancelled", finishedAt: now, updatedAt: now, leaseUntil: null })
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.orgId, input.orgId),
        inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
      ),
    )
    .returning({ id: agentRuns.id });
  if (!done.length) return;
  await db
    .update(agentTasks)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(agentTasks.runId, input.runId), eq(agentTasks.status, "open")));
  await writeAudit({
    actor: `user:${input.userId}`,
    actorUserId: input.userId,
    orgId: input.orgId,
    action: "agent.run.cancelled",
    entityType: "agent_run",
    entityId: input.runId,
  });
}

export type TickCounts = {
  events: number;
  reclaimed: number;
  claimed: number;
  done: number;
  awaiting: number;
  yielded: number;
  failed: number;
};

/** One scheduler tick: reclaim expired leases, claim queued runs, drive them. */
/** `orgId` limits the tick to one organisation (eval harness); the scheduler omits it. */
export async function runAgentTick(
  opts: { max?: number; orgId?: string } = {},
): Promise<TickCounts> {
  const max = Math.min(Math.max(opts.max ?? 10, 1), 50);
  const counts: TickCounts = {
    events: 0,
    reclaimed: 0,
    claimed: 0,
    done: 0,
    awaiting: 0,
    yielded: 0,
    failed: 0,
  };
  const now = new Date();

  // 0. Turn lifecycle events into agent runs and close gates decided elsewhere.
  try {
    const { processAgentEvents } = await import("./orchestrator.server");
    counts.events = (await processAgentEvents(opts.orgId ? { orgId: opts.orgId } : {})).processed;
    const { scheduleSweeps } = await import("./orchestrator.server");
    await scheduleSweeps(opts.orgId ? { orgId: opts.orgId } : {});
  } catch (e) {
    log.error("agent.orchestrator.failed", { error: e instanceof Error ? e : String(e) });
  }

  // 1. Reclaim runs whose worker died mid-turn; give up after MAX_ATTEMPTS.
  const expired = await db
    .update(agentRuns)
    .set({
      status: sql`case when ${agentRuns.attempts} + 1 >= ${MAX_ATTEMPTS} then 'failed' else 'queued' end`,
      attempts: sql`${agentRuns.attempts} + 1`,
      lastError: "The worker stopped before finishing this step.",
      leaseUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentRuns.status, "running"),
        lt(agentRuns.leaseUntil, now),
        opts.orgId ? eq(agentRuns.orgId, opts.orgId) : undefined,
      ),
    )
    .returning({ id: agentRuns.id });
  counts.reclaimed = expired.length;

  // 2. Claim queued runs of agents the org has switched on (opt-in) and not
  //    paused org-wide; disjoint across workers.
  const paused = db
    .select({ one: sql`1` })
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.orgId, agentRuns.orgId),
        eq(agentPolicies.agentType, "*"),
        eq(agentPolicies.enabled, false),
      ),
    );
  const switchedOn = db
    .select({ one: sql`1` })
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.orgId, agentRuns.orgId),
        sql`${agentPolicies.agentType} = ${agentRuns.agentType}`,
        eq(agentPolicies.enabled, true),
      ),
    );
  const dueIds = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "queued"),
        // leaseUntil on a queued run is a "not before" (budget pause).
        sql`(${agentRuns.leaseUntil} is null or ${agentRuns.leaseUntil} < now())`,
        sql`not exists (${paused})`,
        // A dry-run replay changes nothing, so it does not need the agent switched on.
        sql`(${agentRuns.mode} = 'replay' or exists (${switchedOn}))`,
        opts.orgId ? eq(agentRuns.orgId, opts.orgId) : undefined,
      ),
    )
    .orderBy(agentRuns.updatedAt)
    .limit(max)
    .for("update", { skipLocked: true });
  const claimed = await db
    .update(agentRuns)
    .set({
      status: "running",
      leaseUntil: new Date(now.getTime() + LEASE_MINUTES * 60_000),
      startedAt: sql`coalesce(${agentRuns.startedAt}, now())`,
      updatedAt: now,
    })
    .where(inArray(agentRuns.id, dueIds))
    .returning();
  counts.claimed = claimed.length;

  // 3. Drive them.
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      const started = Date.now();
      const runLog = log.child({
        trace_id: run.traceId,
        run_id: run.id,
        org_id: run.orgId,
        agent: run.agentType,
      });
      const scoped = run;
      const outcome = await agentRunScope
        .run({ runId: scoped.id, orgId: scoped.orgId, agentType: scoped.agentType }, () =>
          driveRun(scoped),
        )
        .catch(async (e: unknown) => {
          runLog.error("agent.run.crashed", { error: e instanceof Error ? e : String(e) });
          await finish(run!, "failed", null, e instanceof Error ? e.message : String(e));
          return "failed" as const;
        });
      runLog.info("agent.run.turn", { outcome, duration_ms: Date.now() - started });
      counts[outcome]++;
    }
  });
  await Promise.all(workers);

  // 4. Keep today's dashboard rollup fresh (cheap: only orgs with recent activity).
  try {
    const { rollupAgentMetrics } = await import("./metrics.server");
    await rollupAgentMetrics();
  } catch (e) {
    log.error("agent.metrics.rollup_failed", { error: e instanceof Error ? e : String(e) });
  }
  if (counts.claimed || counts.reclaimed || counts.events) log.info("agent.tick", counts);

  // 5. Liveness heartbeat, and the health engine every few minutes. Only the
  //    scheduler's org-wide tick counts — not inline per-org kicks.
  if (!opts.orgId) {
    try {
      const { heartbeatAndMaybeEvaluate } = await import("./health.server");
      await heartbeatAndMaybeEvaluate(counts);
    } catch (e) {
      log.error("agent.health.failed", { error: e instanceof Error ? e : String(e) });
    }
  }

  // 6. Trace export to organisations' own OpenTelemetry collectors.
  if (!opts.orgId) {
    try {
      const { exportAgentTraces } = await import("./otel.server");
      const x = await exportAgentTraces();
      if (x.runs) log.info("agent.otel.exported", x);
    } catch (e) {
      log.error("agent.otel.failed", { error: e instanceof Error ? e : String(e) });
    }
  }
  return counts;
}

/* -------------------------------------------------------------- internals */

async function driveRun(run: AgentRun): Promise<"done" | "awaiting" | "yielded" | "failed"> {
  const def = getAgent(run.agentType);
  if (!def) {
    await finish(run, "failed", null, `Unknown agent: ${run.agentType}`);
    return "failed";
  }
  const policy = await loadPolicy(run.orgId, run.agentType);
  const ctx: ToolContext = {
    orgId: run.orgId,
    principalUserId: run.principalUserId,
    runId: run.id,
    agentType: run.agentType,
    actor: `agent:${run.agentType}:${run.id}`,
  };
  const transcript = [...(run.transcript as AgentMessage[])];
  let seq = await nextSeq(run.id);
  let stepCount = run.stepCount;
  let tokensUsed = run.tokensUsed;

  // Resume: turn each decided task into the tool result the model is waiting for.
  if (run.pending) {
    for (const p of run.pending as PendingCall[]) {
      const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, p.taskId)).limit(1);
      const message = await applyDecision(ctx, task, p.call, seq++);
      transcript.push(message);
    }
  }

  const allowed = new Set(def.tools);
  const specs: AgentToolSpec[] = [
    ...def.tools.flatMap((name) => {
      const t = getTool(name);
      return t ? [{ name, description: t.description, parameters: toolParameters(t.input) }] : [];
    }),
    ...(Object.keys(HITL_TOOLS) as HitlName[]).map((name) => ({
      name,
      description: HITL_TOOLS[name].description,
      parameters: toolParameters(HITL_TOOLS[name].input),
    })),
  ];
  const system = `${INJECTION_RULES}\n\n${RUNTIME_RULES}\n\n${def.system}`;

  // A deploy may have changed the agent since this run started: record the
  // definition the remaining steps execute under.
  if (run.definitionHash !== manifestHash(def)) {
    const d = await ensureDefinition(def);
    await db
      .update(agentRuns)
      .set({ definitionId: d.id, definitionVersion: d.version, definitionHash: d.hash })
      .where(eq(agentRuns.id, run.id));
    await writeAudit({
      actor: ctx.actor,
      actorUserId: run.principalUserId,
      orgId: run.orgId,
      action: "agent.run.definition_changed",
      entityType: "agent_run",
      entityId: run.id,
      detail: { from: run.definitionHash, to: d.hash, version: d.version },
    });
    run.definitionHash = d.hash;
  }

  for (let turn = 0; turn < TURNS_PER_TICK; turn++) {
    if (await overBudget(run, policy.monthlyTokenBudget)) {
      await save(run, transcript, null, stepCount, tokensUsed);
      await pauseForBudget(run);
      return "yielded";
    }
    if (stepCount >= run.maxSteps || tokensUsed >= run.maxTokens) {
      await save(run, transcript, null, stepCount, tokensUsed);
      await finish(run, "failed", null, "The run reached its step or token budget.");
      return "failed";
    }

    const started = Date.now();
    const res = await aiAgentStep({
      system,
      messages: transcript,
      tools: specs,
      orgId: run.orgId,
      feature: def.feature,
      ...(modelOverride ? { config: modelOverride } : {}),
    });
    stepCount++;
    if (!res.ok) {
      await recordStep(run, seq++, {
        kind: "model",
        status: "error",
        output: { error: res.message },
        durationMs: Date.now() - started,
      });
      await save(run, transcript, null, stepCount, tokensUsed);
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && run.attempts + 1 < MAX_ATTEMPTS) {
        await db
          .update(agentRuns)
          .set({
            status: "queued",
            attempts: run.attempts + 1,
            lastError: res.message,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        return "yielded";
      }
      await finish(run, "failed", null, res.message);
      return "failed";
    }

    tokensUsed += res.usage?.totalTokens ?? 0;
    await recordStep(run, seq++, {
      kind: "model",
      status: "ok",
      output: {
        text: preview(res.text),
        toolCalls: res.toolCalls.map((c) => c.name),
        stopReason: res.stopReason,
      },
      promptTokens: res.usage?.promptTokens ?? 0,
      completionTokens: res.usage?.completionTokens ?? 0,
      durationMs: Date.now() - started,
    });
    transcript.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    if (!res.toolCalls.length) {
      await save(run, transcript, null, stepCount, tokensUsed);
      await finish(run, "done", res.text.trim() || "Done.", null);
      return "done";
    }

    const pending: PendingCall[] = [];
    for (const call of res.toolCalls) {
      const outcome = await handleCall(run, ctx, policy, allowed, call, seq++);
      if (outcome.kind === "message") transcript.push(outcome.message);
      else if (outcome.kind === "pending") pending.push({ taskId: outcome.taskId, call });
      else {
        // handoff: close the turn so the transcript stays well-formed.
        transcript.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: "Handed off.",
        });
        await save(run, transcript, null, stepCount, tokensUsed);
        await finish(run, "done", `Handed off: ${outcome.reason}`, null);
        return "done";
      }
    }

    if (pending.length) {
      await save(run, transcript, pending, stepCount, tokensUsed);
      await db
        .update(agentRuns)
        .set({ status: "awaiting_human", leaseUntil: null, updatedAt: new Date() })
        .where(eq(agentRuns.id, run.id));
      return "awaiting";
    }
  }

  // Yield the worker; the run continues on the next tick.
  await save(run, transcript, null, stepCount, tokensUsed);
  await db
    .update(agentRuns)
    .set({ status: "queued", leaseUntil: null, updatedAt: new Date() })
    .where(eq(agentRuns.id, run.id));
  return "yielded";
}

type CallOutcome =
  | { kind: "message"; message: AgentMessage }
  | { kind: "pending"; taskId: string }
  | { kind: "handoff"; reason: string };

async function handleCall(
  run: AgentRun,
  ctx: ToolContext,
  policy: Awaited<ReturnType<typeof loadPolicy>>,
  allowed: Set<string>,
  call: AgentToolCall,
  seq: number,
): Promise<CallOutcome> {
  const toolError = async (message: string): Promise<CallOutcome> => {
    await recordStep(run, seq, {
      kind: "tool",
      toolName: call.name,
      toolCallId: call.id,
      status: "error",
      input: redactArgs(call.args),
      output: { error: message },
    });
    return {
      kind: "message",
      message: {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: message,
        isError: true,
      },
    };
  };

  if (call.args && typeof call.args === "object" && INVALID_TOOL_ARGS in call.args) {
    return toolError("The tool arguments were not valid JSON. Send a JSON object.");
  }

  if (isHitl(call.name)) {
    const parsed = HITL_TOOLS[call.name].input.safeParse(call.args);
    if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.message}`);
    if (call.name === "handoff") {
      const { reason } = parsed.data as { reason: string };
      await recordStep(run, seq, {
        kind: "decision",
        toolName: call.name,
        toolCallId: call.id,
        status: "ok",
        input: { reason: preview(reason) },
      });
      return { kind: "handoff", reason };
    }
    if (run.mode === "replay" && call.name === "ask_human") {
      return simulated(
        run,
        call,
        seq,
        "No person is available in a dry-run replay. Continue with your best judgement and state any assumption you make.",
      );
    }
    const kind: AgentTaskKind = call.name === "ask_human" ? "clarification" : "gate";
    const data = parsed.data as {
      question?: string;
      title?: string;
      summary?: string;
      assignee_role?: AppRole;
    };
    let assigneeRole: AppRole | null = data.assignee_role ?? null;
    let args: unknown = call.args;
    const subject = (parsed.data as { subject?: GateSubject }).subject;
    let toPrincipal = false;
    let detail = "";
    if (call.name === "request_approval" && subject) {
      const gate = await gateFor(run.orgId, subject);
      if ("error" in gate) return toolError(gate.error);
      if (run.mode === "replay") {
        return simulated(run, call, seq, "Approval simulated as granted; nothing was changed.", {
          gate: gate.role,
        });
      }
      assigneeRole = gate.role;
      toPrincipal = gate.toPrincipal ?? false;
      detail = gate.detail ?? "";
      args = {
        ...(call.args as object),
        subject: gate.subject ?? { ...subject, expects: gate.status },
      };
    }
    const taskId = await openTask(run, {
      kind,
      title: data.title ?? "The agent has a question",
      body: [data.summary ?? data.question ?? "", detail].filter(Boolean).join("\n\n"),
      assigneeRole,
      proposedAction: { toolCallId: call.id, name: call.name, args },
      ...(toPrincipal ? { assigneeUserId: run.principalUserId } : {}),
    });
    await recordStep(run, seq, {
      kind: "tool",
      toolName: call.name,
      toolCallId: call.id,
      status: "awaiting",
      input: redactArgs(call.args),
      output: { taskId },
    });
    return { kind: "pending", taskId };
  }

  const tool = allowed.has(call.name) ? getTool(call.name) : undefined;
  if (!tool) return toolError(`Unknown tool: ${call.name}`);
  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.message}`);

  const verdict = decideToolCall(tool.risk, policy, tool.templateOf?.(parsed.data) ?? null);
  if (run.mode === "replay" && tool.risk !== "read") {
    return simulated(
      run,
      call,
      seq,
      `${tool.name} was not executed (simulated success). In a live run it would ${verdict === "run" ? "run now" : "wait for a person's approval"}.`,
      { args: redactArgs(parsed.data), wouldRun: verdict === "run" },
    );
  }
  if (verdict === "approve") {
    const taskId = await openTask(run, {
      kind: "approval",
      title: tool.describe?.(parsed.data) ?? `Allow the agent to run ${tool.name}`,
      body: "",
      assigneeRole: null,
      proposedAction: { toolCallId: call.id, name: call.name, args: parsed.data },
    });
    await recordStep(run, seq, {
      kind: "tool",
      toolName: call.name,
      toolCallId: call.id,
      status: "awaiting",
      input: redactArgs(parsed.data),
      output: { taskId },
    });
    return { kind: "pending", taskId };
  }

  // act_and_notify: the action runs now and the person the agent works for is told.
  const notify = tool.risk !== "read" && policy.autonomy === "act_and_notify";
  return {
    kind: "message",
    message: await execute(run, ctx, tool.name, call, parsed.data, seq, notify),
  };
}

/** Dry-run replay: record a step the live run would have taken and tell the model it "happened". */
async function simulated(
  run: AgentRun,
  call: AgentToolCall,
  seq: number,
  message: string,
  output: Record<string, unknown> = {},
): Promise<CallOutcome> {
  await recordStep(run, seq, {
    kind: "tool",
    toolName: call.name,
    toolCallId: call.id,
    status: "simulated",
    input: redactArgs(call.args),
    output,
  });
  return {
    kind: "message",
    message: {
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: `[Dry-run replay] ${message}`,
    },
  };
}

/** Run an allowed tool and turn its result (or failure) into a tool message. */
async function execute(
  run: AgentRun,
  ctx: ToolContext,
  name: string,
  call: AgentToolCall,
  args: unknown,
  seq: number,
  notify = false,
): Promise<AgentMessage> {
  const tool = getTool(name)!;
  const started = Date.now();
  try {
    const result = await tool.run(ctx, args);
    const raw = typeof result === "string" ? result : JSON.stringify(result ?? null);
    const content = tool.untrustedOutput ? untrusted(`${name} result`, raw) : raw;
    const injection = Boolean(tool.untrustedOutput) && looksLikeInjection(raw);
    await recordStep(run, seq, {
      kind: "tool",
      toolName: name,
      toolCallId: call.id,
      status: "ok",
      input: redactArgs(args),
      output: tool.untrustedOutput ? { chars: raw.length } : { preview: preview(raw) },
      durationMs: Date.now() - started,
      ...(notify ? { notifyState: "pending" as const } : {}),
      injectionSuspected: injection,
    });
    if (injection) {
      log.warn("agent.injection.suspected", {
        trace_id: run.traceId,
        run_id: run.id,
        org_id: run.orgId,
        agent: run.agentType,
        tool: name,
      });
      await writeAudit({
        actor: ctx.actor,
        actorUserId: ctx.principalUserId,
        orgId: ctx.orgId,
        action: "agent.injection.suspected",
        entityType: "agent_run",
        entityId: ctx.runId,
        detail: { tool: name, seq },
      });
    }
    if (tool.risk !== "read") {
      await writeAudit({
        actor: ctx.actor,
        actorUserId: ctx.principalUserId,
        orgId: ctx.orgId,
        action: `agent.tool.${name}`,
        entityType: "agent_run",
        entityId: ctx.runId,
        detail: { on_behalf_of: ctx.principalUserId, risk: tool.risk },
      });
    }
    return { role: "tool", toolCallId: call.id, name, content };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The tool failed.";
    log.warn("agent.tool.error", {
      trace_id: run.traceId,
      run_id: run.id,
      org_id: run.orgId,
      agent: run.agentType,
      tool: name,
      error: message,
    });
    await recordStep(run, seq, {
      kind: "tool",
      toolName: name,
      toolCallId: call.id,
      status: "error",
      input: redactArgs(args),
      output: { error: preview(message) },
      durationMs: Date.now() - started,
    });
    return { role: "tool", toolCallId: call.id, name, content: message, isError: true };
  }
}

async function applyDecision(
  ctx: ToolContext,
  task: typeof agentTasks.$inferSelect | undefined,
  call: AgentToolCall,
  seq: number,
): Promise<AgentMessage> {
  const reply = (content: string, isError = false): AgentMessage => ({
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content,
    ...(isError ? { isError } : {}),
  });
  if (!task) return reply("The decision for this request could not be found.", true);
  const response = (task.response ?? {}) as Record<string, unknown>;
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, ctx.runId)).limit(1);

  if (task.status === "answered") return reply(String(response["answer"] ?? ""));
  if (task.status === "rejected") {
    const reason = response["reason"] ? ` Reason: ${String(response["reason"])}` : "";
    return reply(`A person declined this request.${reason}`, true);
  }
  if (task.status !== "approved") return reply("This request was cancelled.", true);

  // Gate approvals carry no tool to run — the human acted in the app.
  if (isHitl(call.name)) {
    const comment = response["comment"] ? ` Comment: ${String(response["comment"])}` : "";
    return reply(`Approved.${comment}`);
  }
  // An approved tool call runs with the (possibly edited) arguments, re-validated.
  const tool = getTool(call.name);
  if (!tool || !run) return reply(`Unknown tool: ${call.name}`, true);
  const edited = response["args"] !== undefined ? response["args"] : call.args;
  const parsed = tool.input.safeParse(edited);
  if (!parsed.success)
    return reply(`The approved arguments are invalid: ${parsed.error.message}`, true);
  return execute(run, ctx, tool.name, call, parsed.data, seq);
}

async function openTask(
  run: AgentRun,
  t: {
    kind: AgentTaskKind;
    title: string;
    body: string;
    assigneeRole: AppRole | null;
    proposedAction: unknown;
    assigneeUserId?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(agentTasks)
    .values({
      orgId: run.orgId,
      runId: run.id,
      kind: t.kind,
      title: t.title.slice(0, 200),
      body: t.body.slice(0, 8000),
      assigneeRole: t.assigneeRole,
      // Action approvals default to the person the agent works for.
      assigneeUserId: t.assigneeUserId ?? (t.kind === "approval" ? run.principalUserId : null),
      proposedAction: t.proposedAction as never,
    })
    .returning({ id: agentTasks.id });
  if (run.conversationId) {
    try {
      const { onTaskOpened } = await import("../desk/desk.server");
      await onTaskOpened(run, { id: row!.id, kind: t.kind, title: t.title, body: t.body });
    } catch (e) {
      log.warn("desk.post_failed", { run_id: run.id, error: e as Error });
    }
  }
  return row!.id;
}

async function nextSeq(runId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${agentSteps.seq}), 0)` })
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId));
  return Number(row?.max ?? 0) + 1;
}

async function recordStep(
  run: AgentRun,
  seq: number,
  s: {
    kind: string;
    status: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    promptTokens?: number;
    completionTokens?: number;
    durationMs?: number;
    notifyState?: "pending";
    injectionSuspected?: boolean;
  },
) {
  await db.insert(agentSteps).values({
    runId: run.id,
    orgId: run.orgId,
    seq,
    kind: s.kind,
    status: s.status,
    toolName: s.toolName ?? null,
    toolCallId: s.toolCallId ?? null,
    input: (s.input ?? null) as never,
    output: (s.output ?? null) as never,
    promptTokens: s.promptTokens ?? 0,
    completionTokens: s.completionTokens ?? 0,
    durationMs: s.durationMs ?? 0,
    notifyState: s.notifyState ?? null,
    injectionSuspected: s.injectionSuspected ?? false,
  });
}

async function save(
  run: AgentRun,
  transcript: AgentMessage[],
  pending: PendingCall[] | null,
  stepCount: number,
  tokensUsed: number,
) {
  await db
    .update(agentRuns)
    .set({
      transcript: transcript as never,
      pending: pending as never,
      stepCount,
      tokensUsed,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id));
}

async function finish(
  run: AgentRun,
  status: "done" | "failed",
  result: string | null,
  error: string | null,
) {
  const now = new Date();
  await db
    .update(agentRuns)
    .set({ status, result, lastError: error, leaseUntil: null, finishedAt: now, updatedAt: now })
    .where(eq(agentRuns.id, run.id));
  await writeAudit({
    actor: `agent:${run.agentType}:${run.id}`,
    actorUserId: run.principalUserId,
    orgId: run.orgId,
    action: status === "done" ? "agent.run.completed" : "agent.run.failed",
    entityType: "agent_run",
    entityId: run.id,
    detail: {
      on_behalf_of: run.principalUserId,
      definition_hash: run.definitionHash,
      mode: run.mode,
      handed_off: Boolean(result?.startsWith("Handed off:")),
      error: error ? error.slice(0, 300) : null,
    },
  });
  if (run.conversationId) {
    try {
      const { onRunFinished } = await import("../desk/desk.server");
      await onRunFinished({ ...run, status, result, error });
    } catch (e) {
      log.warn("desk.post_failed", { run_id: run.id, error: e as Error });
    }
  }
}

export const BUDGET_PAUSE_MESSAGE = "Paused: this agent reached its monthly token budget.";

/** Month-to-date tokens of this org's agent, from the AI ledger (incl. AI inside tools). */
export async function monthTokens(orgId: string, agentType: string): Promise<number> {
  const { aiUsageEvents } = await import("@db/schema");
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::bigint` })
    .from(aiUsageEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, aiUsageEvents.agentRunId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentType, agentType as never),
        sql`${aiUsageEvents.createdAt} >= date_trunc('month', now())`,
      ),
    );
  return Number(r?.n ?? 0);
}

async function overBudget(run: AgentRun, budget: number | null): Promise<boolean> {
  if (budget == null) return false;
  return (await monthTokens(run.orgId, run.agentType)) >= budget;
}

/** Park the run (re-checked hourly; the budget resets with the month) and record it once. */
async function pauseForBudget(run: AgentRun) {
  const firstTime = run.lastError !== BUDGET_PAUSE_MESSAGE;
  await db
    .update(agentRuns)
    .set({
      status: "queued",
      lastError: BUDGET_PAUSE_MESSAGE,
      leaseUntil: new Date(Date.now() + 60 * 60_000),
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id));
  if (firstTime) {
    log.warn("agent.run.budget_paused", {
      run_id: run.id,
      org_id: run.orgId,
      agent: run.agentType,
    });
    await writeAudit({
      actor: `agent:${run.agentType}:${run.id}`,
      actorUserId: run.principalUserId,
      orgId: run.orgId,
      action: "agent.run.budget_paused",
      entityType: "agent_run",
      entityId: run.id,
    });
  }
}

function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Tool args are agent-authored but may quote candidate text; keep them short. */
function redactArgs(args: unknown): unknown {
  const raw = JSON.stringify(args ?? null);
  return raw.length > 2000 ? { truncated: preview(raw) } : args;
}
