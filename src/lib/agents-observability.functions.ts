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
