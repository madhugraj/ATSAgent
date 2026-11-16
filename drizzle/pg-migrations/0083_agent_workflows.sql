-- Agent workflows (16 November 2026, platform super admin only): flows of
-- agents — a trigger event, agents, conditions — drawn on a canvas, tested,
-- approved, published as immutable versions and granted to chosen
-- organisations, where the orchestrator runs them alongside the built-in
-- flow. Idempotent.
create table if not exists agent_workflows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  graph jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  test_scenarios jsonb not null default '[]'::jsonb,
  last_test jsonb,
  status text not null default 'draft',
  version integer not null default 1,
  published_version integer,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_workflows_status_check check (status in ('draft','tested','approved','published','archived'))
);
create index if not exists agent_workflows_status_idx on agent_workflows (status, updated_at);

create table if not exists agent_workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references agent_workflows(id) on delete cascade,
  version integer not null,
  trigger_event text not null,
  graph jsonb not null,
  hash text not null,
  test jsonb not null,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz not null,
  published_by uuid references users(id) on delete set null,
  published_at timestamptz not null default now()
);
create unique index if not exists agent_workflow_versions_key on agent_workflow_versions (workflow_id, version);

create table if not exists agent_workflow_grants (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references agent_workflows(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  granted_by uuid references users(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists agent_workflow_grants_live_key on agent_workflow_grants (workflow_id, org_id) where revoked_at is null;
create index if not exists agent_workflow_grants_org_idx on agent_workflow_grants (org_id);

create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null references agent_workflows(id) on delete cascade,
  version integer not null,
  trigger_event_id uuid references agent_events(id) on delete set null,
  status text not null default 'running',
  current_node text,
  waiting_run_id uuid references agent_runs(id) on delete set null,
  context jsonb not null default '{}'::jsonb,
  history jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint workflow_runs_status_check check (status in ('running','waiting','done','failed','cancelled'))
);
create index if not exists workflow_runs_org_idx on workflow_runs (org_id, status);
create index if not exists workflow_runs_waiting_idx on workflow_runs (waiting_run_id);
create unique index if not exists workflow_runs_event_key on workflow_runs (workflow_id, trigger_event_id);
