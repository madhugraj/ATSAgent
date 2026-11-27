-- Tenant workflow profile (docs/candidate-identification/track-b-design.md §1.3):
-- which way of working a tenant runs, which published workflow backs it, the
-- capability set resolved at apply time, and profile settings. Absence of a row
-- means full_pipeline. Additive and idempotent. Roll: node scripts/migrate-pg.mjs
create table if not exists org_workflow_profiles (
  org_id uuid primary key references organizations (id) on delete cascade,
  profile text not null,
  workflow_id uuid references agent_workflows (id) on delete set null,
  resolved_capabilities jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  applied_by uuid references users (id) on delete set null,
  applied_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_workflow_profiles_profile_check
    check (profile in ('full_pipeline', 'template', 'custom'))
);
