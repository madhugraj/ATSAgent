-- Agent studio (16 November 2026, platform super admin only): stock agents
-- adapted to other domains for use in other applications — a downloadable
-- package or a hosted API run in a chosen workspace organisation with that
-- organisation's own AI key. Owned by the platform, not by any organisation.
-- In-app runs never use blueprints. Idempotent.
create table if not exists agent_blueprints (
  id uuid primary key default gen_random_uuid(),
  agent_type text not null,
  base_version text not null,
  base_hash text not null,
  name text not null,
  description text not null default '',
  responsibility text not null,
  instructions text not null,
  must_never jsonb not null default '[]'::jsonb,
  tools jsonb not null default '[]'::jsonb,
  tool_overrides jsonb not null default '{}'::jsonb,
  max_steps integer,
  status text not null default 'draft',
  version integer not null default 1,
  workspace_org_id uuid references organizations(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_blueprints_status_check check (status in ('draft','published','archived'))
);
create index if not exists agent_blueprints_status_idx on agent_blueprints (status, updated_at);

create table if not exists agent_blueprint_keys (
  id uuid primary key default gen_random_uuid(),
  blueprint_id uuid not null references agent_blueprints(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  label text not null default '',
  key_prefix text not null,
  key_hash text not null,
  principal_user_id uuid not null references users(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create unique index if not exists agent_blueprint_keys_hash_key on agent_blueprint_keys (key_hash);
create index if not exists agent_blueprint_keys_blueprint_idx on agent_blueprint_keys (blueprint_id);

alter table agent_runs add column if not exists blueprint_id uuid references agent_blueprints(id) on delete set null;
alter table agent_runs add column if not exists blueprint_version integer;
