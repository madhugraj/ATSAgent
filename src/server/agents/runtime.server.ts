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
  type AgentTaskKind,
  type AgentType,
} from "@db/schema";
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

type AgentRun = typeof agentRuns.$inferSelect;
type PendingCall = { taskId: string; call: AgentToolCall };

const ROLES = [
  "recruiter",
  "hiring_manager",
  "department_head",
  "hr_head",
  "president_cbo",
] as const;

/* ------------------------------------------------------------ HITL tools */

const HITL_TOOLS = {
  ask_human: {
    description:
      "Ask a person a clarifying question when you cannot proceed safely without their answer. The run pauses until they reply.",
    input: z.object({
      question: z.string().min(1).max(2000),
      assignee_role: z.enum(ROLES).optional(),
    }),
  },
  request_approval: {
    description:
      "Ask the responsible approver for a decision that only a person may make (requisition, JD or offer approval, offer release, rejection, hiring decision). Explain what you prepared and why. The run pauses until they decide.",
    input: z.object({
      title: z.string().min(1).max(200),
      summary: z.string().min(1).max(4000),
      assignee_role: z.enum(ROLES),
    }),
  },
  handoff: {
    description:
      "Stop and hand the work back to a person when the task is outside what you can do. Give the reason.",
    input: z.object({ reason: z.string().min(1).max(2000) }),
  },
} as const;
type HitlName = keyof typeof HITL_TOOLS;
const isHitl = (name: string): name is HitlName => name in HITL_TOOLS;

const RUNTIME_RULES = [
  "Operating rules:",
  "- You act on behalf of the person who started this run and can only use the tools provided.",
  "- Never claim an action happened unless a tool result confirms it.",
  "- Approvals of requisitions, JDs and offers, offer release, rejecting a candidate and the hiring decision belong to people: use request_approval, never work around it.",
  "- If an action is declined, do not retry it unchanged; adapt or hand off.",
  "- When the goal is complete, reply with a short summary and no tool calls.",
].join("\n");

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
}): Promise<{ runId: string }> {
  const def = getAgent(input.agentType);
  if (!def) throw new Error(`Unknown agent: ${input.agentType}`);
  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId: input.orgId,
      agentType: input.agentType,
      principalUserId: input.principalUserId,
      goal: input.goal,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      triggerEventId: input.triggerEventId ?? null,
      maxSteps: input.maxSteps ?? def.maxSteps ?? 20,
      transcript: [{ role: "user", content: input.goal } satisfies AgentMessage],
    })
    .returning({ id: agentRuns.id });
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

  const [stillOpen] = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(eq(agentTasks.runId, task.runId), eq(agentTasks.status, "open")))
    .limit(1);
  if (!stillOpen) {
    await db
      .update(agentRuns)
      .set({ status: "queued", updatedAt: now })
      .where(and(eq(agentRuns.id, task.runId), eq(agentRuns.status, "awaiting_human")));
  }
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
    reclaimed: 0,
    claimed: 0,
    done: 0,
    awaiting: 0,
    yielded: 0,
    failed: 0,
  };
  const now = new Date();

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

  // 2. Claim queued runs (skip paused orgs/agents), disjoint across workers.
  const paused = db
    .select({ one: sql`1` })
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.orgId, agentRuns.orgId),
        eq(agentPolicies.enabled, false),
        sql`${agentPolicies.agentType} in ('*', ${agentRuns.agentType})`,
      ),
    );
  const dueIds = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "queued"),
        sql`not exists (${paused})`,
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
      const outcome = await driveRun(run).catch(async (e: unknown) => {
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
  if (counts.claimed || counts.reclaimed) log.info("agent.tick", counts);
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

  for (let turn = 0; turn < TURNS_PER_TICK; turn++) {
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
    const kind: AgentTaskKind = call.name === "ask_human" ? "clarification" : "gate";
    const data = parsed.data as {
      question?: string;
      title?: string;
      summary?: string;
      assignee_role?: AppRole;
    };
    const taskId = await openTask(run, {
      kind,
      title: data.title ?? "The agent has a question",
      body: data.summary ?? data.question ?? "",
      assigneeRole: data.assignee_role ?? null,
      proposedAction: { toolCallId: call.id, name: call.name, args: call.args },
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

  return { kind: "message", message: await execute(run, ctx, tool.name, call, parsed.data, seq) };
}

/** Run an allowed tool and turn its result (or failure) into a tool message. */
async function execute(
  run: AgentRun,
  ctx: ToolContext,
  name: string,
  call: AgentToolCall,
  args: unknown,
  seq: number,
): Promise<AgentMessage> {
  const tool = getTool(name)!;
  const started = Date.now();
  try {
    const result = await tool.run(ctx, args);
    const raw = typeof result === "string" ? result : JSON.stringify(result ?? null);
    const content = tool.untrustedOutput ? untrusted(`${name} result`, raw) : raw;
    await recordStep(run, seq, {
      kind: "tool",
      toolName: name,
      toolCallId: call.id,
      status: "ok",
      input: redactArgs(args),
      output: tool.untrustedOutput ? { chars: raw.length } : { preview: preview(raw) },
      durationMs: Date.now() - started,
    });
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
  },
): Promise<string> {
  const [row] = await db
    .insert(agentTasks)
    .values({
      orgId: run.orgId,
      runId: run.id,
      kind: t.kind,
      title: t.title.slice(0, 200),
      body: t.body.slice(0, 4000),
      assigneeRole: t.assigneeRole,
      // Action approvals default to the person the agent works for.
      assigneeUserId: t.kind === "approval" ? run.principalUserId : null,
      proposedAction: t.proposedAction as never,
    })
    .returning({ id: agentTasks.id });
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
}

function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Tool args are agent-authored but may quote candidate text; keep them short. */
function redactArgs(args: unknown): unknown {
  const raw = JSON.stringify(args ?? null);
  return raw.length > 2000 ? { truncated: preview(raw) } : args;
}
