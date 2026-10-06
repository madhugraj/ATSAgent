/**
 * Autonomy recommendations (docs/agentic-plan.md §5.2, §11, Phase 5).
 *
 * The human-edit rate is the quality signal for raising autonomy: when people
 * approve an agent's proposed actions unchanged, almost always, for long
 * enough, the agent may move up a level; when they reject or rewrite them, or
 * a critical health issue is open, it should move down. This module only
 * recommends — a person applies the change in Agent settings, and that save
 * is audited. Thresholds are explicit so every recommendation is explainable.
 */
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";

import { db } from "../db";
import {
  agentIssues,
  agentPolicies,
  agentRuns,
  agentSteps,
  agentTasks,
  type AgentAutonomy,
} from "@db/schema";
import { getTool } from "./registry";

export const AUTONOMY = {
  windowDays: 30,
  /** Raise suggest → act_and_notify. */
  minDecisions: 20,
  approveUneditedRate: 0.9,
  maxRejectRate: 0.05,
  /** Raise act_and_notify → autonomous: actions taken and reported without complaint. */
  minNotifiedActions: 20,
  maxToolErrorRate: 0.05,
  maxFailedRunRate: 0.1,
  /** Time at the current level before any raise (days). */
  minDaysAtLevel: 14,
  /** Lower when, over at least this many decisions… */
  lowerMinDecisions: 10,
  /** …more than this share were rejected… */
  lowerRejectRate: 0.25,
  /** …or rewritten before approval. */
  lowerEditRate: 0.4,
  /** Pre-approve a message template. */
  templateMinDecisions: 10,
  templateApproveRate: 0.95,
} as const;

const LEVELS: AgentAutonomy[] = ["suggest", "act_and_notify", "autonomous"];

export type AutonomyStats = {
  decided: number;
  approvedUnedited: number;
  edited: number;
  rejected: number;
  notifiedActions: number;
  toolCalls: number;
  toolErrors: number;
  runsFinished: number;
  runsFailed: number;
  openSeverity: "warning" | "serious" | "critical" | null;
  daysAtLevel: number | null;
};

export type TemplateStat = {
  id: string;
  decided: number;
  approvedUnedited: number;
  rejected: number;
};

export type AutonomyRecommendation = {
  action: "raise" | "lower" | "hold";
  to: AgentAutonomy | null;
  reason: string;
  stats: AutonomyStats;
  /** Message templates whose approvals are near-unanimous and could be pre-approved. */
  templates: { id: string; decided: number; approvedUnedited: number }[];
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const rate = (a: number, b: number) => (b ? a / b : 0);

/** Pure decision — unit-tested. */
export function recommendAutonomy(input: {
  enabled: boolean;
  current: AgentAutonomy;
  whitelisted: string[];
  stats: AutonomyStats;
  templates: TemplateStat[];
}): AutonomyRecommendation {
  const { current, stats: s } = input;
  const level = LEVELS.indexOf(current);
  const templates =
    current === "suggest"
      ? []
      : input.templates
          .filter(
            (t) =>
              !input.whitelisted.includes(t.id) &&
              t.decided >= AUTONOMY.templateMinDecisions &&
              t.rejected === 0 &&
              rate(t.approvedUnedited, t.decided) >= AUTONOMY.templateApproveRate,
          )
          .map(({ id, decided, approvedUnedited }) => ({ id, decided, approvedUnedited }));
  const out = (
    action: AutonomyRecommendation["action"],
    to: AgentAutonomy | null,
    reason: string,
  ) => ({
    action,
    to,
    reason,
    stats: s,
    templates,
  });

  if (!input.enabled) return out("hold", null, "The agent is switched off.");

  const rejectRate = rate(s.rejected, s.decided);
  const editRate = rate(s.edited, s.decided);
  const toolErrorRate = rate(s.toolErrors, s.toolCalls);
  const failedRate = rate(s.runsFailed, s.runsFinished);

  // Lower first: safety signals win over everything else.
  if (s.openSeverity === "critical" && level > 0)
    return out("lower", LEVELS[level - 1]!, "A critical health issue is open for this agent.");
  if (level > 0 && s.decided >= AUTONOMY.lowerMinDecisions) {
    if (rejectRate > AUTONOMY.lowerRejectRate)
      return out(
        "lower",
        "suggest",
        `People rejected ${pct(rejectRate)} of ${s.decided} requests in ${AUTONOMY.windowDays} days (limit ${pct(AUTONOMY.lowerRejectRate)}).`,
      );
    if (editRate > AUTONOMY.lowerEditRate)
      return out(
        "lower",
        "suggest",
        `People rewrote ${pct(editRate)} of ${s.decided} proposals before approving (limit ${pct(AUTONOMY.lowerEditRate)}).`,
      );
  }

  if (level === LEVELS.length - 1) return out("hold", null, "Already at the highest level.");
  if (s.openSeverity === "serious" || s.openSeverity === "critical")
    return out("hold", null, "Resolve the open serious health issue before raising autonomy.");
  if (s.daysAtLevel !== null && s.daysAtLevel < AUTONOMY.minDaysAtLevel)
    return out(
      "hold",
      null,
      `Keep the current level ${AUTONOMY.minDaysAtLevel - s.daysAtLevel} more day(s) to gather evidence.`,
    );
  if (toolErrorRate > AUTONOMY.maxToolErrorRate)
    return out(
      "hold",
      null,
      `${pct(toolErrorRate)} of tool calls failed (needs at most ${pct(AUTONOMY.maxToolErrorRate)}).`,
    );
  if (failedRate > AUTONOMY.maxFailedRunRate)
    return out(
      "hold",
      null,
      `${pct(failedRate)} of runs failed (needs at most ${pct(AUTONOMY.maxFailedRunRate)}).`,
    );

  if (current === "suggest") {
    if (s.decided < AUTONOMY.minDecisions)
      return out(
        "hold",
        null,
        `Needs ${AUTONOMY.minDecisions} decided requests in ${AUTONOMY.windowDays} days (has ${s.decided}).`,
      );
    const approved = rate(s.approvedUnedited, s.decided);
    if (approved < AUTONOMY.approveUneditedRate)
      return out(
        "hold",
        null,
        `${pct(approved)} of requests were approved unchanged (needs ${pct(AUTONOMY.approveUneditedRate)}).`,
      );
    if (rejectRate > AUTONOMY.maxRejectRate)
      return out(
        "hold",
        null,
        `${pct(rejectRate)} of requests were rejected (needs at most ${pct(AUTONOMY.maxRejectRate)}).`,
      );
    return out(
      "raise",
      "act_and_notify",
      `${pct(approved)} of ${s.decided} requests were approved unchanged in ${AUTONOMY.windowDays} days, with ${pct(rejectRate)} rejected.`,
    );
  }

  // act_and_notify → autonomous
  if (s.notifiedActions < AUTONOMY.minNotifiedActions)
    return out(
      "hold",
      null,
      `Needs ${AUTONOMY.minNotifiedActions} actions taken and reported in ${AUTONOMY.windowDays} days (has ${s.notifiedActions}).`,
    );
  if (s.decided && rejectRate > AUTONOMY.maxRejectRate)
    return out(
      "hold",
      null,
      `${pct(rejectRate)} of the remaining requests were rejected (needs at most ${pct(AUTONOMY.maxRejectRate)}).`,
    );
  return out(
    "raise",
    "autonomous",
    `${s.notifiedActions} actions ran and were reported in ${AUTONOMY.windowDays} days with ${pct(toolErrorRate)} tool errors.`,
  );
}

const SEVERITY_RANK = { warning: 1, serious: 2, critical: 3 } as const;

/** Measured stats and a recommendation per agent type for one organisation. */
export async function autonomyRecommendations(
  orgId: string,
  agentTypes: string[],
): Promise<Record<string, AutonomyRecommendation>> {
  const since = new Date(Date.now() - AUTONOMY.windowDays * 864e5);
  const policies = await db.select().from(agentPolicies).where(eq(agentPolicies.orgId, orgId));

  const tasks = await db
    .select({
      agentType: agentRuns.agentType,
      status: agentTasks.status,
      response: agentTasks.response,
      proposedAction: agentTasks.proposedAction,
    })
    .from(agentTasks)
    .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.kind, "approval"),
        inArray(agentTasks.status, ["approved", "rejected"]),
        gte(agentTasks.decidedAt, since),
      ),
    )
    .limit(5000);

  const steps = await db
    .select({
      agentType: agentRuns.agentType,
      calls: sql<number>`count(*) filter (where ${agentSteps.kind} = 'tool' and ${agentSteps.status} in ('ok','error'))::int`,
      errors: sql<number>`count(*) filter (where ${agentSteps.kind} = 'tool' and ${agentSteps.status} = 'error')::int`,
      notified: sql<number>`count(*) filter (where ${agentSteps.notifyState} is not null)::int`,
    })
    .from(agentSteps)
    .innerJoin(agentRuns, eq(agentRuns.id, agentSteps.runId))
    .where(
      and(
        eq(agentSteps.orgId, orgId),
        eq(agentRuns.mode, "live"),
        gte(agentSteps.createdAt, since),
      ),
    )
    .groupBy(agentRuns.agentType);

  const runs = await db
    .select({
      agentType: agentRuns.agentType,
      finished: sql<number>`count(*) filter (where ${agentRuns.status} in ('done','failed'))::int`,
      failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
    })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.orgId, orgId), eq(agentRuns.mode, "live"), gte(agentRuns.finishedAt, since)),
    )
    .groupBy(agentRuns.agentType);

  const issues = await db
    .select({ agentType: agentIssues.agentType, severity: agentIssues.severity })
    .from(agentIssues)
    .where(and(eq(agentIssues.orgId, orgId), ne(agentIssues.status, "resolved")));

  const out: Record<string, AutonomyRecommendation> = {};
  for (const type of agentTypes) {
    const p = policies.find((x) => x.agentType === type);
    const mine = tasks.filter((t) => t.agentType === type);
    const isEdited = (t: (typeof mine)[number]) =>
      t.status === "approved" &&
      !!t.response &&
      typeof t.response === "object" &&
      "args" in (t.response as object);
    const templateStats = new Map<string, TemplateStat>();
    for (const t of mine) {
      const a = t.proposedAction as { name?: string; args?: unknown } | null;
      const tool = a?.name ? getTool(a.name) : undefined;
      let id: string | null = null;
      try {
        id = tool?.templateOf?.(a?.args as never) ?? null;
      } catch {
        id = null;
      }
      if (!id) continue;
      const cur = templateStats.get(id) ?? { id, decided: 0, approvedUnedited: 0, rejected: 0 };
      cur.decided++;
      if (t.status === "rejected") cur.rejected++;
      else if (!isEdited(t)) cur.approvedUnedited++;
      templateStats.set(id, cur);
    }
    const st = steps.find((x) => x.agentType === type);
    const ru = runs.find((x) => x.agentType === type);
    const worst = issues
      .filter((i) => i.agentType === type || i.agentType === "*")
      .reduce<AutonomyStats["openSeverity"]>(
        (w, i) => (!w || SEVERITY_RANK[i.severity] > SEVERITY_RANK[w] ? i.severity : w),
        null,
      );
    const stats: AutonomyStats = {
      decided: mine.length,
      approvedUnedited: mine.filter((t) => t.status === "approved" && !isEdited(t)).length,
      edited: mine.filter(isEdited).length,
      rejected: mine.filter((t) => t.status === "rejected").length,
      notifiedActions: Number(st?.notified ?? 0),
      toolCalls: Number(st?.calls ?? 0),
      toolErrors: Number(st?.errors ?? 0),
      runsFinished: Number(ru?.finished ?? 0),
      runsFailed: Number(ru?.failed ?? 0),
      openSeverity: worst,
      daysAtLevel: p ? Math.floor((Date.now() - p.updatedAt.getTime()) / 864e5) : null,
    };
    out[type] = recommendAutonomy({
      enabled: p?.enabled ?? false,
      current: p?.autonomy ?? "suggest",
      whitelisted: p?.whitelistedTemplates ?? [],
      stats,
      templates: [...templateStats.values()],
    });
  }
  return out;
}
