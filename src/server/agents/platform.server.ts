/**
 * Platform agent console data (docs/agentic-plan.md §9.2, Phase 5): runs,
 * failures, latency and spend of agents across tenants. Served only through
 * src/lib/platform-agents.functions.ts (platform super admins).
 *
 * Aggregates and ids only — no goals, prompts, tool payloads or candidate
 * content cross the tenant boundary. Vendor and model detail is allowed here
 * (§9.4), as on the platform AI-usage console.
 */
import { sql } from "drizzle-orm";

import { db } from "../db";
import { schedulerStatus } from "./health.server";

const n = (v: unknown) => Number(v ?? 0);
const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

export type PlatformAgentConsole = {
  days: number;
  scheduler: { lastTickAt: string | null; minutesSinceTick: number | null; healthy: boolean };
  totals: {
    orgsWithAgents: number;
    runs: number;
    done: number;
    failed: number;
    replays: number;
    openTasks: number;
    openCritical: number;
    openSerious: number;
    tokens: number;
    exportOrgs: number;
    exportErrors: number;
  };
  byOrg: {
    orgId: string;
    name: string;
    agentsOn: number;
    runs: number;
    failed: number;
    openTasks: number;
    openCritical: number;
    openSerious: number;
    tokens: number;
    p95RunSeconds: number | null;
  }[];
  byAgent: {
    agentType: string;
    orgs: number;
    runs: number;
    failed: number;
    avgSteps: number;
    avgTokens: number;
    p50RunSeconds: number | null;
    p95RunSeconds: number | null;
    p50ModelMs: number | null;
    p95ModelMs: number | null;
    toolCalls: number;
    toolErrors: number;
    decided: number;
    edited: number;
    rejected: number;
  }[];
  byModel: {
    provider: string;
    model: string;
    requests: number;
    errors: number;
    tokens: number;
    p50Ms: number | null;
    p95Ms: number | null;
  }[];
  failures: { runId: string; orgName: string; agentType: string; at: string; error: string }[];
};

export async function platformAgentConsoleData(days: 1 | 7 | 30): Promise<PlatformAgentConsole> {
  const since = sql`now() - make_interval(days => ${days}::int)`;

  const sched = await schedulerStatus();

  const [t] = await rows<Record<string, unknown>>(sql`
    select
      (select count(distinct org_id) from agent_policies where enabled and agent_type <> '*')::int orgs_with_agents,
      (select count(*) from agent_runs where created_at >= ${since} and mode = 'live')::int runs,
      (select count(*) from agent_runs where finished_at >= ${since} and status = 'done' and mode = 'live')::int done,
      (select count(*) from agent_runs where finished_at >= ${since} and status = 'failed' and mode = 'live')::int failed,
      (select count(*) from agent_runs where created_at >= ${since} and mode = 'replay')::int replays,
      (select count(*) from agent_tasks where status = 'open')::int open_tasks,
      (select count(*) from agent_issues where status <> 'resolved' and severity = 'critical')::int open_critical,
      (select count(*) from agent_issues where status <> 'resolved' and severity = 'serious')::int open_serious,
      (select coalesce(sum(total_tokens), 0) from ai_usage_events
        where agent_run_id is not null and created_at >= ${since})::bigint tokens,
      (select count(*) from agent_telemetry_settings where otlp_enabled)::int export_orgs,
      (select count(*) from agent_telemetry_settings where otlp_enabled and last_export_error is not null)::int export_errors`);

  const byOrg = await rows<Record<string, unknown>>(sql`
    with o as (
      select org_id from agent_policies where enabled and agent_type <> '*'
      union select org_id from agent_runs where created_at >= ${since}
    )
    select o.org_id, org.name,
      (select count(*) from agent_policies p where p.org_id = o.org_id and p.enabled and p.agent_type <> '*')::int agents_on,
      (select count(*) from agent_runs r where r.org_id = o.org_id and r.created_at >= ${since} and r.mode = 'live')::int runs,
      (select count(*) from agent_runs r where r.org_id = o.org_id and r.finished_at >= ${since} and r.status = 'failed' and r.mode = 'live')::int failed,
      (select count(*) from agent_tasks k where k.org_id = o.org_id and k.status = 'open')::int open_tasks,
      (select count(*) from agent_issues i where i.org_id = o.org_id and i.status <> 'resolved' and i.severity = 'critical')::int open_critical,
      (select count(*) from agent_issues i where i.org_id = o.org_id and i.status <> 'resolved' and i.severity = 'serious')::int open_serious,
      (select coalesce(sum(u.total_tokens), 0) from ai_usage_events u
        where u.org_id = o.org_id and u.agent_run_id is not null and u.created_at >= ${since})::bigint tokens,
      (select percentile_cont(0.95) within group (order by extract(epoch from (r.finished_at - r.started_at)))
        from agent_runs r where r.org_id = o.org_id and r.finished_at >= ${since} and r.started_at is not null) p95_run_s
    from o join organizations org on org.id = o.org_id
    order by runs desc, org.name
    limit 200`);

  const byAgent = await rows<Record<string, unknown>>(sql`
    with r as (
      select * from agent_runs where created_at >= ${since} and mode = 'live'
    ),
    st as (
      select r.agent_type,
        percentile_cont(0.5) within group (order by s.duration_ms) filter (where s.kind = 'model') p50_model,
        percentile_cont(0.95) within group (order by s.duration_ms) filter (where s.kind = 'model') p95_model,
        count(*) filter (where s.kind = 'tool' and s.status in ('ok','error'))::int tool_calls,
        count(*) filter (where s.kind = 'tool' and s.status = 'error')::int tool_errors
      from agent_steps s join r on r.id = s.run_id group by r.agent_type
    ),
    tk as (
      select r.agent_type,
        count(*) filter (where t.status in ('approved','rejected'))::int decided,
        count(*) filter (where t.status = 'approved' and t.response ? 'args')::int edited,
        count(*) filter (where t.status = 'rejected')::int rejected
      from agent_tasks t join r on r.id = t.run_id where t.kind = 'approval' group by r.agent_type
    )
    select r.agent_type, count(distinct r.org_id)::int orgs, count(*)::int runs,
      count(*) filter (where r.status = 'failed')::int failed,
      coalesce(avg(r.step_count), 0)::float avg_steps,
      coalesce(avg(r.tokens_used), 0)::float avg_tokens,
      percentile_cont(0.5) within group (order by extract(epoch from (r.finished_at - r.started_at)))
        filter (where r.finished_at is not null and r.started_at is not null) p50_run_s,
      percentile_cont(0.95) within group (order by extract(epoch from (r.finished_at - r.started_at)))
        filter (where r.finished_at is not null and r.started_at is not null) p95_run_s,
      max(st.p50_model) p50_model, max(st.p95_model) p95_model,
      coalesce(max(st.tool_calls), 0)::int tool_calls, coalesce(max(st.tool_errors), 0)::int tool_errors,
      coalesce(max(tk.decided), 0)::int decided, coalesce(max(tk.edited), 0)::int edited,
      coalesce(max(tk.rejected), 0)::int rejected
    from r left join st using (agent_type) left join tk using (agent_type)
    group by r.agent_type order by runs desc`);

  const byModel = await rows<Record<string, unknown>>(sql`
    select provider, model, count(*)::int requests,
      count(*) filter (where status = 'error')::int errors,
      coalesce(sum(total_tokens), 0)::bigint tokens,
      percentile_cont(0.5) within group (order by duration_ms) p50,
      percentile_cont(0.95) within group (order by duration_ms) p95
    from ai_usage_events
    where agent_run_id is not null and created_at >= ${since}
    group by provider, model order by requests desc limit 50`);

  const failures = await rows<Record<string, unknown>>(sql`
    select r.id, o.name, r.agent_type, r.finished_at, r.last_error
    from agent_runs r join organizations o on o.id = r.org_id
    where r.status = 'failed' and r.mode = 'live' and r.finished_at >= ${since}
    order by r.finished_at desc limit 20`);

  const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return {
    days,
    scheduler: {
      lastTickAt: sched.lastTickAt,
      minutesSinceTick: sched.minutesSinceTick,
      healthy: sched.healthy,
    },
    totals: {
      orgsWithAgents: n(t?.["orgs_with_agents"]),
      runs: n(t?.["runs"]),
      done: n(t?.["done"]),
      failed: n(t?.["failed"]),
      replays: n(t?.["replays"]),
      openTasks: n(t?.["open_tasks"]),
      openCritical: n(t?.["open_critical"]),
      openSerious: n(t?.["open_serious"]),
      tokens: n(t?.["tokens"]),
      exportOrgs: n(t?.["export_orgs"]),
      exportErrors: n(t?.["export_errors"]),
    },
    byOrg: byOrg.map((r) => ({
      orgId: String(r["org_id"]),
      name: String(r["name"]),
      agentsOn: n(r["agents_on"]),
      runs: n(r["runs"]),
      failed: n(r["failed"]),
      openTasks: n(r["open_tasks"]),
      openCritical: n(r["open_critical"]),
      openSerious: n(r["open_serious"]),
      tokens: n(r["tokens"]),
      p95RunSeconds: num(r["p95_run_s"]),
    })),
    byAgent: byAgent.map((r) => ({
      agentType: String(r["agent_type"]),
      orgs: n(r["orgs"]),
      runs: n(r["runs"]),
      failed: n(r["failed"]),
      avgSteps: Math.round(n(r["avg_steps"]) * 10) / 10,
      avgTokens: Math.round(n(r["avg_tokens"])),
      p50RunSeconds: num(r["p50_run_s"]),
      p95RunSeconds: num(r["p95_run_s"]),
      p50ModelMs: num(r["p50_model"]),
      p95ModelMs: num(r["p95_model"]),
      toolCalls: n(r["tool_calls"]),
      toolErrors: n(r["tool_errors"]),
      decided: n(r["decided"]),
      edited: n(r["edited"]),
      rejected: n(r["rejected"]),
    })),
    byModel: byModel.map((r) => ({
      provider: String(r["provider"]),
      model: String(r["model"]),
      requests: n(r["requests"]),
      errors: n(r["errors"]),
      tokens: n(r["tokens"]),
      p50Ms: num(r["p50"]),
      p95Ms: num(r["p95"]),
    })),
    failures: failures.map((r) => ({
      runId: String(r["id"]),
      orgName: String(r["name"]),
      agentType: String(r["agent_type"]),
      at: new Date(String(r["finished_at"])).toISOString(),
      error: String(r["last_error"] ?? "").slice(0, 240),
    })),
  };
}
