/**
 * Agent eval harness (docs/agentic-plan.md §11).
 *
 * A scenario gives an agent a goal, fake tools and a script for how "people"
 * answer its requests, then runs it through the real runtime in a throwaway
 * organisation and checks what happened: which tools it called, whether it
 * stayed behind the human gates, how it finished, and what it cost.
 *
 * The same scenario runs against a scripted model (CI) or a live model
 * (scripts/agent-eval.ts with EVAL_PROVIDER / EVAL_API_KEY / EVAL_MODEL).
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import {
  agentPolicies,
  agentRuns,
  agentSteps,
  agentTasks,
  orgMembers,
  organizations,
  users,
  type AgentAutonomy,
} from "@db/schema";
import { registerAgent, registerTool, type AgentDefinition, type AgentTool } from "./registry";
import { resolveTask, runAgentTick, startRun, type TaskDecision } from "./runtime.server";

export type EvalTask = {
  kind: "gate" | "approval" | "clarification";
  title: string;
  body: string;
  action: { name: string; args: unknown } | null;
};

export type Scenario = {
  name: string;
  agent: AgentDefinition;
  tools: AgentTool<never>[];
  goal: string;
  autonomy?: AgentAutonomy;
  /** How the simulated people respond to each request the agent raises. */
  decide?: (task: EvalTask) => TaskDecision;
  expect: {
    status?: "done" | "failed" | "awaiting_human";
    /** These tools must be called, in this relative order. */
    calls?: string[];
    /** These tools must never be called. */
    neverCalls?: string[];
    /** Every request for a human decision must use request_approval with this role. */
    gateRole?: string;
    /** The final summary must contain these phrases (case-insensitive). */
    resultIncludes?: string[];
    maxSteps?: number;
  };
};

export type EvalReport = {
  name: string;
  passed: boolean;
  failures: string[];
  status: string;
  calls: string[];
  steps: number;
  tokens: number;
  humanRequests: number;
  result: string | null;
};

const MAX_TICKS = 12;

export async function runScenario(s: Scenario): Promise<EvalReport> {
  for (const t of s.tools) registerTool(t);
  registerAgent(s.agent);

  // Throwaway tenant: an owner principal so role checks pass for any gate.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `eval-${stamp}@eval.local` })
    .returning({ id: users.id });
  const [org] = await db
    .insert(organizations)
    .values({ name: `Eval ${s.name}`, slug: `eval-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  const orgId = org!.id;
  const userId = user!.id;
  try {
    await db.insert(orgMembers).values({
      orgId,
      userId,
      email: `eval-${stamp}@eval.local`,
      status: "active",
      isOwner: true,
      joinedAt: new Date(),
    });
    // Agents are opt-in: switch the scenario's agent on.
    await db.insert(agentPolicies).values({
      orgId,
      agentType: s.agent.type,
      enabled: true,
      autonomy: s.autonomy ?? "suggest",
    });

    const { runId } = await startRun({
      orgId,
      agentType: s.agent.type,
      principalUserId: userId,
      goal: s.goal,
      maxSteps: s.agent.maxSteps ?? 20,
    });

    let humanRequests = 0;
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      await runAgentTick({ max: 1, orgId });
      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
      if (!run || run.status === "done" || run.status === "failed") break;
      if (run.status !== "awaiting_human") continue;
      const open = await db
        .select()
        .from(agentTasks)
        .where(and(eq(agentTasks.runId, runId), eq(agentTasks.status, "open")));
      if (!s.decide) break;
      for (const t of open) {
        humanRequests++;
        const a = t.proposedAction as { name?: string; args?: unknown } | null;
        const decision = s.decide({
          kind: t.kind,
          title: t.title,
          body: t.body,
          action: a?.name ? { name: a.name, args: a.args ?? {} } : null,
        });
        await resolveTask({ orgId, taskId: t.id, userId, decision });
      }
    }

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    const steps = await db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, runId))
      .orderBy(agentSteps.seq);
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.runId, runId));
    const calls = steps.filter((x) => x.kind === "tool" && x.toolName).map((x) => x.toolName!);

    const failures: string[] = [];
    const e = s.expect;
    if (e.status && run?.status !== e.status) {
      failures.push(`status: expected ${e.status}, got ${run?.status}`);
    }
    if (e.calls) {
      let i = 0;
      for (const c of calls) if (c === e.calls[i]) i++;
      if (i < e.calls.length) {
        failures.push(
          `calls: expected ${e.calls.join(" → ")} in order, got ${calls.join(" → ") || "none"}`,
        );
      }
    }
    for (const n of e.neverCalls ?? []) {
      if (calls.includes(n)) failures.push(`called forbidden tool ${n}`);
    }
    if (e.gateRole) {
      const gates = tasks.filter((t) => t.kind === "gate");
      if (!gates.length) failures.push("no request_approval was raised");
      for (const g of gates) {
        if (g.assigneeRole !== e.gateRole) {
          failures.push(`gate routed to ${g.assigneeRole}, expected ${e.gateRole}`);
        }
      }
    }
    for (const phrase of e.resultIncludes ?? []) {
      if (!(run?.result ?? "").toLowerCase().includes(phrase.toLowerCase())) {
        failures.push(`result missing "${phrase}"`);
      }
    }
    if (e.maxSteps && (run?.stepCount ?? 0) > e.maxSteps) {
      failures.push(`used ${run?.stepCount} model steps, budget ${e.maxSteps}`);
    }

    return {
      name: s.name,
      passed: failures.length === 0,
      failures,
      status: run?.status ?? "missing",
      calls,
      steps: run?.stepCount ?? 0,
      tokens: run?.tokensUsed ?? 0,
      humanRequests,
      result: run?.result ?? null,
    };
  } finally {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(inArray(users.id, [userId]));
  }
}
