-- Agent studio (16 November 2026): customised copies of stock agents for use
-- outside this app — a downloadable package or a hosted API with org keys.
-- Customisations only narrow the stock agent and never apply to in-app runs.
-- Idempotent.
create table if not exists agent_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_type text not null,
  base_version text not null,
  base_hash text not null,
  name text not null,
  description text not null default '',
  extra_instructions text not null default '',
  tools jsonb not null default '[]'::jsonb,
  extra_must_never jsonb not null default '[]'::jsonb,
  max_steps integer,
  max_tokens integer,
  status text not null default 'draft',
  version integer not null default 1,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_exports_status_check check (status in ('draft','published','archived'))
);
create index if not exists agent_exports_org_idx on agent_exports (org_id, status);

create table if not exists agent_export_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  export_id uuid not null references agent_exports(id) on delete cascade,
  label text not null default '',
  key_prefix text not null,
  key_hash text not null,
  principal_user_id uuid not null references users(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create unique index if not exists agent_export_keys_hash_key on agent_export_keys (key_hash);
create index if not exists agent_export_keys_export_idx on agent_export_keys (org_id, export_id);

alter table agent_runs add column if not exists export_id uuid references agent_exports(id) on delete set null;
alter table agent_runs add column if not exists export_version integer;
