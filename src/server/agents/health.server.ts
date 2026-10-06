/**
 * Agent health engine (docs/agentic-plan.md §9.3).
 *
 * A fixed set of rules, each tied to one element of the agent architecture
 * (harness, human-in-the-loop, tools, skills, budget, orchestrator,
 * definition, audit). Every few minutes the scheduler evaluates them per
 * organisation: a firing rule opens (or re-sees) an issue; a rule that stops
 * firing resolves it. Openings and resolutions are audited; serious and
 * critical issues reach HR leadership through the notification bell.
 *
 * Thresholds are explicit constants so every issue is explainable.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "../db";
import { agentIssues, agentRuntimeHeartbeat, type AgentIssueSeverity } from "@db/schema";
import { writeAudit } from "../audit";
import { log } from "../log";

/* ------------------------------------------------------------- thresholds */

export const HEALTH = {
  /** Human request open longer than this is overdue (hours). */
  hitlSlaHours: 48,
  /** …and serious after this many hours. */
  hitlSeriousHours: 120,
  /** A running run whose lease expired this long ago is stuck (minutes). */
  stuckLeaseMinutes: 15,
  /** Failed runs per agent in 24 h that trip the failure rule. */
  failedRuns24h: 3,
  /** Tool error rate over 24 h (with at least `minToolCalls`). */
  toolErrorRate: 0.2,
  minToolCalls: 10,
  /** AI request error rate over 24 h (with at least `minAiRequests`). */
  aiErrorRate: 0.2,
  minAiRequests: 5,
  /** AI p95 latency over 24 h (ms). */
  aiP95Ms: 60_000,
  /** Human decline rate over 7 days (with at least `minDecisions`). */
  declineRate: 0.5,
  minDecisions: 6,
  /** Definition changes in 7 days. */
  definitionChanges7d: 3,
  /** Pending orchestrator events older than this (minutes). */
  eventBacklogMinutes: 15,
  /** Scheduler considered stopped after this many minutes without a tick. */
  heartbeatMinutes: 5,
  /** Suspected prompt injections in tool results over 24 h: warning from 1, serious from this many. */
  injectionSerious24h: 3,
  /** Re-evaluate at most this often (minutes). */
  evaluateEveryMinutes: 5,
} as const;

export type HealthElement =
  "harness" | "hitl" | "tools" | "skills" | "budget" | "orchestrator" | "definition" | "audit";

type Finding = {
  agentType: string;
  title: string;
  detail: Record<string, unknown>;
  severity?: AgentIssueSeverity;
};

type Rule = {
  id: string;
  element: HealthElement;
  severity: AgentIssueSeverity;
  /** Plain-language description shown in the observability page. */
  description: string;
  evaluate: (orgId: string) => Promise<Finding[]>;
};

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

/* ------------------------------------------------------------------ rules */

export const RULES: Rule[] = [
  {
    id: "harness.stuck_run",
    element: "harness",
    severity: "critical",
    description: `A run is still marked running ${HEALTH.stuckLeaseMinutes} minutes after its worker lease expired, or was reclaimed twice.`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number }>(sql`
        select agent_type, count(*)::int n from agent_runs
        where org_id = ${orgId}
          and ((status = 'running' and lease_until < now() - make_interval(mins => ${HEALTH.stuckLeaseMinutes}))
            or (status in ('queued','running') and attempts >= 2))
        group by agent_type`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `${x.n} run(s) stuck or repeatedly reclaimed`,
        detail: { runs: x.n },
      }));
    },
  },
  {
    id: "harness.failures",
    element: "harness",
    severity: "serious",
    description: `${HEALTH.failedRuns24h} or more runs of one agent stopped with a failure in the last 24 hours.`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number; budget: number }>(sql`
        select agent_type, count(*)::int n,
          count(*) filter (where last_error like '%step or token budget%')::int budget
        from agent_runs
        where org_id = ${orgId} and status = 'failed' and mode = 'live'
          and finished_at >= now() - interval '24 hours'
        group by agent_type having count(*) >= ${HEALTH.failedRuns24h}`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `${x.n} failed runs in 24 h${x.budget ? ` (${x.budget} hit the step/token limit)` : ""}`,
        detail: { failed: x.n, stepOrTokenLimit: x.budget },
      }));
    },
  },
  {
    id: "budget.paused",
    element: "budget",
    severity: "warning",
    description: "Runs are paused because the agent reached its monthly token budget.",
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number }>(sql`
        select agent_type, count(*)::int n from agent_runs
        where org_id = ${orgId} and status = 'queued'
          and last_error = 'Paused: this agent reached its monthly token budget.'
        group by agent_type`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `${x.n} run(s) paused at the monthly token budget`,
        detail: { paused: x.n },
      }));
    },
  },
  {
    id: "hitl.overdue",
    element: "hitl",
    severity: "warning",
    description: `A request for a person's decision or answer has been open longer than ${HEALTH.hitlSlaHours} hours (serious after ${HEALTH.hitlSeriousHours} hours).`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number; oldest_h: number }>(sql`
        select r.agent_type, count(*)::int n,
          floor(max(extract(epoch from (now() - t.created_at)) / 3600))::int oldest_h
        from agent_tasks t join agent_runs r on r.id = t.run_id
        where t.org_id = ${orgId} and t.status = 'open'
          and t.created_at < now() - make_interval(hours => ${HEALTH.hitlSlaHours})
        group by r.agent_type`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `${x.n} request(s) waiting on a person past the ${HEALTH.hitlSlaHours} h SLA (oldest ${x.oldest_h} h)`,
        detail: { overdue: x.n, oldestHours: x.oldest_h },
        severity: x.oldest_h >= HEALTH.hitlSeriousHours ? "serious" : "warning",
      }));
    },
  },
  {
    id: "hitl.decline_rate",
    element: "hitl",
    severity: "warning",
    description: `People declined more than ${HEALTH.declineRate * 100}% of an agent's requests over 7 days — its proposals may not fit how the team works.`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; decided: number; declined: number }>(sql`
        select r.agent_type, count(*)::int decided,
          count(*) filter (where t.status = 'rejected')::int declined
        from agent_tasks t join agent_runs r on r.id = t.run_id
        where t.org_id = ${orgId} and t.decided_at >= now() - interval '7 days'
          and t.status in ('approved','rejected','answered')
        group by r.agent_type having count(*) >= ${HEALTH.minDecisions}`);
      return r
        .filter((x) => x.declined / x.decided > HEALTH.declineRate)
        .map((x) => ({
          agentType: x.agent_type,
          title: `${Math.round((x.declined / x.decided) * 100)}% of ${x.decided} requests declined in 7 days`,
          detail: { decided: x.decided, declined: x.declined },
        }));
    },
  },
  {
    id: "tools.error_rate",
    element: "tools",
    severity: "serious",
    description: `More than ${HEALTH.toolErrorRate * 100}% of an agent's tool calls failed in 24 hours.`,
    evaluate: async (orgId) => {
      const r = await rows<{
        agent_type: string;
        calls: number;
        errors: number;
        top: string | null;
      }>(sql`
        with s as (
          select r.agent_type, st.tool_name, st.status
          from agent_steps st join agent_runs r on r.id = st.run_id
          where st.org_id = ${orgId} and st.kind = 'tool' and st.status in ('ok','error')
            and st.created_at >= now() - interval '24 hours'
        )
        select agent_type, count(*)::int calls,
          count(*) filter (where status = 'error')::int errors,
          (select tool_name from s s2 where s2.agent_type = s.agent_type and s2.status = 'error'
            group by tool_name order by count(*) desc limit 1) top
        from s group by agent_type having count(*) >= ${HEALTH.minToolCalls}`);
      return r
        .filter((x) => x.errors / x.calls > HEALTH.toolErrorRate)
        .map((x) => ({
          agentType: x.agent_type,
          title: `${x.errors} of ${x.calls} tool calls failed in 24 h${x.top ? ` (mostly ${x.top})` : ""}`,
          detail: { calls: x.calls, errors: x.errors, topFailingTool: x.top },
        }));
    },
  },
  {
    id: "tools.injection",
    element: "tools",
    severity: "warning",
    description: `Third-party text (CV, mail, document) returned by a tool looked like instructions to the model in the last 24 hours (serious from ${HEALTH.injectionSerious24h}). The text stays fenced as data; review the runs.`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number; runs: number }>(sql`
        select r.agent_type, count(*)::int n, count(distinct st.run_id)::int runs
        from agent_steps st join agent_runs r on r.id = st.run_id
        where st.org_id = ${orgId} and st.injection_suspected
          and st.created_at >= now() - interval '24 hours'
        group by r.agent_type`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `${x.n} suspected prompt injection(s) in tool results across ${x.runs} run(s) in 24 h`,
        detail: { detections: x.n, runs: x.runs },
        severity: x.n >= HEALTH.injectionSerious24h ? ("serious" as const) : ("warning" as const),
      }));
    },
  },
  {
    id: "skills.ai_errors",
    element: "skills",
    severity: "serious",
    description: `More than ${HEALTH.aiErrorRate * 100}% of AI requests made inside an agent's runs failed in 24 hours (key, quota or provider problems).`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number; errors: number }>(sql`
        select r.agent_type, count(*)::int n, count(*) filter (where u.status = 'error')::int errors
        from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
        where r.org_id = ${orgId} and u.created_at >= now() - interval '24 hours'
        group by r.agent_type having count(*) >= ${HEALTH.minAiRequests}`);
      return r
        .filter((x) => x.errors / x.n > HEALTH.aiErrorRate)
        .map((x) => ({
          agentType: x.agent_type,
          title: `${x.errors} of ${x.n} AI requests failed in 24 h`,
          detail: { requests: x.n, errors: x.errors },
        }));
    },
  },
  {
    id: "skills.latency",
    element: "skills",
    severity: "warning",
    description: `AI requests inside an agent's runs are slow: 95th percentile above ${HEALTH.aiP95Ms / 1000} s over 24 hours.`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; p95: number }>(sql`
        select r.agent_type, percentile_cont(0.95) within group (order by u.duration_ms)::int p95
        from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
        where r.org_id = ${orgId} and u.created_at >= now() - interval '24 hours'
          and u.duration_ms is not null
        group by r.agent_type having count(*) >= ${HEALTH.minAiRequests}`);
      return r
        .filter((x) => x.p95 > HEALTH.aiP95Ms)
        .map((x) => ({
          agentType: x.agent_type,
          title: `AI p95 latency ${Math.round(x.p95 / 1000)} s over 24 h`,
          detail: { p95Ms: x.p95 },
        }));
    },
  },
  {
    id: "definition.churn",
    element: "definition",
    severity: "warning",
    description: `An agent's definition changed under running work ${HEALTH.definitionChanges7d} or more times in 7 days.`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number }>(sql`
        select split_part(actor, ':', 2) agent_type, count(*)::int n from audit_log
        where org_id = ${orgId} and action = 'agent.run.definition_changed'
          and created_at >= now() - interval '7 days'
        group by 1 having count(*) >= ${HEALTH.definitionChanges7d}`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `Definition changed under ${x.n} running run(s) in 7 days`,
        detail: { changes: x.n },
      }));
    },
  },
  {
    id: "audit.gap",
    element: "audit",
    severity: "critical",
    description:
      "A write or external tool call completed in the last 24 hours without its audit_log entry — the audit trail is incomplete.",
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number }>(sql`
        select r.agent_type, count(*)::int n
        from agent_steps st join agent_runs r on r.id = st.run_id
        where st.org_id = ${orgId} and st.kind = 'tool' and st.status = 'ok'
          and st.created_at >= now() - interval '24 hours'
          and st.created_at < now() - interval '2 minutes'
          and st.tool_name not in ('ask_human', 'request_approval', 'handoff')
          and exists (
            select 1 from audit_log a0 where a0.entity_id = r.id and a0.action = 'agent.run.started'
          )
          and not exists (
            select 1 from audit_log a
            where a.entity_id = r.id and a.action = 'agent.tool.' || st.tool_name
          )
          and coalesce((
            select d.manifest from agent_definitions d where d.id = r.definition_id
          ) -> 'tools', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('name', st.tool_name))
          and not (coalesce((
            select d.manifest from agent_definitions d where d.id = r.definition_id
          ) -> 'tools', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('name', st.tool_name, 'risk', 'read')))
        group by r.agent_type`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `${x.n} change(s) made without an audit entry`,
        detail: { unaudited: x.n },
      }));
    },
  },
  {
    id: "orchestrator.events",
    element: "orchestrator",
    severity: "serious",
    description: `Lifecycle events failed to process, or have waited more than ${HEALTH.eventBacklogMinutes} minutes — agents may not start when they should.`,
    evaluate: async (orgId) => {
      const r = await rows<{ failed: number; stale: number }>(sql`
        select count(*) filter (where status = 'failed' and updated_at >= now() - interval '24 hours')::int failed,
          count(*) filter (where status = 'pending' and created_at < now() - make_interval(mins => ${HEALTH.eventBacklogMinutes}))::int stale
        from agent_events where org_id = ${orgId}`);
      const x = r[0];
      if (!x || (!x.failed && !x.stale)) return [];
      return [
        {
          agentType: "*",
          title: `${x.failed} failed and ${x.stale} stale lifecycle event(s)`,
          detail: { failed: x.failed, stale: x.stale },
        },
      ];
    },
  },
];

/* -------------------------------------------------------------- evaluation */

/** Organisations worth checking: any agent switched on, or agent activity in 30 days. */
async function orgsToCheck(orgId?: string): Promise<string[]> {
  if (orgId) return [orgId];
  const r = await rows<{ org_id: string }>(sql`
    select org_id from agent_policies where enabled
    union select org_id from agent_runs where created_at >= now() - interval '30 days'`);
  return r.map((x) => x.org_id);
}

export type HealthCounts = { orgs: number; opened: number; resolved: number; seen: number };

export async function evaluateAgentHealth(opts: { orgId?: string } = {}): Promise<HealthCounts> {
  const counts: HealthCounts = { orgs: 0, opened: 0, resolved: 0, seen: 0 };
  for (const orgId of await orgsToCheck(opts.orgId)) {
    counts.orgs++;
    const active = await db
      .select()
      .from(agentIssues)
      .where(and(eq(agentIssues.orgId, orgId), ne(agentIssues.status, "resolved")));
    const firing = new Set<string>();
    for (const rule of RULES) {
      let findings: Finding[] = [];
      try {
        findings = await rule.evaluate(orgId);
      } catch (e) {
        log.error("agent.health.rule_failed", { org_id: orgId, rule: rule.id, error: e as Error });
        // Keep current issues for a rule that could not be evaluated.
        for (const a of active.filter((x) => x.rule === rule.id)) firing.add(a.id);
        continue;
      }
      for (const f of findings) {
        const severity = f.severity ?? rule.severity;
        const existing = active.find((a) => a.rule === rule.id && a.agentType === f.agentType);
        if (existing) {
          firing.add(existing.id);
          counts.seen++;
          await db
            .update(agentIssues)
            .set({
              title: f.title,
              detail: f.detail,
              severity,
              lastSeenAt: new Date(),
              occurrences: sql`${agentIssues.occurrences} + 1`,
            })
            .where(eq(agentIssues.id, existing.id));
          continue;
        }
        const [row] = await db
          .insert(agentIssues)
          .values({
            orgId,
            agentType: f.agentType,
            element: rule.element,
            rule: rule.id,
            severity,
            title: f.title,
            detail: f.detail,
          })
          .onConflictDoNothing()
          .returning({ id: agentIssues.id });
        if (!row) continue;
        firing.add(row.id);
        counts.opened++;
        await writeAudit({
          actor: "system:agent-health",
          orgId,
          action: "agent.issue.opened",
          entityType: "agent_issue",
          entityId: row.id,
          detail: {
            rule: rule.id,
            element: rule.element,
            agent: f.agentType,
            severity,
            title: f.title,
          },
        });
      }
    }
    const cleared = active.filter((a) => !firing.has(a.id));
    if (cleared.length) {
      await db
        .update(agentIssues)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(
          inArray(
            agentIssues.id,
            cleared.map((c) => c.id),
          ),
        );
      for (const c of cleared) {
        counts.resolved++;
        await writeAudit({
          actor: "system:agent-health",
          orgId,
          action: "agent.issue.resolved",
          entityType: "agent_issue",
          entityId: c.id,
          detail: { rule: c.rule, agent: c.agentType },
        });
      }
    }
  }
  return counts;
}

/* --------------------------------------------------------------- heartbeat */

const HEARTBEAT_ID = "agents";

/** Called by every scheduler tick; runs the health engine at most every few minutes. */
export async function heartbeatAndMaybeEvaluate(
  tickCounts: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const [hb] = await db
    .insert(agentRuntimeHeartbeat)
    .values({ id: HEARTBEAT_ID, lastTickAt: now, lastCounts: tickCounts })
    .onConflictDoUpdate({
      target: agentRuntimeHeartbeat.id,
      set: { lastTickAt: now, lastCounts: tickCounts },
    })
    .returning({ lastHealthAt: agentRuntimeHeartbeat.lastHealthAt });
  const due =
    !hb?.lastHealthAt ||
    now.getTime() - hb.lastHealthAt.getTime() >= HEALTH.evaluateEveryMinutes * 60_000;
  if (!due) return;
  await db
    .update(agentRuntimeHeartbeat)
    .set({ lastHealthAt: now })
    .where(eq(agentRuntimeHeartbeat.id, HEARTBEAT_ID));
  const c = await evaluateAgentHealth();
  if (c.opened || c.resolved) log.info("agent.health", c);
  // Push channels (e-mail, webhook) for newly opened serious / critical issues.
  const { dispatchAgentAlerts } = await import("./alerts.server");
  const a = await dispatchAgentAlerts();
  if (a.alerted) log.info("agent.alerts", a);
}

/** Scheduler liveness for the observability page (a stopped scheduler can't report itself). */
export async function schedulerStatus(): Promise<{
  lastTickAt: string | null;
  lastHealthAt: string | null;
  minutesSinceTick: number | null;
  healthy: boolean;
}> {
  const [hb] = await db
    .select()
    .from(agentRuntimeHeartbeat)
    .where(eq(agentRuntimeHeartbeat.id, HEARTBEAT_ID))
    .limit(1);
  const minutes = hb?.lastTickAt
    ? Math.floor((Date.now() - hb.lastTickAt.getTime()) / 60_000)
    : null;
  return {
    lastTickAt: hb?.lastTickAt?.toISOString() ?? null,
    lastHealthAt: hb?.lastHealthAt?.toISOString() ?? null,
    minutesSinceTick: minutes,
    healthy: minutes != null && minutes <= HEALTH.heartbeatMinutes,
  };
}
