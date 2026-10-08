/**
 * Hiring desk server functions (docs/agentic-plan.md §13.2). A thread is
 * visible to the person who started it and to HR leadership (HR head, CBO,
 * owner); every query is predicated on the organisation.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { hiringConversations, hiringMessages, requisitions, userRoles } from "@db/schema";
import { requireOrg } from "./auth.middleware";

const LEADERSHIP = ["hr_head", "president_cbo"] as const;

async function isLeadership(userId: string, orgId: string, isOwner: boolean) {
  if (isOwner) return true;
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.orgId, orgId),
        inArray(userRoles.role, [...LEADERSHIP]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function accessible(ctx: { orgId: string; userId: string; isOwner: boolean }, id: string) {
  const { loadConversation } = await import("../server/desk/desk.server");
  const conv = await loadConversation(ctx.orgId, id);
  if (conv.createdBy !== ctx.userId && !(await isLeadership(ctx.userId, ctx.orgId, ctx.isOwner)))
    throw new Error("Conversation not found.");
  return conv;
}

async function needsAiKey(orgId: string) {
  const { resolveAiConfig } = await import("./ai-gateway.server");
  const cfg = await resolveAiConfig(orgId);
  if (!cfg.apiKey)
    throw new Error("Add your organisation's AI model key on the Integrations page first.");
}

async function registered() {
  const { ensureAgentsRegistered } = await import("../server/agents");
  ensureAgentsRegistered();
}

export type DeskConversationSummary = {
  id: string;
  title: string;
  status: string;
  requisitionCode: string | null;
  updatedAt: string;
  mine: boolean;
};

export const listDeskConversations = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<DeskConversationSummary[]> => {
    const all = await isLeadership(context.userId, context.orgId, context.isOwner);
    const rows = await db
      .select({
        id: hiringConversations.id,
        title: hiringConversations.title,
        status: hiringConversations.status,
        createdBy: hiringConversations.createdBy,
        updatedAt: hiringConversations.updatedAt,
        code: requisitions.code,
      })
      .from(hiringConversations)
      .leftJoin(
        requisitions,
        and(
          eq(requisitions.id, hiringConversations.requisitionId),
          eq(requisitions.orgId, context.orgId),
        ),
      )
      .where(
        and(
          eq(hiringConversations.orgId, context.orgId),
          all ? undefined : eq(hiringConversations.createdBy, context.userId),
        ),
      )
      .orderBy(desc(hiringConversations.updatedAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      requisitionCode: r.code ?? null,
      updatedAt: r.updatedAt.toISOString(),
      mine: r.createdBy === context.userId,
    }));
  });

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type DeskCardView = { type: string; [k: string]: Json };

export type DeskMessageView = {
  id: string;
  role: "user" | "desk" | "agent";
  agentType: string | null;
  body: string;
  card: DeskCardView | null;
  at: string;
};

export type DeskConversationView = {
  id: string;
  title: string;
  status: string;
  slots: import("../server/desk/desk.server").DeskSlots;
  requisition: { id: string; code: string; status: string } | null;
  messages: DeskMessageView[];
  /** Current status of every agent request shown in the thread. */
  tasks: Record<string, string>;
  /** Whether the viewer may decide each request, and who it waits for otherwise. */
  deciders: Record<string, { canDecide: boolean; waitingFor: string | null }>;
  /** What each approval request would do, as label / value lines. */
  taskDetails: Record<string, { label: string; value: string }[]>;
  /** Why each ranked candidate scored as they did (live from their match score). */
  reasoning: Record<string, import("../server/desk/desk.server").CandidateReasoning>;
  /** Where the hire stands and what happens next. */
  progress: import("../server/desk/desk.server").DeskProgress;
  /** The agent working for this thread right now, with its latest steps. */
  activity: import("../server/desk/desk.server").DeskActivity;
  /** The current step can be started now (its agent is on and idle). */
  canStart: boolean;
  /** The viewer may change agent settings (budget, autonomy) — HR head / CBO / owner. */
  canEditAgents: boolean;
};

export const getDeskConversation = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<DeskConversationView> => {
    let conv = await accessible(context, data.id);
    // Self-heal: the role ended (closed / rejected elsewhere, perhaps before this
    // thread followed it) but the thread did not — sync it now.
    if (conv.requisitionId && conv.status !== "closed") {
      const [r] = await db
        .select({ status: requisitions.status })
        .from(requisitions)
        .where(and(eq(requisitions.id, conv.requisitionId), eq(requisitions.orgId, context.orgId)))
        .limit(1);
      if (r && (r.status === "closed" || r.status === "rejected")) {
        const { onRequisitionEnded } = await import("../server/desk/desk.server");
        await onRequisitionEnded(context.orgId, conv.requisitionId, r.status, null);
        conv = await accessible(context, data.id);
      }
    }
    const msgs = await db
      .select()
      .from(hiringMessages)
      .where(
        and(eq(hiringMessages.conversationId, conv.id), eq(hiringMessages.orgId, context.orgId)),
      )
      .orderBy(asc(hiringMessages.createdAt))
      .limit(500);
    const [req] = conv.requisitionId
      ? await db
          .select({ id: requisitions.id, code: requisitions.code, status: requisitions.status })
          .from(requisitions)
          .where(
            and(eq(requisitions.id, conv.requisitionId), eq(requisitions.orgId, context.orgId)),
          )
          .limit(1)
      : [];
    const taskIds = msgs
      .map((m) => (m.card as { type?: string; taskId?: string } | null)?.taskId)
      .filter((x): x is string => typeof x === "string");
    const {
      taskStatuses,
      taskDetails,
      deskProgress,
      deskActivity,
      startStage,
      candidateReasoning,
    } = await import("../server/desk/desk.server");
    const rankedIds = msgs.flatMap((m) => {
      const c = m.card as { type?: string; items?: { applicationId?: string }[] } | null;
      return c?.type === "ranked_candidates"
        ? (c.items ?? [])
            .map((i) => i.applicationId)
            .filter((x): x is string => typeof x === "string")
        : [];
    });
    return {
      id: conv.id,
      title: conv.title,
      status: conv.status,
      slots: conv.slots as import("../server/desk/desk.server").DeskSlots,
      requisition: req ?? null,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        agentType: m.agentType,
        body: m.body,
        card: (m.card as DeskMessageView["card"]) ?? null,
        at: m.createdAt.toISOString(),
      })),
      tasks: await taskStatuses(context.orgId, taskIds),
      taskDetails: await taskDetails(context.orgId, taskIds),
      deciders: await (
        await import("../server/desk/desk.server")
      ).taskDeciders(context.orgId, context.userId, context.isOwner, taskIds),
      reasoning: await candidateReasoning(context.orgId, [...new Set(rankedIds)]),
      progress: await deskProgress(conv),
      activity: await deskActivity(conv),
      canStart: Boolean(await startStage(conv, context.userId, { dryRun: true })),
      canEditAgents: await canEditAgents(context.userId, context.orgId),
    };
  });

const Text = z.string().trim().min(1).max(2000);

export const startDeskConversation = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ message: Text }).parse(d))
  .handler(async ({ data, context }) => {
    await needsAiKey(context.orgId);
    await registered();
    const [conv] = await db
      .insert(hiringConversations)
      .values({ orgId: context.orgId, createdBy: context.userId })
      .returning();
    const { handleUserMessage } = await import("../server/desk/desk.server");
    await handleUserMessage(conv!, context.userId, data.message);
    return { id: conv!.id };
  });

export const sendDeskMessage = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), message: Text }).parse(d))
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await needsAiKey(context.orgId);
    await registered();
    const { handleUserMessage } = await import("../server/desk/desk.server");
    await handleUserMessage(conv, context.userId, data.message);
    return { ok: true as const };
  });

const Choice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), requisitionId: z.string().uuid() }),
  z.object({ kind: z.literal("new"), reuseJdFrom: z.string().uuid().nullable().optional() }),
]);

export const chooseDeskRole = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), choice: Choice }).parse(d))
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    if (conv.status !== "confirming") throw new Error("The role has already been settled.");
    await registered();
    const desk = await import("../server/desk/desk.server");
    const { assertRequisitionInOrg } = await import("../server/guards");
    if (data.choice.kind === "existing") {
      await assertRequisitionInOrg(data.choice.requisitionId, context.orgId);
      await desk.continueWithRole(conv, context.userId, data.choice.requisitionId);
    } else {
      if (data.choice.reuseJdFrom)
        await assertRequisitionInOrg(data.choice.reuseJdFrom, context.orgId);
      await desk.createNewRole(conv, context.userId, {
        reuseJdFrom: data.choice.reuseJdFrom ?? null,
      });
    }
    return { ok: true as const };
  });

export const screenDeskCandidates = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        applicationIds: z.array(z.string().uuid()).min(1).max(20),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await registered();
    const { screenCandidates } = await import("../server/desk/desk.server");
    const n = await screenCandidates(conv, context.userId, data.applicationIds);
    return { screening: n };
  });

export const closeDeskConversation = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await db
      .update(hiringConversations)
      .set({ status: "closed", updatedAt: new Date() })
      .where(
        and(eq(hiringConversations.id, conv.id), eq(hiringConversations.orgId, context.orgId)),
      );
    return { ok: true as const };
  });

/** Run a stopped agent of this thread again (same goal and role). */
export const retryDeskRun = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), runId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await registered();
    const { retryRun } = await import("../server/desk/desk.server");
    return { runId: await retryRun(conv, context.userId, data.runId) };
  });

/** Start the agent for the thread's current step (when it is on and idle). */
export const startDeskStage = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await registered();
    const { startStage } = await import("../server/desk/desk.server");
    const runId = await startStage(conv, context.userId);
    if (!runId) throw new Error("Nothing to start for this step right now.");
    return { runId };
  });

/** Score the role's new applications (e.g. CVs just uploaded here) and post the ranked list. */
export const scoreDeskCandidates = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await needsAiKey(context.orgId);
    const { scoreAndRank } = await import("../server/desk/desk.server");
    return { scored: await scoreAndRank(conv, context.userId) };
  });

/** Ask the Publishing agent to post the thread's role. */
export const publishDeskRole = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await registered();
    const { publishRole } = await import("../server/desk/desk.server");
    return { runId: await publishRole(conv, context.userId) };
  });

/** Close / reject / delete the thread's role from the chat (role-checked by the lifecycle). */
export const closeDeskRole = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), reason: z.string().trim().min(3).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    const { closeRole } = await import("../server/desk/desk.server");
    return closeRole(conv, context.userId, data.reason);
  });

/** Accept the desk's latest researched proposal (skills / experience / budget). */
export const acceptDeskProposal = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await needsAiKey(context.orgId);
    const { applyProposal } = await import("../server/desk/desk.server");
    await applyProposal(conv);
    return { ok: true as const };
  });

/** Ask the desk to research details from the market instead of typing them. */
export const researchDeskRole = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        fields: z
          .array(z.enum(["skills", "experience", "budget"]))
          .min(1)
          .max(3),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    await needsAiKey(context.orgId);
    const { researchRole } = await import("../server/desk/desk.server");
    await researchRole(conv, data.fields);
    return { ok: true as const };
  });

const AGENT_SETTINGS_ROLES = ["hr_head", "president_cbo"] as const;

async function canEditAgents(userId: string, orgId: string): Promise<boolean> {
  const { assertRole } = await import("./auth.middleware");
  return assertRole(userId, orgId, [...AGENT_SETTINGS_ROLES]).then(
    () => true,
    () => false,
  );
}

/**
 * Raise the monthly token budget of the agent this thread is paused on, to
 * the suggested amount, and continue its parked run now. HR head / CBO /
 * owner only (as on Agent settings); audited.
 */
export const raiseDeskAgentBudget = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const conv = await accessible(context, data.id);
    const { assertRole } = await import("./auth.middleware");
    await assertRole(
      context.userId,
      context.orgId,
      [...AGENT_SETTINGS_ROLES],
      "Only the HR head, the CBO or the organisation owner can change an agent's budget.",
    );
    const desk = await import("../server/desk/desk.server");
    const progress = await desk.deskProgress(conv);
    const agentType = progress.next?.agentType;
    if (!agentType || !progress.next?.run?.paused)
      throw new Error("No agent here is paused on its budget.");
    const { suggested, limit } = await desk.budgetOf(context.orgId, agentType);
    const { agentPolicies } = await import("@db/schema");
    await db
      .update(agentPolicies)
      .set({ monthlyTokenBudget: suggested, updatedBy: context.userId, updatedAt: new Date() })
      .where(
        and(
          eq(agentPolicies.orgId, context.orgId),
          eq(agentPolicies.agentType, agentType as never),
        ),
      );
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "agent.policy.updated",
      entityType: "agent_policy",
      entityId: null,
      detail: { agentType, monthlyTokenBudget: suggested, previous: limit, via: "hiring_desk" },
    });
    const { releaseBudgetPaused } = await import("../server/agents/runtime.server");
    await releaseBudgetPaused(context.orgId, agentType);
    const { kickAgents } = await import("../server/agents/orchestrator.server");
    kickAgents(context.orgId);
    return { monthlyTokenBudget: suggested };
  });
