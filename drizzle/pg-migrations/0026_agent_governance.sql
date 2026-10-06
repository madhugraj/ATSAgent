-- 0026_agent_governance.sql — agent traceability (docs/agentic-plan.md §6).
--
-- agent_definitions   immutable snapshot of every agent manifest version
--                     (identity, scope, tools, skills, gates, instructions),
--                     keyed by content hash
-- agent_runs          record the definition each run executed under
-- ai_usage_events     link every AI request made inside an agent run (model
--                     turns and AI calls inside tools) to that run
--
-- Idempotent: re-running is a no-op.

create table if not exists agent_definitions (
  id uuid primary key default gen_random_uuid(),
  agent_type text not null,
  version text not null,
  hash text not null,
  manifest jsonb not null,
  created_at timestamptz not null default now()
);
create unique index if not exists agent_definitions_type_hash_key
  on agent_definitions (agent_type, hash);

alter table agent_runs
  add column if not exists definition_id uuid references agent_definitions (id) on delete set null;
alter table agent_runs add column if not exists definition_version text;
alter table agent_runs add column if not exists definition_hash text;

alter table ai_usage_events
  add column if not exists agent_run_id uuid references agent_runs (id) on delete set null;
create index if not exists ai_usage_events_agent_run_idx on ai_usage_events (agent_run_id);
