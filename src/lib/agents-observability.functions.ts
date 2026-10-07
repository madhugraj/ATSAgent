/**
 * Agent observability (docs/agentic-plan.md §9): per agent and per element of
 * the architecture — identity, definition, tools, skills, evals, harness,
 * human-in-the-loop, budget, audit — the activity and performance of the last
 * 7 / 14 days plus open health issues. Governance roles only; vendor- and
 * model-neutral (AI is reported by feature slug).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { agentIssues } from "@db/schema";
import { requireOrg } from "./auth.middleware";

const GOVERNANCE_ROLES = ["hr_head", "president_cbo"] as const;

export type IssueView = {
  id: string;
  agentType: string;
  element: string;
  rule: string;
  severity: "warning" | "serious" | "critical";
  status: "open" | "acknowledged";
  title: string;
  description: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
};

export type AgentObservability = {
  type: string;
  name: string;
  version: string;
  hash: string;
  owner: string;
  riskTier: string;
  enabled: boolean;
  autonomy: string;
  definition: { versionsSeen: number; changes30d: number };
  tools: {
    declared: number;
    calls7d: number;
    errors7d: number;
    byTool: { tool: string; calls: number; errors: number }[];
  };
  skills: {
    declared: string[];
    requests7d: number;
    errors7d: number;
    tokens7d: number;
    p95Ms: number | null;
    byFeature: { feature: string; requests: number; errors: number; p95Ms: number | null }[];
  };
  evals: { declared: string[] };
  harness: {
    runs7d: number;
    done7d: number;
    failed7d: number;
    active: number;
    avgSteps: number | null;
    p95RunMinutes: number | null;
    budgetPaused: number;
    daily: { day: string; runs: number; failed: number }[];
  };
  hitl: {
    open: number;
    overdue: number;
    decided7d: number;
    approved7d: number;
    declined7d: number;
    edited7d: number;
    medianWaitMinutes: number | null;
  };
  budget: { monthTokens: number; cap: number | null };
  audit: { events7d: number; byAction: { action: string; n: number }[] };
  issues: IssueView[];
};

export type TrendDay = {
  day: string;
  /** Live runs started that day, by their current outcome. */
  completed: number;
  failed: number;
  inProgress: number;
  stopped: number;
  tokens: number;
  toolOk: number;
  toolErrors: number;
  hitlOpened: number;
  hitlDecided: number;
  /** Median wait of requests decided that day (hours). */
  medianWaitHours: number | null;
  /** p95 latency of AI requests inside runs that day (seconds). */
  aiP95Seconds: number | null;
};

export type ObservabilityView = {
  scheduler: { lastTickAt: string | null; minutesSinceTick: number | null; healthy: boolean };
  slaHours: number;
  totals: {
    runs7d: number;
    successRate: number | null;
    tokens7d: number;
    openRequests: number;
    overdueRequests: number;
    medianWaitMinutes: number | null;
    issues: { critical: number; serious: number; warning: number };
  };
  orgIssues: IssueView[];
  /** Organisation-wide daily series for the last 14 days (UTC days, oldest first). */
  trends: TrendDay[];
  agents: AgentObservability[];
  rules: { id: string; element: string; severity: string; description: string }[];
};

type Row = Record<string, unknown>;
const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as Row[];
const n = (v: unknown) => (v == null ? 0 : Number(v));
const nOrNull = (v: unknown) => (v == null ? null : Number(v));

export const agentObservability = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<ObservabilityView> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...GOVERNANCE_ROLES]);
    try {
      return await buildObservability(context.orgId);
    } catch (e) {
      // Never show query text to the browser; keep the detail in the server log.
      const { log } = await import("../server/log");
      log.error("agent.observability.failed", { org_id: context.orgId, error: e as Error });
      throw new Error("Agent observability data could not be loaded. The error has been logged.");
    }
  });

async function buildObservability(orgId: string): Promise<ObservabilityView> {
  {
    const { ensureAgentsRegistered } = await import("../server/agents");
    ensureAgentsRegistered();
    const { listAgents, skillsOf } = await import("../server/agents/registry");
    const { manifestHash } = await import("../server/agents/manifest.server");
    const { loadPolicy } = await import("../server/agents/policy");
    const { monthTokens } = await import("../server/agents/runtime.server");
    const { HEALTH, RULES, schedulerStatus } = await import("../server/agents/health.server");
    const org = orgId;

    const ruleText = new Map(RULES.map((r) => [r.id, r.description]));
    const issueRows = await db
      .select()
      .from(agentIssues)
      .where(and(eq(agentIssues.orgId, org), ne(agentIssues.status, "resolved")));
    const issues: IssueView[] = issueRows.map((i) => ({
      id: i.id,
      agentType: i.agentType,
      element: i.element,
      rule: i.rule,
      severity: i.severity,
      status: i.status as "open" | "acknowledged",
      title: i.title,
      description: ruleText.get(i.rule) ?? "",
      firstSeenAt: i.firstSeenAt.toISOString(),
      lastSeenAt: i.lastSeenAt.toISOString(),
      occurrences: i.occurrences,
    }));

    const runStats = await q(sql`
      select agent_type,
        count(*) filter (where created_at >= now() - interval '7 days')::int runs7d,
        count(*) filter (where status = 'done' and finished_at >= now() - interval '7 days')::int done7d,
        count(*) filter (where status = 'failed' and finished_at >= now() - interval '7 days')::int failed7d,
        count(*) filter (where status in ('queued','running','awaiting_human'))::int active,
        round(avg(step_count) filter (where finished_at >= now() - interval '7 days'), 1) avg_steps,
        round((percentile_cont(0.95) within group (order by extract(epoch from (finished_at - started_at)) / 60)
          filter (where finished_at >= now() - interval '7 days' and started_at is not null))::numeric, 1) p95_min,
        count(*) filter (where status = 'queued' and last_error = 'Paused: this agent reached its monthly token budget.')::int paused
      from agent_runs where org_id = ${org} group by agent_type`);
    const dailyAgent = await q(sql`
      select a.agent_type, d.day::date::text as day,
        (select count(*) from agent_runs r where r.org_id = ${org} and r.agent_type = a.agent_type
          and (r.created_at at time zone 'utc')::date = d.day::date)::int runs,
        (select count(*) from agent_runs r where r.org_id = ${org} and r.agent_type = a.agent_type
          and r.status = 'failed' and (r.finished_at at time zone 'utc')::date = d.day::date)::int failed
      from (select distinct agent_type from agent_runs where org_id = ${org}) a
      cross join generate_series(current_date - 13, current_date, interval '1 day') d(day)
      order by d.day`);
    const toolStats = await q(sql`
      select r.agent_type, st.tool_name tool, count(*)::int calls,
        count(*) filter (where st.status = 'error')::int errors
      from agent_steps st join agent_runs r on r.id = st.run_id
      where st.org_id = ${org} and st.kind = 'tool' and st.status in ('ok','error')
        and st.created_at >= now() - interval '7 days'
      group by r.agent_type, st.tool_name`);
    const aiStats = await q(sql`
      select r.agent_type, u.feature, count(*)::int requests,
        count(*) filter (where u.status = 'error')::int errors,
        coalesce(sum(u.total_tokens), 0)::bigint tokens,
        percentile_cont(0.95) within group (order by u.duration_ms)::int p95
      from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
      where r.org_id = ${org} and u.created_at >= now() - interval '7 days'
      group by r.agent_type, u.feature`);
    const aiAgentP95 = await q(sql`
      select r.agent_type, percentile_cont(0.95) within group (order by u.duration_ms)::int p95
      from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
      where r.org_id = ${org} and u.created_at >= now() - interval '7 days'
      group by r.agent_type`);
    const hitlStats = await q(sql`
      select r.agent_type,
        count(*) filter (where t.status = 'open')::int open,
        count(*) filter (where t.status = 'open' and t.created_at < now() - make_interval(hours => ${HEALTH.hitlSlaHours}))::int overdue,
        count(*) filter (where t.decided_at >= now() - interval '7 days')::int decided,
        count(*) filter (where t.decided_at >= now() - interval '7 days' and t.status in ('approved','answered'))::int approved,
        count(*) filter (where t.decided_at >= now() - interval '7 days' and t.status = 'rejected')::int declined,
        count(*) filter (where t.decided_at >= now() - interval '7 days' and t.status = 'approved' and t.response ? 'args')::int edited,
        round((percentile_cont(0.5) within group (order by extract(epoch from (t.decided_at - t.created_at)) / 60)
          filter (where t.decided_at >= now() - interval '7 days'))::numeric) median_wait
      from agent_tasks t join agent_runs r on r.id = t.run_id
      where t.org_id = ${org} group by r.agent_type`);
    const auditStats = await q(sql`
      select split_part(actor, ':', 2) agent_type, action, count(*)::int n
      from audit_log
      where org_id = ${org} and actor like 'agent:%' and created_at >= now() - interval '7 days'
      group by 1, 2`);
    const defStats = await q(sql`
      select agent_type, count(distinct definition_hash)::int versions,
        (select count(*) from audit_log a where a.org_id = ${org}
          and a.action = 'agent.run.definition_changed' and a.actor like 'agent:' || agent_runs.agent_type || ':%'
          and a.created_at >= now() - interval '30 days')::int changes
      from agent_runs where org_id = ${org} and definition_hash is not null group by agent_type`);
    const orgTotals = await q(sql`
      select
        (select count(*) from agent_runs where org_id = ${org} and created_at >= now() - interval '7 days')::int runs7d,
        (select count(*) from agent_runs where org_id = ${org} and status = 'done' and finished_at >= now() - interval '7 days')::int done7d,
        (select count(*) from agent_runs where org_id = ${org} and status = 'failed' and finished_at >= now() - interval '7 days')::int failed7d,
        (select coalesce(sum(u.total_tokens), 0) from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
          where r.org_id = ${org} and u.created_at >= now() - interval '7 days')::bigint tokens7d,
        (select count(*) from agent_tasks where org_id = ${org} and status = 'open')::int open_requests,
        (select count(*) from agent_tasks where org_id = ${org} and status = 'open'
          and created_at < now() - make_interval(hours => ${HEALTH.hitlSlaHours}))::int overdue,
        (select round((percentile_cont(0.5) within group (order by extract(epoch from (decided_at - created_at)) / 60))::numeric)
          from agent_tasks where org_id = ${org} and decided_at >= now() - interval '7 days') median_wait`);

    const trendRows = await q(sql`
      with d as (
        select (current_date - g)::date as day from generate_series(0, 13) g
      ),
      r as (
        select (created_at at time zone 'utc')::date as day,
          count(*) filter (where status = 'done')::int completed,
          count(*) filter (where status = 'failed')::int failed,
          count(*) filter (where status in ('queued','running','awaiting_human'))::int in_progress,
          count(*) filter (where status = 'cancelled')::int stopped
        from agent_runs where org_id = ${org} and mode = 'live'
          and created_at >= current_date - 13
        group by 1
      ),
      u as (
        select (u.created_at at time zone 'utc')::date as day,
          coalesce(sum(u.total_tokens), 0)::bigint tokens,
          percentile_cont(0.95) within group (order by u.duration_ms) p95
        from ai_usage_events u join agent_runs ar on ar.id = u.agent_run_id
        where ar.org_id = ${org} and u.created_at >= current_date - 13
        group by 1
      ),
      s as (
        select (created_at at time zone 'utc')::date as day,
          count(*) filter (where status = 'ok')::int ok,
          count(*) filter (where status = 'error')::int errors
        from agent_steps where org_id = ${org} and kind = 'tool' and status in ('ok','error')
          and created_at >= current_date - 13
        group by 1
      ),
      o as (
        select (created_at at time zone 'utc')::date as day, count(*)::int opened
        from agent_tasks where org_id = ${org} and created_at >= current_date - 13 group by 1
      ),
      dc as (
        select (decided_at at time zone 'utc')::date as day, count(*)::int decided,
          percentile_cont(0.5) within group (order by extract(epoch from (decided_at - created_at)) / 3600) wait_h
        from agent_tasks where org_id = ${org} and decided_at >= current_date - 13 group by 1
      )
      select d.day::text as day,
        coalesce(r.completed, 0) completed, coalesce(r.failed, 0) failed,
        coalesce(r.in_progress, 0) in_progress, coalesce(r.stopped, 0) stopped,
        coalesce(u.tokens, 0) tokens, u.p95,
        coalesce(s.ok, 0) tool_ok, coalesce(s.errors, 0) tool_errors,
        coalesce(o.opened, 0) opened, coalesce(dc.decided, 0) decided, dc.wait_h
      from d
      left join r using (day) left join u using (day) left join s using (day)
      left join o using (day) left join dc using (day)
      order by d.day`);
    const trends: TrendDay[] = trendRows.map((r) => ({
      day: String(r["day"]),
      completed: n(r["completed"]),
      failed: n(r["failed"]),
      inProgress: n(r["in_progress"]),
      stopped: n(r["stopped"]),
      tokens: n(r["tokens"]),
      toolOk: n(r["tool_ok"]),
      toolErrors: n(r["tool_errors"]),
      hitlOpened: n(r["opened"]),
      hitlDecided: n(r["decided"]),
      medianWaitHours: r["wait_h"] == null ? null : Math.round(Number(r["wait_h"]) * 10) / 10,
      aiP95Seconds: r["p95"] == null ? null : Math.round(Number(r["p95"]) / 100) / 10,
    }));

    const by = <T extends Row>(rows: T[], type: string) =>
      rows.filter((r) => r["agent_type"] === type);
    const agents: AgentObservability[] = [];
    for (const def of listAgents()) {
      const policy = await loadPolicy(org, def.type);
      const rs = by(runStats, def.type)[0] ?? {};
      const hs = by(hitlStats, def.type)[0] ?? {};
      const ds = by(defStats, def.type)[0] ?? {};
      const tools = by(toolStats, def.type).map((t) => ({
        tool: String(t["tool"]),
        calls: n(t["calls"]),
        errors: n(t["errors"]),
      }));
      const ai = by(aiStats, def.type).map((a) => ({
        feature: String(a["feature"]),
        requests: n(a["requests"]),
        errors: n(a["errors"]),
        tokens: n(a["tokens"]),
        p95Ms: nOrNull(a["p95"]),
      }));
      const audit = by(auditStats, def.type).map((a) => ({
        action: String(a["action"]),
        n: n(a["n"]),
      }));
      agents.push({
        type: def.type,
        name: def.name,
        version: def.version,
        hash: manifestHash(def),
        owner: def.owner,
        riskTier: def.riskTier,
        enabled: policy.enabled,
        autonomy: policy.autonomy,
        definition: { versionsSeen: n(ds["versions"]), changes30d: n(ds["changes"]) },
        tools: {
          declared: def.tools.length,
          calls7d: tools.reduce((s, t) => s + t.calls, 0),
          errors7d: tools.reduce((s, t) => s + t.errors, 0),
          byTool: tools.sort((a, b) => b.calls - a.calls).slice(0, 6),
        },
        skills: {
          declared: skillsOf(def),
          requests7d: ai.reduce((s, a) => s + a.requests, 0),
          errors7d: ai.reduce((s, a) => s + a.errors, 0),
          tokens7d: ai.reduce((s, a) => s + a.tokens, 0),
          p95Ms: nOrNull(by(aiAgentP95, def.type)[0]?.["p95"]),
          byFeature: ai.map(({ feature, requests, errors, p95Ms }) => ({
            feature,
            requests,
            errors,
            p95Ms,
          })),
        },
        evals: { declared: def.evals },
        harness: {
          runs7d: n(rs["runs7d"]),
          done7d: n(rs["done7d"]),
          failed7d: n(rs["failed7d"]),
          active: n(rs["active"]),
          avgSteps: nOrNull(rs["avg_steps"]),
          p95RunMinutes: nOrNull(rs["p95_min"]),
          budgetPaused: n(rs["paused"]),
          daily: by(dailyAgent, def.type).map((d) => ({
            day: String(d["day"]),
            runs: n(d["runs"]),
            failed: n(d["failed"]),
          })),
        },
        hitl: {
          open: n(hs["open"]),
          overdue: n(hs["overdue"]),
          decided7d: n(hs["decided"]),
          approved7d: n(hs["approved"]),
          declined7d: n(hs["declined"]),
          edited7d: n(hs["edited"]),
          medianWaitMinutes: nOrNull(hs["median_wait"]),
        },
        budget: { monthTokens: await monthTokens(org, def.type), cap: policy.monthlyTokenBudget },
        audit: { events7d: audit.reduce((s, a) => s + a.n, 0), byAction: audit },
        issues: issues.filter((i) => i.agentType === def.type),
      });
    }

    const t = orgTotals[0] ?? {};
    const finished = n(t["done7d"]) + n(t["failed7d"]);
    const sched = await schedulerStatus();
    return {
      scheduler: {
        lastTickAt: sched.lastTickAt,
        minutesSinceTick: sched.minutesSinceTick,
        healthy: sched.healthy,
      },
      slaHours: HEALTH.hitlSlaHours,
      totals: {
        runs7d: n(t["runs7d"]),
        successRate: finished ? n(t["done7d"]) / finished : null,
        tokens7d: n(t["tokens7d"]),
        openRequests: n(t["open_requests"]),
        overdueRequests: n(t["overdue"]),
        medianWaitMinutes: nOrNull(t["median_wait"]),
        issues: {
          critical: issues.filter((i) => i.severity === "critical").length,
          serious: issues.filter((i) => i.severity === "serious").length,
          warning: issues.filter((i) => i.severity === "warning").length,
        },
      },
      orgIssues: issues.filter((i) => i.agentType === "*"),
      trends,
      agents,
      rules: RULES.map((r) => ({
        id: r.id,
        element: r.element,
        severity: r.severity,
        description: r.description,
      })),
    };
  }
}

/** Acknowledge an issue: it stays visible and still auto-resolves, but stops notifying. */
export const acknowledgeAgentIssue = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ issueId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...GOVERNANCE_ROLES]);
    const done = await db
      .update(agentIssues)
      .set({ status: "acknowledged", acknowledgedBy: context.userId, acknowledgedAt: new Date() })
      .where(
        and(
          eq(agentIssues.id, data.issueId),
          eq(agentIssues.orgId, context.orgId),
          eq(agentIssues.status, "open"),
        ),
      )
      .returning({ id: agentIssues.id });
    if (!done.length) throw new Error("Issue not found or already acknowledged.");
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: `user:${context.userId}`,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "agent.issue.acknowledged",
      entityType: "agent_issue",
      entityId: data.issueId,
    });
    return { ok: true as const };
  });

/* ------------------------------------------------------------ agent detail */

export type AgentDetail = {
  identity: {
    type: string;
    name: string;
    version: string;
    hash: string;
    owner: string;
    riskTier: string;
    responsibility: string;
    mustNever: string[];
    scope: { reads: string[]; writes: string[]; external: string[] };
    gates: string[];
    feature: string;
    versions: { version: string; hash: string; firstSeen: string; runs: number }[];
    policy: {
      enabled: boolean;
      autonomy: string;
      whitelistedTemplates: string[];
      monthlyTokenBudget: number | null;
    };
  };
  tools: {
    name: string;
    description: string;
    risk: string;
    skills: string[];
    preApprovable: boolean;
    untrustedOutput: boolean;
    inputSchemaJson: string;
    calls7d: number;
    errors7d: number;
    avgMs: number | null;
    awaitingApproval7d: number;
    lastError: string | null;
    lastUsedAt: string | null;
  }[];
  skills: {
    feature: string;
    usedBy: string[];
    requests7d: number;
    errors7d: number;
    tokens7d: number;
    avgMs: number | null;
    p95Ms: number | null;
  }[];
  harness: {
    maxSteps: number;
    maxTokensPerRun: number;
    turnsPerTick: number;
    leaseMinutes: number;
    maxAttempts: number;
    concurrency: number;
    budgetRecheckMinutes: number;
    autonomyRules: { risk: string; suggest: string; act_and_notify: string; autonomous: string }[];
    humanTools: { name: string; description: string }[];
    sharedRules: string;
    injectionRules: string;
    instructions: string;
    recentRuns: {
      id: string;
      status: string;
      goal: string;
      steps: number;
      tokens: number;
      definitionVersion: string | null;
      createdAt: string;
      durationMinutes: number | null;
      error: string | null;
    }[];
  };
  hitl: {
    open: { id: string; kind: string; title: string; assignee: string; ageHours: number }[];
    recent: {
      id: string;
      kind: string;
      title: string;
      status: string;
      decidedBy: string | null;
      waitMinutes: number | null;
      edited: boolean;
      decidedAt: string | null;
    }[];
  };
  evals: { name: string }[];
  audit: { action: string; actor: string; entityType: string | null; at: string }[];
  issues: {
    open: IssueView[];
    resolved: {
      rule: string;
      title: string;
      severity: string;
      firstSeenAt: string;
      resolvedAt: string;
    }[];
  };
};

const SAFE_ERRORS = new Set([
  "The run reached its step or token budget.",
  "The worker stopped before finishing this step.",
  "No AI model key saved. Add one on the Integrations page.",
  "Paused: this agent reached its monthly token budget.",
]);

/** Everything about one agent for the observability drawer (loaded on click). */
export const agentObservabilityDetail = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .inputValidator((d: unknown) => z.object({ agentType: z.string().min(2).max(40) }).parse(d))
  .handler(async ({ data, context }): Promise<AgentDetail> => {
    const { assertRole } = await import("./auth.middleware");
    await assertRole(context.userId, context.orgId, [...GOVERNANCE_ROLES]);
    try {
      return await buildDetail(context.orgId, data.agentType);
    } catch (e) {
      const { log } = await import("../server/log");
      log.error("agent.observability.detail_failed", {
        org_id: context.orgId,
        agent: data.agentType,
        error: e as Error,
      });
      throw new Error(
        e instanceof Error && e.message === "Unknown agent."
          ? e.message
          : "Agent detail could not be loaded. The error has been logged.",
      );
    }
  });

async function buildDetail(org: string, agentType: string): Promise<AgentDetail> {
  const { ensureAgentsRegistered } = await import("../server/agents");
  ensureAgentsRegistered();
  const { getAgent, getTool, skillsOf } = await import("../server/agents/registry");
  const def = getAgent(agentType as never);
  if (!def) throw new Error("Unknown agent.");
  const { manifestHash, RUNTIME_RULES } = await import("../server/agents/manifest.server");
  const { HITL_TOOLS } = await import("../server/agents/hitl");
  const { INJECTION_RULES, toolParameters } = await import("./ai-gateway.server");
  const { HARNESS_LIMITS } = await import("../server/agents/runtime.server");
  const { loadPolicy } = await import("../server/agents/policy");
  const { RULES } = await import("../server/agents/health.server");

  const policy = await loadPolicy(org, def.type);
  const versions = await q(sql`
    select d.version, d.hash, d.created_at,
      (select count(*) from agent_runs r where r.org_id = ${org} and r.definition_id = d.id)::int runs
    from agent_definitions d where d.agent_type = ${def.type} order by d.created_at desc limit 20`);

  const toolRows = await q(sql`
    select st.tool_name tool,
      count(*) filter (where st.status in ('ok','error'))::int calls,
      count(*) filter (where st.status = 'error')::int errors,
      count(*) filter (where st.status = 'awaiting')::int awaiting,
      round(avg(st.duration_ms) filter (where st.status in ('ok','error')))::int avg_ms,
      max(st.created_at) last_used
    from agent_steps st join agent_runs r on r.id = st.run_id
    where st.org_id = ${org} and r.agent_type = ${def.type} and st.kind = 'tool'
      and st.created_at >= now() - interval '7 days'
    group by st.tool_name`);
  const lastErrors = await q(sql`
    select distinct on (st.tool_name) st.tool_name tool, st.output ->> 'error' err
    from agent_steps st join agent_runs r on r.id = st.run_id
    where st.org_id = ${org} and r.agent_type = ${def.type} and st.kind = 'tool' and st.status = 'error'
    order by st.tool_name, st.created_at desc`);

  const skillRows = await q(sql`
    select u.feature, count(*)::int requests, count(*) filter (where u.status = 'error')::int errors,
      coalesce(sum(u.total_tokens), 0)::bigint tokens, round(avg(u.duration_ms))::int avg_ms,
      percentile_cont(0.95) within group (order by u.duration_ms)::int p95
    from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
    where r.org_id = ${org} and r.agent_type = ${def.type} and u.created_at >= now() - interval '7 days'
    group by u.feature`);

  const runs = await q(sql`
    select id, status, goal, step_count, tokens_used, definition_version, created_at, last_error,
      round((extract(epoch from (finished_at - started_at)) / 60)::numeric, 1) dur
    from agent_runs where org_id = ${org} and agent_type = ${def.type}
    order by created_at desc limit 15`);

  const openTasks = await q(sql`
    select t.id, t.kind, t.title, coalesce(t.assignee_role, 'named person') assignee,
      floor(extract(epoch from (now() - t.created_at)) / 3600)::int age
    from agent_tasks t join agent_runs r on r.id = t.run_id
    where t.org_id = ${org} and r.agent_type = ${def.type} and t.status = 'open'
    order by t.created_at limit 50`);
  const recentTasks = await q(sql`
    select t.id, t.kind, t.title, t.status, m.email decided_by, t.decided_at,
      round(extract(epoch from (t.decided_at - t.created_at)) / 60)::int wait,
      (t.status = 'approved' and t.response ? 'args') edited
    from agent_tasks t join agent_runs r on r.id = t.run_id
    left join org_members m on m.user_id = t.decided_by and m.org_id = t.org_id
    where t.org_id = ${org} and r.agent_type = ${def.type} and t.status not in ('open')
    order by t.decided_at desc nulls last limit 20`);

  const audit = await q(sql`
    select action, actor, entity_type, created_at from audit_log
    where org_id = ${org} and actor like ${`agent:${def.type}:%`}
    order by created_at desc limit 30`);

  const issueRows = await db
    .select()
    .from(agentIssues)
    .where(and(eq(agentIssues.orgId, org), eq(agentIssues.agentType, def.type)));
  const ruleText = new Map(RULES.map((r) => [r.id, r.description]));

  return {
    identity: {
      type: def.type,
      name: def.name,
      version: def.version,
      hash: manifestHash(def),
      owner: def.owner,
      riskTier: def.riskTier,
      responsibility: def.responsibility,
      mustNever: def.mustNever,
      scope: def.scope,
      gates: def.gates,
      feature: def.feature,
      versions: versions.map((v) => ({
        version: String(v["version"]),
        hash: String(v["hash"]),
        firstSeen: new Date(String(v["created_at"])).toISOString(),
        runs: n(v["runs"]),
      })),
      policy: {
        enabled: policy.enabled,
        autonomy: policy.autonomy,
        whitelistedTemplates: policy.whitelistedTemplates,
        monthlyTokenBudget: policy.monthlyTokenBudget,
      },
    },
    tools: def.tools.map((name) => {
      const t = getTool(name);
      const u = toolRows.find((r) => r["tool"] === name) ?? {};
      return {
        name,
        description: t?.description ?? "(not registered)",
        risk: t?.risk ?? "unknown",
        skills: t?.skills ?? [],
        preApprovable: Boolean(t?.templateOf),
        untrustedOutput: Boolean(t?.untrustedOutput),
        inputSchemaJson: t ? JSON.stringify(toolParameters(t.input), null, 2) : "{}",
        calls7d: n(u["calls"]),
        errors7d: n(u["errors"]),
        avgMs: nOrNull(u["avg_ms"]),
        awaitingApproval7d: n(u["awaiting"]),
        lastError:
          (lastErrors.find((e) => e["tool"] === name)?.["err"] as string | undefined) ?? null,
        lastUsedAt: u["last_used"] ? new Date(String(u["last_used"])).toISOString() : null,
      };
    }),
    skills: skillsOf(def).map((feature) => {
      const r = skillRows.find((x) => x["feature"] === feature) ?? {};
      return {
        feature,
        usedBy:
          feature === def.feature
            ? ["the agent's own reasoning turns"]
            : def.tools.filter((name) => getTool(name)?.skills?.includes(feature)),
        requests7d: n(r["requests"]),
        errors7d: n(r["errors"]),
        tokens7d: n(r["tokens"]),
        avgMs: nOrNull(r["avg_ms"]),
        p95Ms: nOrNull(r["p95"]),
      };
    }),
    harness: {
      maxSteps: def.maxSteps ?? 20,
      maxTokensPerRun: HARNESS_LIMITS.maxTokensPerRun,
      turnsPerTick: HARNESS_LIMITS.turnsPerTick,
      leaseMinutes: HARNESS_LIMITS.leaseMinutes,
      maxAttempts: HARNESS_LIMITS.maxAttempts,
      concurrency: HARNESS_LIMITS.concurrency,
      budgetRecheckMinutes: HARNESS_LIMITS.budgetRecheckMinutes,
      autonomyRules: [
        { risk: "read", suggest: "runs", act_and_notify: "runs", autonomous: "runs" },
        { risk: "write", suggest: "asks a person", act_and_notify: "runs", autonomous: "runs" },
        {
          risk: "external",
          suggest: "asks a person",
          act_and_notify: "asks unless the template is pre-approved",
          autonomous: "asks unless the template is pre-approved",
        },
      ],
      humanTools: Object.entries(HITL_TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
      })),
      sharedRules: RUNTIME_RULES,
      injectionRules: INJECTION_RULES,
      instructions: def.system,
      recentRuns: runs.map((r) => {
        const err = r["last_error"] as string | null;
        return {
          id: String(r["id"]),
          status: String(r["status"]),
          goal: String(r["goal"]).slice(0, 200),
          steps: n(r["step_count"]),
          tokens: n(r["tokens_used"]),
          definitionVersion: (r["definition_version"] as string | null) ?? null,
          createdAt: new Date(String(r["created_at"])).toISOString(),
          durationMinutes: nOrNull(r["dur"]),
          error: err
            ? SAFE_ERRORS.has(err)
              ? err
              : "The agent could not complete this step."
            : null,
        };
      }),
    },
    hitl: {
      open: openTasks.map((t) => ({
        id: String(t["id"]),
        kind: String(t["kind"]),
        title: String(t["title"]),
        assignee: String(t["assignee"]),
        ageHours: n(t["age"]),
      })),
      recent: recentTasks.map((t) => ({
        id: String(t["id"]),
        kind: String(t["kind"]),
        title: String(t["title"]),
        status: String(t["status"]),
        decidedBy: (t["decided_by"] as string | null) ?? null,
        waitMinutes: nOrNull(t["wait"]),
        edited: Boolean(t["edited"]),
        decidedAt: t["decided_at"] ? new Date(String(t["decided_at"])).toISOString() : null,
      })),
    },
    evals: def.evals.map((name) => ({ name })),
    audit: audit.map((a) => ({
      action: String(a["action"]),
      actor: String(a["actor"]),
      entityType: (a["entity_type"] as string | null) ?? null,
      at: new Date(String(a["created_at"])).toISOString(),
    })),
    issues: {
      open: issueRows
        .filter((i) => i.status !== "resolved")
        .map((i) => ({
          id: i.id,
          agentType: i.agentType,
          element: i.element,
          rule: i.rule,
          severity: i.severity,
          status: i.status as "open" | "acknowledged",
          title: i.title,
          description: ruleText.get(i.rule) ?? "",
          firstSeenAt: i.firstSeenAt.toISOString(),
          lastSeenAt: i.lastSeenAt.toISOString(),
          occurrences: i.occurrences,
        })),
      resolved: issueRows
        .filter((i) => i.status === "resolved" && i.resolvedAt)
        .sort((a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime())
        .slice(0, 10)
        .map((i) => ({
          rule: i.rule,
          title: i.title,
          severity: i.severity,
          firstSeenAt: i.firstSeenAt.toISOString(),
          resolvedAt: i.resolvedAt!.toISOString(),
        })),
    },
  };
}
