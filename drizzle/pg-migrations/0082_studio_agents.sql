-- Agent studio 2 (16 November 2026): studio agents the platform super admin
-- builds run inside the app for the organisations it grants them to. Lifecycle
-- draft → tested → approved → published; each published version is an
-- immutable manifest runs execute. Idempotent.
alter table agent_blueprints drop constraint if exists agent_blueprints_status_check;
alter table agent_blueprints add constraint agent_blueprints_status_check
  check (status in ('draft','tested','approved','published','archived'));
alter table agent_blueprints add column if not exists origin text not null default 'adapted';
alter table agent_blueprints add column if not exists type_slug text;
alter table agent_blueprints add column if not exists risk_tier text not null default 'medium';
alter table agent_blueprints add column if not exists owner_role text not null default 'hr_head';
alter table agent_blueprints add column if not exists gates jsonb not null default '["general"]'::jsonb;
alter table agent_blueprints add column if not exists scope jsonb not null default '{"reads":[],"writes":[],"external":[]}'::jsonb;
alter table agent_blueprints add column if not exists test_scenarios jsonb not null default '[]'::jsonb;
alter table agent_blueprints add column if not exists last_test jsonb;
alter table agent_blueprints add column if not exists approved_by uuid references users(id) on delete set null;
alter table agent_blueprints add column if not exists approved_at timestamptz;
alter table agent_blueprints add column if not exists published_version integer;
create unique index if not exists agent_blueprints_type_slug_key on agent_blueprints (type_slug);

create table if not exists studio_agent_versions (
  id uuid primary key default gen_random_uuid(),
  blueprint_id uuid not null references agent_blueprints(id) on delete cascade,
  version integer not null,
  type_slug text not null,
  manifest jsonb not null,
  hash text not null,
  test jsonb not null,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz not null,
  published_by uuid references users(id) on delete set null,
  published_at timestamptz not null default now()
);
create unique index if not exists studio_agent_versions_key on studio_agent_versions (blueprint_id, version);

create table if not exists studio_agent_grants (
  id uuid primary key default gen_random_uuid(),
  blueprint_id uuid not null references agent_blueprints(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  granted_by uuid references users(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists studio_agent_grants_live_key on studio_agent_grants (blueprint_id, org_id) where revoked_at is null;
create index if not exists studio_agent_grants_org_idx on studio_agent_grants (org_id);
