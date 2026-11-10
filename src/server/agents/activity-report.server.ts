/**
 * Row-level agent activity for the downloadable reports (Agent intelligence
 * and Agent governance): every run in the window with what started it, its
 * outcome, steps, tokens, failed tool calls and approvals; every event with
 * its publisher; and a per-day, per-agent activity series. Org-scoped,
 * deterministic. Run errors are reported only as the runtime's fixed
 * messages — anything else is provider text and never leaves the server.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";

import { db } from "../db";
import { agentEvents, agentRuns, agentSteps, agentTasks } from "@db/schema";
import type { ModalityFilter } from "../../lib/agent-modality";
import { modalityWhere } from "./modality.server";
import { CEILING_MESSAGE, LEG_LIMIT_MESSAGE, OLD_LIMIT_MESSAGE } from "./run-messages";

export type ActivityRun = {
  id: string;
  agent: string;
  status: string;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
  durationMin: number | null;
  steps: number;
  tokens: number;
  failedCalls: number;
  approvals: number;
  declined: number;
  definitionVersion: string;
  error: string;
};
export type ActivityEvent = {
  type: string;
  status: string;
  attempts: number;
  publishedBy: string;
  startedAgents: string;
  createdAt: string;
};
export type ActivityDay = {
  day: string;
  agent: string;
  runs: number;
  failed: number;
  steps: number;
  tokens: number;
};
export type ActivityReport = { runs: ActivityRun[]; events: ActivityEvent[]; days: ActivityDay[] };

const KNOWN_ERRORS = new Set([LEG_LIMIT_MESSAGE, CEILING_MESSAGE, OLD_LIMIT_MESSAGE]);

export async function computeActivity(
  orgId: string,
  win: { from: Date; to: Date; agent: string | null; modality?: ModalityFilter },
): Promise<ActivityReport> {
  const inRun = and(
    eq(agentRuns.orgId, orgId),
    gte(agentRuns.createdAt, win.from),
    lte(agentRuns.createdAt, win.to),
    ...(win.agent ? [eq(agentRuns.agentType, win.agent as never)] : []),
    ...modalityWhere(agentRuns.agentType, win.modality),
  );
  const [runs, events, failedSteps, tasks, delegations] = await Promise.all([
    db
      .select({
        id: agentRuns.id,
        agentType: agentRuns.agentType,
        status: agentRuns.status,
        triggerEventId: agentRuns.triggerEventId,
        definitionVersion: agentRuns.definitionVersion,
        stepCount: agentRuns.stepCount,
        tokensUsed: agentRuns.tokensUsed,
        lastError: agentRuns.lastError,
        createdAt: agentRuns.createdAt,
        finishedAt: agentRuns.finishedAt,
      })
      .from(agentRuns)
      .where(inRun),
    db
      .select({
        id: agentEvents.id,
        type: agentEvents.type,
        status: agentEvents.status,
        attempts: agentEvents.attempts,
        actorUserId: agentEvents.actorUserId,
        sourceRunId: agentEvents.sourceRunId,
        createdAt: agentEvents.createdAt,
      })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.orgId, orgId),
          gte(agentEvents.createdAt, win.from),
          lte(agentEvents.createdAt, win.to),
        ),
      ),
    db
      .select({ runId: agentSteps.runId })
      .from(agentSteps)
      .innerJoin(agentRuns, eq(agentRuns.id, agentSteps.runId))
      .where(and(eq(agentSteps.orgId, orgId), inRun, eq(agentSteps.status, "error"))),
    db
      .select({ runId: agentTasks.runId, status: agentTasks.status })
      .from(agentTasks)
      .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
      .where(
        and(eq(agentTasks.orgId, orgId), inRun, inArray(agentTasks.kind, ["approval", "gate"])),
      ),
    db
      .select({ runId: agentSteps.runId, output: agentSteps.output })
      .from(agentSteps)
      .where(and(eq(agentSteps.orgId, orgId), eq(agentSteps.toolName, "start_agent"))),
  ]);

  // runs started by delegation: child runId → delegating run
  const delegatedBy = new Map<string, string>();
  for (const d of delegations) {
    const child = (d.output as { runId?: unknown } | null)?.runId;
    if (typeof child === "string") delegatedBy.set(child, d.runId);
  }
  const allRunAgent = new Map(runs.map((r) => [r.id, r.agentType]));
  // runs outside the window that published or delegated still need a name
  const outside = [
    ...new Set(
      [...events.map((e) => e.sourceRunId), ...delegatedBy.values()].filter(
        (id): id is string => !!id && !allRunAgent.has(id),
      ),
    ),
  ];
  if (outside.length) {
    const extra = await db
      .select({ id: agentRuns.id, agentType: agentRuns.agentType })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.id, outside)));
    for (const r of extra) allRunAgent.set(r.id, r.agentType);
  }
  const eventById = new Map(events.map((e) => [e.id, e]));
  const failedBy = new Map<string, number>();
  for (const s of failedSteps) failedBy.set(s.runId, (failedBy.get(s.runId) ?? 0) + 1);
  const taskBy = new Map<string, { n: number; declined: number }>();
  for (const t of tasks) {
    const cur = taskBy.get(t.runId) ?? { n: 0, declined: 0 };
    cur.n += 1;
    if (t.status === "rejected") cur.declined += 1;
    taskBy.set(t.runId, cur);
  }
  const publisher = (e: (typeof events)[number]) =>
    e.sourceRunId
      ? `agent: ${allRunAgent.get(e.sourceRunId) ?? "?"}`
      : e.actorUserId
        ? "a person"
        : "system / not recorded";

  const runRows: ActivityRun[] = runs
    .map((r) => {
      const ev = r.triggerEventId ? eventById.get(r.triggerEventId) : undefined;
      const parent = delegatedBy.get(r.id);
      const startedBy = parent
        ? `delegated by ${allRunAgent.get(parent) ?? "an agent"}`
        : r.triggerEventId
          ? `event: ${ev?.type ?? "earlier event"}${ev?.sourceRunId ? ` (from ${allRunAgent.get(ev.sourceRunId) ?? "an agent"})` : ""}`
          : "a person or schedule";
      const t = taskBy.get(r.id);
      return {
        id: r.id.slice(0, 8),
        agent: r.agentType,
        status: r.status,
        startedBy,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        durationMin: r.finishedAt
          ? Math.round((r.finishedAt.getTime() - r.createdAt.getTime()) / 6000) / 10
          : null,
        steps: r.stepCount,
        tokens: r.tokensUsed,
        failedCalls: failedBy.get(r.id) ?? 0,
        approvals: t?.n ?? 0,
        declined: t?.declined ?? 0,
        definitionVersion: r.definitionVersion ?? "unrecorded",
        error: !r.lastError
          ? ""
          : KNOWN_ERRORS.has(r.lastError)
            ? r.lastError
            : "failed (details in Agent activity)",
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const startedFrom = new Map<string, string[]>();
  for (const r of runs)
    if (r.triggerEventId)
      startedFrom.set(r.triggerEventId, [
        ...(startedFrom.get(r.triggerEventId) ?? []),
        r.agentType,
      ]);
  const eventRows: ActivityEvent[] = events
    .map((e) => ({
      type: e.type,
      status: e.status,
      attempts: e.attempts,
      publishedBy: publisher(e),
      startedAgents: (startedFrom.get(e.id) ?? []).join(", "),
      createdAt: e.createdAt.toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const dayMap = new Map<string, ActivityDay>();
  for (const r of runs) {
    const day = r.createdAt.toISOString().slice(0, 10);
    const k = `${day}|${r.agentType}`;
    const d = dayMap.get(k) ?? { day, agent: r.agentType, runs: 0, failed: 0, steps: 0, tokens: 0 };
    d.runs += 1;
    if (r.status === "failed") d.failed += 1;
    d.steps += r.stepCount;
    d.tokens += r.tokensUsed;
    dayMap.set(k, d);
  }
  const days = [...dayMap.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent),
  );

  return { runs: runRows, events: eventRows, days };
}
