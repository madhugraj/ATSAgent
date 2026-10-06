/**
 * Agent metrics rollup (docs/agentic-plan.md §9.1): per org × agent × UTC day
 * counts of runs, steps, tool errors, tokens and human-in-the-loop outcomes,
 * upserted into agent_metrics_daily for dashboards and alerts.
 *
 * Recomputes whole days from the source tables, so it is idempotent and
 * self-healing; by default only today and yesterday are refreshed.
 */
import { sql } from "drizzle-orm";

import { db } from "../db";

export async function rollupAgentMetrics(opts: { days?: number } = {}): Promise<number> {
  const days = Math.min(Math.max(opts.days ?? 2, 1), 90);
  const rows = await db.execute(sql`
    with days as (
      select (current_date - g)::date as day
      from generate_series(0, ${days - 1}::int) as g
    ),
    runs as (
      select r.org_id, r.agent_type, d.day,
        count(*) filter (where (r.created_at at time zone 'utc')::date = d.day) as runs_started,
        count(*) filter (where r.status = 'done' and (r.finished_at at time zone 'utc')::date = d.day) as runs_done,
        count(*) filter (where r.status = 'failed' and (r.finished_at at time zone 'utc')::date = d.day) as runs_failed
      from agent_runs r cross join days d
      where r.created_at >= (current_date - ${days}::int)::timestamptz
         or r.finished_at >= (current_date - ${days}::int)::timestamptz
      group by r.org_id, r.agent_type, d.day
      having count(*) filter (where (r.created_at at time zone 'utc')::date = d.day
                                 or (r.finished_at at time zone 'utc')::date = d.day) > 0
    ),
    steps as (
      select s.org_id, r.agent_type, (s.created_at at time zone 'utc')::date as day,
        count(*) as steps,
        count(*) filter (where s.kind = 'tool' and s.status = 'error') as tool_errors,
        coalesce(sum(s.prompt_tokens), 0) as prompt_tokens,
        coalesce(sum(s.completion_tokens), 0) as completion_tokens
      from agent_steps s join agent_runs r on r.id = s.run_id
      where s.created_at >= (current_date - ${days - 1}::int)::timestamptz
      group by s.org_id, r.agent_type, (s.created_at at time zone 'utc')::date
    ),
    opened as (
      select t.org_id, r.agent_type, (t.created_at at time zone 'utc')::date as day,
        count(*) as tasks_opened
      from agent_tasks t join agent_runs r on r.id = t.run_id
      where t.created_at >= (current_date - ${days - 1}::int)::timestamptz
      group by t.org_id, r.agent_type, (t.created_at at time zone 'utc')::date
    ),
    decided as (
      select t.org_id, r.agent_type, (t.decided_at at time zone 'utc')::date as day,
        count(*) filter (where t.status in ('approved', 'answered')) as tasks_approved,
        count(*) filter (where t.status = 'rejected') as tasks_rejected,
        count(*) filter (where t.status = 'approved' and t.response ? 'args') as tasks_edited,
        coalesce(sum(extract(epoch from (t.decided_at - t.created_at)) * 1000), 0)::bigint as hitl_wait_ms
      from agent_tasks t join agent_runs r on r.id = t.run_id
      where t.decided_at >= (current_date - ${days - 1}::int)::timestamptz
      group by t.org_id, r.agent_type, (t.decided_at at time zone 'utc')::date
    ),
    keys as (
      select org_id, agent_type, day from runs
      union select org_id, agent_type, day from steps
      union select org_id, agent_type, day from opened
      union select org_id, agent_type, day from decided
    )
    insert into agent_metrics_daily as m (
      org_id, agent_type, day, runs_started, runs_done, runs_failed, steps, tool_errors,
      prompt_tokens, completion_tokens, tasks_opened, tasks_approved, tasks_rejected,
      tasks_edited, hitl_wait_ms_total, updated_at
    )
    select k.org_id, k.agent_type, k.day,
      coalesce(ru.runs_started, 0), coalesce(ru.runs_done, 0), coalesce(ru.runs_failed, 0),
      coalesce(st.steps, 0), coalesce(st.tool_errors, 0),
      least(coalesce(st.prompt_tokens, 0), 2147483647), least(coalesce(st.completion_tokens, 0), 2147483647),
      coalesce(op.tasks_opened, 0), coalesce(de.tasks_approved, 0), coalesce(de.tasks_rejected, 0),
      coalesce(de.tasks_edited, 0), least(coalesce(de.hitl_wait_ms, 0), 2147483647), now()
    from keys k
    left join runs ru using (org_id, agent_type, day)
    left join steps st using (org_id, agent_type, day)
    left join opened op using (org_id, agent_type, day)
    left join decided de using (org_id, agent_type, day)
    where k.day >= current_date - ${days - 1}::int
    on conflict (org_id, agent_type, day) do update set
      runs_started = excluded.runs_started,
      runs_done = excluded.runs_done,
      runs_failed = excluded.runs_failed,
      steps = excluded.steps,
      tool_errors = excluded.tool_errors,
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      tasks_opened = excluded.tasks_opened,
      tasks_approved = excluded.tasks_approved,
      tasks_rejected = excluded.tasks_rejected,
      tasks_edited = excluded.tasks_edited,
      hitl_wait_ms_total = excluded.hitl_wait_ms_total,
      updated_at = now()
    returning 1
  `);
  return Array.isArray(rows) ? rows.length : 0;
}
