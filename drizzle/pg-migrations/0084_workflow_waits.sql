-- Agent workflows, part 2 (16 November 2026): hiring-need (manual) starts,
-- wait-for steps on the flow's own role with a timeout, and report steps.
-- Idempotent.
alter table workflow_runs add column if not exists waiting_event text;
alter table workflow_runs add column if not exists waiting_until timestamptz;
alter table workflow_runs add column if not exists started_by uuid references users(id) on delete set null;
create index if not exists workflow_runs_wait_idx on workflow_runs (waiting_event, waiting_until) where status = 'waiting';
