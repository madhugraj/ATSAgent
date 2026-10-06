-- 0024_agents.sql — agent runtime tables (docs/agentic-plan.md §7, §9).
--
-- agent_policies       per org × agent: autonomy dial, template whitelist, budget
--                      (agent_type '*' = org-wide switch)
-- agent_events         domain-event outbox drained by the orchestrator
-- agent_runs           one run; transcript doubles as the checkpoint
-- agent_steps          append-only step log / trace spans (redacted payloads)
-- agent_tasks          human-in-the-loop items (gate / approval / clarification)
-- agent_metrics_daily  per org × agent × day rollup for dashboards and alerts
--
-- Statuses are app-level text, matching email_outbox and screening_prep_jobs.
-- Idempotent: re-running is a no-op.

create table if not exists agent_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  agent_type text not null,
  enabled boolean not null default true,
  autonomy text not null default 'suggest',
  whitelisted_templates jsonb not null default '[]'::jsonb,
  monthly_token_budget integer,
  updated_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists agent_policies_org_agent_key
  on agent_policies (org_id, agent_type);

create table if not exists agent_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  type text not null,
  subject_type text,
  subject_id uuid,
  actor_user_id uuid references users (id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_events_queue_idx on agent_events (status, created_at);
create index if not exists agent_events_org_idx on agent_events (org_id, created_at);

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  agent_type text not null,
  status text not null default 'queued',
  principal_user_id uuid not null references users (id) on delete cascade,
  subject_type text,
  subject_id uuid,
  trigger_event_id uuid references agent_events (id) on delete set null,
  goal text not null,
  transcript jsonb not null default '[]'::jsonb,
  pending jsonb,
  result text,
  step_count integer not null default 0,
  tokens_used integer not null default 0,
  max_steps integer not null default 20,
  max_tokens integer not null default 200000,
  trace_id uuid not null default gen_random_uuid(),
  lease_until timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists agent_runs_queue_idx on agent_runs (status, updated_at);
create index if not exists agent_runs_org_status_idx on agent_runs (org_id, status);
create index if not exists agent_runs_subject_idx on agent_runs (org_id, subject_type, subject_id);

create table if not exists agent_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  seq integer not null,
  kind text not null,
  tool_name text,
  tool_call_id text,
  status text not null,
  input jsonb,
  output jsonb,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  duration_ms integer not null default 0,
  span_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create unique index if not exists agent_steps_run_seq_key on agent_steps (run_id, seq);

create table if not exists agent_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  run_id uuid not null references agent_runs (id) on delete cascade,
  kind text not null,
  status text not null default 'open',
  title text not null,
  body text not null default '',
  proposed_action jsonb,
  assignee_role text,
  assignee_user_id uuid references users (id) on delete set null,
  response jsonb,
  decided_by uuid references users (id) on delete set null,
  decided_at timestamptz,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_tasks_org_status_idx on agent_tasks (org_id, status);
create index if not exists agent_tasks_run_idx on agent_tasks (run_id);

create table if not exists agent_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  agent_type text not null,
  day date not null,
  runs_started integer not null default 0,
  runs_done integer not null default 0,
  runs_failed integer not null default 0,
  steps integer not null default 0,
  tool_errors integer not null default 0,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  tasks_opened integer not null default 0,
  tasks_approved integer not null default 0,
  tasks_rejected integer not null default 0,
  tasks_edited integer not null default 0,
  hitl_wait_ms_total integer not null default 0,
  updated_at timestamptz not null default now()
);
create unique index if not exists agent_metrics_daily_key
  on agent_metrics_daily (org_id, agent_type, day);
