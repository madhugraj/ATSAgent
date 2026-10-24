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
import { sourceLabel } from "@/lib/job-channels";
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
  /** Sourcing runs in 7 days on one role that added and invited nobody before it counts as exhausted. */
  sourcingFruitlessRuns: 2,
  /** Interview-time offers answered with "none work" or left to expire, in 7 days… */
  slotOffersUnanswered7d: 3,
  /** …and as a share of all offers that closed. */
  slotOffersUnansweredShare: 0.5,
  /** Rounds the candidate did not join, in 7 days, before it is flagged. */
  interviewNoShows7d: 3,
  /** An open offer on its this-many-th revision is going back and forth. */
  offerRevisions: 3,
  /** A pay discussion waiting on a person (suggested figure, call asked for) this many days. */
  negotiationWaitDays: 2,
  /** A portal listing live this many days without one CV from it (Distribution agent on). */
  quietListingDays: 14,
  /** Role-limited CVs still kept this many days after they became due for erasure. */
  roleLimitedOverdueDays: 7,
  /** One run asking people this many questions (7 days) is going round in circles. */
  questionsPerRun: 3,
  /** Phone screening: a call still not placed this many hours after it was due. */
  callOverdueHours: 3,
  /** …a call still dialling / in progress this many minutes later (the worker stopped). */
  callStuckMinutes: 45,
  /** …calls that could not be placed (line or AI voice errors) in 24 h. */
  callFailures24h: 3,
  /** …with at least this many call attempts in 7 days, a pick-up share below this… */
  minCalls7d: 5,
  callAnswerShare: 0.4,
  /** …and of the answered calls, a decline share at or above this. */
  callDeclineShare: 0.5,
  /** …answered calls that ended before any question was answered, in 7 days. */
  shortCalls7d: 3,
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
    id: "harness.run_limits",
    element: "harness",
    severity: "warning",
    description:
      "A run stopped on its step or token limit in the last 7 days and nothing has picked its work up since — the role or candidate it was working on is waiting. Raise the agent's run limits in Agent settings and try it again; if it stopped at the overall ceiling, check its steps first (it may be going round in circles).",
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; n: number; ceiling: number }>(sql`
        select f.agent_type, count(*)::int n,
          count(*) filter (where f.last_error like '%overall step or token ceiling%')::int ceiling
        from agent_runs f
        where f.org_id = ${orgId} and f.status = 'failed' and f.mode = 'live'
          and f.last_error like '%step or token%'
          and f.finished_at >= now() - interval '7 days'
          and not exists (
            select 1 from agent_runs later
            where later.org_id = f.org_id and later.agent_type = f.agent_type
              and later.subject_id is not distinct from f.subject_id
              and later.created_at > f.created_at
              and later.status in ('queued','running','awaiting_human','done'))
        group by f.agent_type`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `${x.n} ${x.n === 1 ? "run" : "runs"} stopped on ${x.n === 1 ? "its" : "their"} limits, with the work still waiting${x.ceiling ? ` (${x.ceiling} at the overall ceiling)` : ""}`,
        detail: { runs: x.n, atCeiling: x.ceiling },
        ...(x.ceiling ? { severity: "serious" as const } : {}),
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
          -- Refusals (a rule said no) are guardrails working, not failures.
          select r.agent_type, st.tool_name, st.status,
            coalesce(st.output ->> 'refused', 'false') = 'true' refused
          from agent_steps st join agent_runs r on r.id = st.run_id
          where st.org_id = ${orgId} and st.kind = 'tool' and st.status in ('ok','error')
            and st.created_at >= now() - interval '24 hours'
        )
        select agent_type, count(*)::int calls,
          count(*) filter (where status = 'error' and coalesce(refused, false) = false)::int errors,
          (select tool_name from s s2 where s2.agent_type = s.agent_type and s2.status = 'error'
            and not s2.refused group by tool_name order by count(*) desc limit 1) top
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
    id: "sourcing.no_supply",
    element: "tools",
    severity: "warning",
    description: `The Sourcing agent ran ${HEALTH.sourcingFruitlessRuns}+ times in 7 days on a role and found nobody to add or invite — the talent pool and past candidates are exhausted for it. Publish it more widely or revisit its must-haves.`,
    evaluate: async (orgId) => {
      const r = await rows<{ code: string; runs: number }>(sql`
        select q.code, count(*)::int runs
        from agent_runs r join requisitions q on q.id = r.subject_id
        where r.org_id = ${orgId} and r.agent_type = 'sourcing' and r.mode = 'live'
          and r.status = 'done' and r.created_at >= now() - interval '7 days'
          and q.status = 'approved'
          and not exists (
            select 1 from agent_steps s where s.run_id = r.id and s.kind = 'tool' and s.status = 'ok'
              and s.tool_name in ('add_to_pipeline', 'invite_to_apply')
          )
        group by q.code having count(*) >= ${HEALTH.sourcingFruitlessRuns}
        order by count(*) desc`);
      if (!r.length) return [];
      return [
        {
          agentType: "sourcing",
          title: `Sourcing found nobody for ${r.length} role(s): ${r
            .slice(0, 5)
            .map((x) => `${x.code} (${x.runs} runs)`)
            .join(", ")}`,
          detail: { roles: r.length, codes: r.slice(0, 5).map((x) => x.code) },
        },
      ];
    },
  },
  {
    id: "distribution.quiet_listing",
    element: "tools",
    severity: "warning",
    description: `A role has been live on a job portal for ${HEALTH.quietListingDays}+ days without a single CV from it — nobody is bringing that portal's applications in (export or download them and upload them with the portal as the source), or the portal is not working for this role and the listing should come down.`,
    evaluate: async (orgId) => {
      const r = await rows<{ code: string; provider: string }>(sql`
        select q.code, p.provider
        from requisition_board_postings p
        join requisitions q on q.id = p.requisition_id and q.org_id = p.org_id
        where p.org_id = ${orgId} and p.status = 'published' and q.status = 'approved'
          and p.provider <> 'google_jobs'
          and p.published_at <= now() - make_interval(days => ${HEALTH.quietListingDays})
          and exists (select 1 from agent_policies ap where ap.org_id = ${orgId}
            and ap.agent_type = 'distribution' and ap.enabled)
          and not exists (select 1 from applications a
            where a.requisition_id = q.id and a.source = p.provider)
        order by p.published_at
        limit 20`);
      if (!r.length) return [];
      return [
        {
          agentType: "distribution",
          title: `${r.length} listing(s) brought no CVs in ${HEALTH.quietListingDays} days: ${r
            .slice(0, 5)
            .map((x) => `${x.code} on ${sourceLabel(x.provider)}`)
            .join(", ")}`,
          detail: { listings: r.length, sample: r.slice(0, 5) },
        },
      ];
    },
  },
  {
    id: "distribution.role_limited_retention",
    element: "audit",
    severity: "serious",
    description: `CVs a portal's terms limit to the role they were for are still kept ${HEALTH.roleLimitedOverdueDays}+ days after they became due for erasure. The HR head should approve the Distribution agent's erasure request (or erase them from the talent pool).`,
    evaluate: async (orgId) => {
      const { overdueRestricted } = await import("./distribution-agent.server");
      const n = await overdueRestricted(orgId, HEALTH.roleLimitedOverdueDays);
      if (!n) return [];
      return [
        {
          agentType: "distribution",
          title: `${n} role-limited CV(s) overdue for erasure`,
          detail: { overdue: n },
        },
      ];
    },
  },
  {
    id: "interview.slots_unanswered",
    element: "hitl",
    severity: "warning",
    description: `Candidates did not pick any of the offered interview times (they said none work, or the link expired) at least ${HEALTH.slotOffersUnanswered7d} times in 7 days and for more than half of the offers — the times offered may not suit candidates, or the emails are not reaching them.`,
    evaluate: async (orgId) => {
      const r = await rows<{ closed: number; missed: number }>(sql`
        select count(*)::int closed,
          count(*) filter (where status in ('declined','expired'))::int missed
        from interview_slot_offers
        where org_id = ${orgId} and status in ('booked','declined','expired')
          and updated_at >= now() - interval '7 days'`);
      const x = r[0];
      if (
        !x ||
        x.missed < HEALTH.slotOffersUnanswered7d ||
        x.missed / x.closed <= HEALTH.slotOffersUnansweredShare
      )
        return [];
      return [
        {
          agentType: "interview",
          title: `${x.missed} of ${x.closed} interview-time offers in 7 days were not taken up`,
          detail: { closed: x.closed, missed: x.missed },
        },
      ];
    },
  },
  {
    id: "interview.no_shows",
    element: "hitl",
    severity: "warning",
    description: `Candidates did not join ${HEALTH.interviewNoShows7d} or more booked interview rounds in 7 days — check that invites and reminders reach them, and that the times suit them.`,
    evaluate: async (orgId) => {
      const r = await rows<{ n: number }>(sql`
        select count(*)::int n from interviews
        where org_id = ${orgId} and status = 'no_show'
          and scheduled_at >= now() - interval '7 days'`);
      const n = r[0]?.n ?? 0;
      if (n < HEALTH.interviewNoShows7d) return [];
      return [
        {
          agentType: "interview",
          title: `${n} interview rounds in 7 days where the candidate did not join`,
          detail: { noShows: n },
        },
      ];
    },
  },
  {
    id: "offer.negotiation_loop",
    element: "hitl",
    severity: "warning",
    description: `An offer is on its ${HEALTH.offerRevisions}rd revision or later and still open — the candidate and the band may not meet; a person should talk to the candidate rather than another revision.`,
    evaluate: async (orgId) => {
      const r = await rows<{ n: number; max_rev: number }>(sql`
        select count(*)::int n, coalesce(max(revision), 0)::int max_rev from offers
        where org_id = ${orgId} and revision >= ${HEALTH.offerRevisions}
          and status in ('draft','pending_hr','pending_cbo','approved','released','countered')`);
      const x = r[0];
      if (!x?.n) return [];
      return [
        {
          agentType: "offer",
          title: `${x.n} offer(s) still open after ${x.max_rev} revisions`,
          detail: { offers: x.n, maxRevision: x.max_rev },
        },
      ];
    },
  },
  {
    id: "offer.pay_unknown",
    element: "hitl",
    severity: "warning",
    description:
      "A candidate between interview and offer let the pay & availability form close unanswered, and their expected CTC or notice period is still unknown — the Offer agent cannot draft, so TA should ask them on a call and enter it on the candidate's page.",
    evaluate: async (orgId) => {
      const r = await rows<{ n: number }>(sql`
        select count(distinct cr.application_id)::int n
        from compensation_requests cr
        join applications a on a.id = cr.application_id and a.org_id = cr.org_id
        join candidates c on c.id = a.candidate_id
        where cr.org_id = ${orgId} and cr.status = 'expired'
          and a.stage in ('l1','l2','l3','offer_pending')
          and not exists (
            select 1 from compensation_requests o
            where o.application_id = cr.application_id and o.status in ('sent','completed')
              and o.created_at > cr.created_at)
          and (
            coalesce(
              (select d.expected_ctc from compensation_details d
               where d.application_id = a.id and d.expected_ctc is not null
               order by d.created_at desc limit 1),
              c.expected_ctc) is null
            or coalesce(
              (select d.notice_period_days from compensation_details d
               where d.application_id = a.id and d.notice_period_days is not null
               order by d.created_at desc limit 1),
              c.notice_period_days) is null)`);
      const n = r[0]?.n ?? 0;
      if (!n) return [];
      return [
        {
          agentType: "offer",
          title: `${n} candidate(s) near an offer never shared their expected pay or notice period`,
          detail: { candidates: n },
        },
      ];
    },
  },
  {
    id: "offer.negotiation_stalled",
    element: "hitl",
    severity: "warning",
    description: `A pay discussion has waited on a person for more than ${HEALTH.negotiationWaitDays} days (the candidate suggested a figure or asked for a call), or it closed without agreement while the candidate is still near an offer — someone should call them or the HR head should decide.`,
    evaluate: async (orgId) => {
      const r = await rows<{ n: number }>(sql`
        select count(distinct n.application_id)::int n
        from offer_negotiations n
        join applications a on a.id = n.application_id and a.org_id = n.org_id
        where n.org_id = ${orgId}
          and a.stage in ('l1','l2','l3','offer_pending')
          and (
            (n.status in ('countered','call_requested','open')
              and n.updated_at < now() - make_interval(days => ${HEALTH.negotiationWaitDays}))
            or (n.status in ('expired','no_agreement')
              and n.updated_at >= now() - interval '14 days'
              and not exists (
                select 1 from offer_negotiations later
                where later.application_id = n.application_id
                  and later.created_at > n.created_at)))`);
      const n = r[0]?.n ?? 0;
      if (!n) return [];
      return [
        {
          agentType: "offer",
          title: `${n} pay ${n === 1 ? "discussion" : "discussions"} waiting on a person or ended without agreement`,
          detail: { candidates: n },
        },
      ];
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
  {
    id: "screening_call.not_placed",
    element: "orchestrator",
    severity: "serious",
    description: `Phone screening calls are still not placed ${HEALTH.callOverdueHours} hours after they were due — the voice worker may not be running, or phone screening is no longer ready (switched off, no AI voice key, no phone line). Candidates wait meanwhile.`,
    evaluate: async (orgId) => {
      const r = await rows<{ n: number }>(sql`
        select count(*)::int n from screening_calls
        where org_id = ${orgId} and status in ('approved', 'callback', 'no_answer', 'failed')
          and due_at < now() - make_interval(hours => ${HEALTH.callOverdueHours})`);
      const n = r[0]?.n ?? 0;
      if (!n) return [];
      return [
        {
          agentType: "screening_call",
          title: `${n} phone screening call${n === 1 ? "" : "s"} overdue by more than ${HEALTH.callOverdueHours} hours`,
          detail: { overdue: n },
        },
      ];
    },
  },
  {
    id: "screening_call.stuck",
    element: "harness",
    severity: "critical",
    description: `A phone screening call has been dialling or in progress for more than ${HEALTH.callStuckMinutes} minutes — longer than any call may last. The voice worker stopped mid-call and has not recovered it.`,
    evaluate: async (orgId) => {
      const r = await rows<{ n: number }>(sql`
        select count(*)::int n from screening_calls
        where org_id = ${orgId} and status in ('dialling', 'in_progress')
          and updated_at < now() - make_interval(mins => ${HEALTH.callStuckMinutes})`);
      const n = r[0]?.n ?? 0;
      if (!n) return [];
      return [
        {
          agentType: "screening_call",
          title: `${n} phone screening call${n === 1 ? "" : "s"} stuck mid-call`,
          detail: { stuck: n },
        },
      ];
    },
  },
  {
    id: "screening_call.failures",
    element: "tools",
    severity: "serious",
    description: `${HEALTH.callFailures24h} or more phone screening calls in 24 hours could not be placed because of the phone line or the AI voice (not because nobody answered). Check the phone line and the organisation's AI voice key.`,
    evaluate: async (orgId) => {
      const r = await rows<{ n: number }>(sql`
        select count(*)::int n from screening_calls
        where org_id = ${orgId} and last_error is not null
          and updated_at >= now() - interval '24 hours'`);
      const n = r[0]?.n ?? 0;
      if (n < HEALTH.callFailures24h) return [];
      return [
        {
          agentType: "screening_call",
          title: `${n} phone screening calls could not be placed in 24 hours`,
          detail: { failed: n },
        },
      ];
    },
  },
  {
    id: "screening_call.answer_rate",
    element: "hitl",
    severity: "warning",
    description: `Fewer than ${Math.round(HEALTH.callAnswerShare * 100)}% of phone screening calls in 7 days were picked up (with at least ${HEALTH.minCalls7d} calls). Candidates may not recognise the number — ask for a recognisable caller ID, or check the calling hours.`,
    evaluate: async (orgId) => {
      const r = await rows<{ total: number; answered: number }>(sql`
        select count(*)::int total, count(*) filter (where started_at is not null)::int answered
        from screening_calls
        where org_id = ${orgId} and attempt > 0 and updated_at >= now() - interval '7 days'
          and status not in ('approved', 'requested', 'dialling', 'in_progress', 'cancelled')`);
      const x = r[0];
      if (!x || x.total < HEALTH.minCalls7d || x.answered / x.total >= HEALTH.callAnswerShare)
        return [];
      return [
        {
          agentType: "screening_call",
          title: `Only ${x.answered} of ${x.total} phone screening calls were picked up in 7 days`,
          detail: x,
        },
      ];
    },
  },
  {
    id: "screening_call.declines",
    element: "hitl",
    severity: "warning",
    description: `Half or more of the candidates who picked up in 7 days declined the AI screening call (with at least ${HEALTH.minCalls7d} answered). Check how the assistant introduces itself, or whether these candidates prefer the written assessment.`,
    evaluate: async (orgId) => {
      const r = await rows<{ answered: number; declined: number }>(sql`
        select count(*)::int answered,
          count(*) filter (where status = 'consent_declined')::int declined
        from screening_calls
        where org_id = ${orgId} and started_at is not null and updated_at >= now() - interval '7 days'`);
      const x = r[0];
      if (!x || x.answered < HEALTH.minCalls7d || x.declined / x.answered < HEALTH.callDeclineShare)
        return [];
      return [
        {
          agentType: "screening_call",
          title: `${x.declined} of ${x.answered} candidates declined the AI screening call in 7 days`,
          detail: x,
        },
      ];
    },
  },
  {
    id: "hitl.repeated_questions",
    element: "hitl",
    severity: "warning",
    description: `A run asked people ${HEALTH.questionsPerRun} or more questions in 7 days — the agent may be going round in circles (asking again instead of acting on the answer or handing off).`,
    evaluate: async (orgId) => {
      const r = await rows<{ agent_type: string; runs: number; most: number }>(sql`
        select r.agent_type, count(*)::int runs, max(q.n)::int most from (
          select run_id, count(*) n from agent_tasks
          where org_id = ${orgId} and kind = 'clarification'
            and created_at >= now() - interval '7 days'
          group by run_id having count(*) >= ${HEALTH.questionsPerRun}) q
        join agent_runs r on r.id = q.run_id
        group by r.agent_type`);
      return r.map((x) => ({
        agentType: x.agent_type,
        title: `${x.runs} run${x.runs === 1 ? "" : "s"} asked people ${x.most} questions or more`,
        detail: { runs: x.runs, mostQuestions: x.most },
      }));
    },
  },
  {
    id: "screening_call.short_calls",
    element: "skills",
    severity: "warning",
    description: `${HEALTH.shortCalls7d} or more phone screening calls in 7 days were picked up and agreed to but ended before any question was answered — the assistant may be ending calls early or failing to hear the candidate.`,
    evaluate: async (orgId) => {
      const r = await rows<{ n: number }>(sql`
        select count(*)::int n from screening_calls
        where org_id = ${orgId} and status = 'completed' and consent_at is not null
          and coalesce(end_reason, '') <> 'not_interested'
          and jsonb_array_length(answers) = 0 and updated_at >= now() - interval '7 days'`);
      const n = r[0]?.n ?? 0;
      if (n < HEALTH.shortCalls7d) return [];
      return [
        {
          agentType: "screening_call",
          title: `${n} screening calls ended before any question was answered`,
          detail: { calls: n },
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
