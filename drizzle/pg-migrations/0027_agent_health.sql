-- 0027_agent_health.sql — agent health issues and scheduler heartbeat
-- (docs/agentic-plan.md §9.3).
--
-- agent_issues            one row per (org, agent, rule) problem while it lasts;
--                         opened, re-seen, acknowledged and auto-resolved by the
--                         health engine (src/server/agents/health.server.ts)
-- agent_runtime_heartbeat last scheduler tick and health evaluation, so a
--                         stopped scheduler is visible even though nothing runs
--
-- Idempotent: re-running is a no-op.

create table if not exists agent_issues (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  agent_type text not null,
  element text not null,
  rule text not null,
  severity text not null,
  status text not null default 'open',
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  occurrences integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  acknowledged_by uuid references users (id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at timestamptz
);
create unique index if not exists agent_issues_active_key
  on agent_issues (org_id, agent_type, rule) where status <> 'resolved';
create index if not exists agent_issues_org_status_idx on agent_issues (org_id, status);

create table if not exists agent_runtime_heartbeat (
  id text primary key,
  last_tick_at timestamptz,
  last_health_at timestamptz,
  last_counts jsonb not null default '{}'::jsonb
);
