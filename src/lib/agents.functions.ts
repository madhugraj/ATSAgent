/**
 * Agent server functions: the Decisions inbox, recent runs, and per-org agent
 * settings (docs/agentic-plan.md §5, §8). Reads are org-scoped; settings are
 * HR-head / CBO (owner passes); decisions are checked against each task's
 * role or assignee by the runtime.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { agentPolicies, agentRuns, agentTasks, userRoles } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { AGENT_CATALOG, WHITELISTABLE_TEMPLATES } from "./agents.catalog";

const AGENT_TYPES = AGENT_CATALOG.map((a) => a.type) as [string, ...string[]];
const ROLES = [
  "recruiter",
  "hiring_manager",
  "department_head",
  "hr_head",
  "president_cbo",
] as const;
const SETTINGS_ROLES = ["hr_head", "president_cbo"] as const;

/** Errors the runtime itself writes; anything else (provider text) is not shown. */
const SAFE_RUN_ERRORS = new Set([
  "The run reached its step or token budget.",
  "The worker stopped before finishing this step.",
  "No AI model key saved. Add one on the Integrations page.",
]);
const GENERIC_RUN_ERROR = "The agent could not complete this step.";

const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

async function rolesOf(userId: string, orgId: string) {
  return (
    await db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId)))
  ).map((r) => r.role);
}

/* --------------------------------------------------------- decisions inbox */

export type AgentTaskView = {
  id: string;
  kind: "gate" | "approval" | "clarification";
  title: string;
  body: string;
  agentType: string;
  runId: string;
  goal: string;
  /** Proposed tool call; args as pretty JSON so the reviewer can read and edit them. */
  action: { name: string; argsJson: string } | null;
  assigneeRole: string | null;
  createdAt: string;
};

/** Open agent requests the caller can act on (owner: all of the org's). */
export const listAgentTasks = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<AgentTaskView[]> => {
    const roles = await rolesOf(context.userId, context.orgId);
    const mine = context.isOwner
      ? undefined
      : or(
          eq(agentTasks.assigneeUserId, context.userId),
          roles.length ? inArray(agentTasks.assigneeRole, roles) : undefined,
        );
    const rows = await db
      .select({
        id: agentTasks.id,
        kind: agentTasks.kind,
        title: agentTasks.title,
        body: agentTasks.body,
        proposedAction: agentTasks.proposedAction,
        assigneeRole: agentTasks.assigneeRole,
        createdAt: agentTasks.createdAt,
        runId: agentRuns.id,
        agentType: agentRuns.agentType,
        goal: agentRuns.goal,
      })
      .from(agentTasks)
      .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
      .where(and(eq(agentTasks.orgId, context.orgId), eq(agentTasks.status, "open"), mine))
      .orderBy(agentTasks.createdAt)
      .limit(200);
    return rows.map((r) => {
      const a = r.proposedAction as { name?: string; args?: unknown } | null;
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        agentType: r.agentType,
        runId: r.runId,
        goal: clip(r.goal, 300) ?? "",
        action:
          r.kind === "approval" && a?.name
            ? { name: a.name, argsJson: JSON.stringify(a.args ?? {}, null, 2) }
            : null,
        assigneeRole: r.assigneeRole,
        createdAt: r.createdAt.toISOString(),
      };
    });
  });

const Decision = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("approved"),
    args: z.record(z.string(), z.unknown()).optional(),
    comment: z.string().max(2000).optional(),
  }),
  z.object({ status: z.literal("rejected"), reason: z.string().max(2000).optional() }),
  z.object({ status: z.literal("answered"), answer: z.string().min(1).max(4000) }),
]);

export type AgentDecisionInput = z.infer<typeof Decision>;

export const decideAgentTask = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) =>
    z.object({ taskId: z.string().uuid(), decision: Decision }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { resolveTask } = await import("../server/agents/runtime.server");
    await resolveTask({
      orgId: context.orgId,
      taskId: data.taskId,
      userId: context.userId,
      decision: data.decision,
    });
    return { ok: true as const };
  });

/* ------------------------------------------------------------- recent runs */

export type AgentRunView = {
  id: string;
  agentType: string;
  status: string;
  goal: string;
  result: string | null;
  error: string | null;
  steps: number;
  tokens: number;
  createdAt: string;
  finishedAt: string | null;
};

export const listAgentRuns = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<AgentRunView[]> => {
    const rows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.orgId, context.orgId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(50);
    return rows.map((r) => ({
      id: r.id,
      agentType: r.agentType,
      status: r.status,
      goal: clip(r.goal, 300) ?? "",
      result: clip(r.result, 600),
      error: r.lastError
        ? SAFE_RUN_ERRORS.has(r.lastError)
          ? r.lastError
          : GENERIC_RUN_ERROR
        : null,
      steps: r.stepCount,
      tokens: r.tokensUsed,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  });

export const cancelAgentRun = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ runId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRole } = await import("./auth.middleware");
    const [run] = await db
      .select({ principal: agentRuns.principalUserId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, data.runId), eq(agentRuns.orgId, context.orgId)))
      .limit(1);
    if (!run) throw new Error("Run not found");
    // The person the agent works for may stop it; otherwise HR leadership.
    if (run.principal !== context.userId) {
      await assertRole(context.userId, context.orgId, [...SETTINGS_ROLES]);
    }
    const { cancelRun } = await import("../server/agents/runtime.server");
    await cancelRun({ orgId: context.orgId, runId: data.runId, userId: context.userId });
    return { ok: true as const };
  });

/* ---------------------------------------------------------------- settings */

export type AgentSettingsView = {
  canEdit: boolean;
  allPaused: boolean;
  agents: {
    type: string;
    live: boolean;
    enabled: boolean;
    autonomy: "suggest" | "act_and_notify" | "autonomous";
    whitelistedTemplates: string[];
    monthlyTokenBudget: number | null;
  }[];
};

export const agentSettings = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<AgentSettingsView> => {
    const { isAgentLive } = await import("../server/agents");
    const rows = await db
      .select()
      .from(agentPolicies)
      .where(eq(agentPolicies.orgId, context.orgId));
    const roles = await rolesOf(context.userId, context.orgId);
    const by = new Map(rows.map((r) => [r.agentType, r]));
    return {
      canEdit:
        context.isOwner || roles.some((r) => (SETTINGS_ROLES as readonly string[]).includes(r)),
      allPaused: by.get("*")?.enabled === false,
      agents: AGENT_CATALOG.map((a) => {
        const r = by.get(a.type);
        return {
          type: a.type,
          live: isAgentLive(a.type),
          enabled: r?.enabled ?? true,
          autonomy: r?.autonomy ?? "suggest",
          whitelistedTemplates: r?.whitelistedTemplates ?? [],
          monthlyTokenBudget: r?.monthlyTokenBudget ?? null,
        };
      }),
    };
  });

const PolicyInput = z.object({
  agentType: z.enum(["*", ...AGENT_TYPES]),
  enabled: z.boolean(),
  autonomy: z.enum(["suggest", "act_and_notify", "autonomous"]).optional(),
  whitelistedTemplates: z
    .array(z.enum(WHITELISTABLE_TEMPLATES.map((t) => t.id) as [string, ...string[]]))
    .max(20)
    .optional(),
  monthlyTokenBudget: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});

export type AgentPolicyInput = z.infer<typeof PolicyInput>;

export const saveAgentPolicy = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => PolicyInput.parse(d))
  .handler(async ({ data, context }) => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...SETTINGS_ROLES]);
    const now = new Date();
    const values = {
      enabled: data.enabled,
      ...(data.agentType !== "*" && data.autonomy ? { autonomy: data.autonomy } : {}),
      ...(data.agentType !== "*" && data.whitelistedTemplates
        ? { whitelistedTemplates: data.whitelistedTemplates }
        : {}),
      ...(data.agentType !== "*" && data.monthlyTokenBudget !== undefined
        ? { monthlyTokenBudget: data.monthlyTokenBudget }
        : {}),
      updatedBy: context.userId,
      updatedAt: now,
    };
    await db
      .insert(agentPolicies)
      .values({ orgId: context.orgId, agentType: data.agentType as never, ...values })
      .onConflictDoUpdate({ target: [agentPolicies.orgId, agentPolicies.agentType], set: values });
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "agent.policy.updated",
      entityType: "agent_policy",
      entityId: null,
      detail: data,
    });
    return { ok: true as const };
  });

export { ROLES as AGENT_TASK_ROLES };

/* ----------------------------------------------------- observability views */

export type AgentRunDetail = {
  id: string;
  traceId: string;
  steps: {
    seq: number;
    kind: string;
    tool: string | null;
    status: string;
    detail: string;
    tokens: number;
    durationMs: number;
    at: string;
  }[];
};

/** Run inspector: the step trail of one run (redacted summaries, no provider text). */
export const getAgentRun = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ runId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<AgentRunDetail> => {
    const { agentSteps } = await import("@db/schema");
    const [run] = await db
      .select({ id: agentRuns.id, traceId: agentRuns.traceId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, data.runId), eq(agentRuns.orgId, context.orgId)))
      .limit(1);
    if (!run) throw new Error("Run not found");
    const steps = await db
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, run.id), eq(agentSteps.orgId, context.orgId)))
      .orderBy(agentSteps.seq);
    return {
      id: run.id,
      traceId: run.traceId,
      steps: steps.map((s) => {
        // Model-call failures carry provider text; keep it server-side.
        const output =
          s.kind === "model" && s.status === "error" ? { error: GENERIC_RUN_ERROR } : s.output;
        const detail = JSON.stringify({ input: s.input ?? undefined, output: output ?? undefined });
        return {
          seq: s.seq,
          kind: s.kind,
          tool: s.toolName,
          status: s.status,
          detail: clip(detail === "{}" ? "" : detail, 1200) ?? "",
          tokens: s.promptTokens + s.completionTokens,
          durationMs: s.durationMs,
          at: s.createdAt.toISOString(),
        };
      }),
    };
  });

export type AgentSummary = {
  days: number;
  runsStarted: number;
  runsDone: number;
  runsFailed: number;
  tokens: number;
  toolErrors: number;
  decisions: number;
  approved: number;
  rejected: number;
  edited: number;
  avgWaitMinutes: number | null;
};

/** Org dashboard numbers for the last 30 days, from agent_metrics_daily. */
export const agentSummary = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<AgentSummary> => {
    const { agentMetricsDaily } = await import("@db/schema");
    const { gte, sql } = await import("drizzle-orm");
    const days = 30;
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const [r] = await db
      .select({
        runsStarted: sql<number>`coalesce(sum(${agentMetricsDaily.runsStarted}), 0)::int`,
        runsDone: sql<number>`coalesce(sum(${agentMetricsDaily.runsDone}), 0)::int`,
        runsFailed: sql<number>`coalesce(sum(${agentMetricsDaily.runsFailed}), 0)::int`,
        tokens: sql<number>`coalesce(sum(${agentMetricsDaily.promptTokens} + ${agentMetricsDaily.completionTokens}), 0)::bigint`,
        toolErrors: sql<number>`coalesce(sum(${agentMetricsDaily.toolErrors}), 0)::int`,
        approved: sql<number>`coalesce(sum(${agentMetricsDaily.tasksApproved}), 0)::int`,
        rejected: sql<number>`coalesce(sum(${agentMetricsDaily.tasksRejected}), 0)::int`,
        edited: sql<number>`coalesce(sum(${agentMetricsDaily.tasksEdited}), 0)::int`,
        waitMs: sql<number>`coalesce(sum(${agentMetricsDaily.hitlWaitMsTotal}), 0)::bigint`,
      })
      .from(agentMetricsDaily)
      .where(and(eq(agentMetricsDaily.orgId, context.orgId), gte(agentMetricsDaily.day, since)));
    const decisions = Number(r?.approved ?? 0) + Number(r?.rejected ?? 0);
    return {
      days,
      runsStarted: Number(r?.runsStarted ?? 0),
      runsDone: Number(r?.runsDone ?? 0),
      runsFailed: Number(r?.runsFailed ?? 0),
      tokens: Number(r?.tokens ?? 0),
      toolErrors: Number(r?.toolErrors ?? 0),
      decisions,
      approved: Number(r?.approved ?? 0),
      rejected: Number(r?.rejected ?? 0),
      edited: Number(r?.edited ?? 0),
      avgWaitMinutes: decisions ? Math.round(Number(r?.waitMs ?? 0) / decisions / 60000) : null,
    };
  });
