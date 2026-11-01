-- 0046_close_stale_agent_tasks.sql — one-off cleanup of agent requests that
-- outlived their run.
--
-- Before this change a run that failed or finished could leave its requests
-- (agent_tasks) open; the Follow-up agent then reminded people about them and
-- approving one did nothing. The runtime now closes them when a run ends and
-- sweeps requests whose subject was deleted on every scheduler tick
-- (src/server/agents/runtime.server.ts: closeStaleTasks). This closes the ones
-- already left behind, with the same reason the runtime records, and audits
-- each as agent.task.stale.
--
-- Idempotent: only open requests on runs that are no longer live are touched,
-- so re-running is a no-op.

with closed as (
  update agent_tasks t
     set status = 'cancelled',
         response = jsonb_build_object(
           'status', 'cancelled',
           'reason', case r.status
             when 'cancelled' then 'the agent working on it was stopped, so it no longer applies.'
             when 'failed' then 'the agent working on it stopped with an error, so it no longer applies.'
             else 'the agent working on it has already finished, so it no longer applies.'
           end),
         decided_at = now(),
         updated_at = now()
    from agent_runs r
   where r.id = t.run_id
     and t.status = 'open'
     and r.status in ('done', 'failed', 'cancelled')
  returning t.id, t.org_id, t.run_id, r.status as run_status
)
insert into audit_log (org_id, actor, action, entity_type, entity_id, detail)
select org_id, 'system:migration-0046', 'agent.task.stale', 'agent_task', id,
       jsonb_build_object('run_id', run_id, 'reason', 'run ' || run_status)
  from closed;
