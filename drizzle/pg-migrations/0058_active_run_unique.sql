-- 0058_active_run_unique.sql — one active live run per organisation, agent
-- and requisition. The dispatch dedupe (activeRunFor) is check-then-insert:
-- two starts racing past the check (two side-by-side panes, a click and an
-- event) stacked duplicate runs on one role. startRun now gets the run that
-- is already working instead.
--
-- Idempotent: re-running is a no-op. Fails loudly if duplicates already
-- exist — cancel the extras first (none in a healthy database).

create unique index if not exists agent_runs_active_requisition_key
  on agent_runs (org_id, agent_type, subject_id)
  where subject_type = 'requisition'
    and status in ('queued', 'running', 'awaiting_human')
    and mode = 'live';
