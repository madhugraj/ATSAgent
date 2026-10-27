-- 0054_org_profile.sql — the organisation profile (docs/org-context-agent-plan.md, O0).
--
-- One profile per organisation, kept as numbered versions. A version is
-- written by hand (later by the Organisation context agent), submitted, and
-- approved, declined or sent back by the HR head or the owner. Approved
-- versions never change; the next change is a new draft. Agents will read only
-- the current approved version (org_profiles.current_version_id).
--
-- Items never hold pay figures or staff names / contacts (refused in code
-- before anything is saved). require_profile is the organisation's "hard gate":
-- no requisition is raised until a version is approved.
--
-- Numbered 0054 to stay clear of 0046–0053 on open branches.
-- Idempotent: re-running is a no-op.

create table if not exists org_profile_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  version integer not null,
  status text not null default 'draft',
  sections jsonb not null default '{}'::jsonb,
  injection_flagged boolean not null default false,
  created_by uuid references users(id) on delete set null,
  agent_run_id uuid references agent_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  submitted_by uuid references users(id) on delete set null,
  submitted_at timestamptz,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text
);
do $$ begin
  alter table org_profile_versions add constraint org_profile_versions_status_check
    check (status in ('draft', 'pending', 'changes_requested', 'approved', 'declined', 'superseded'));
exception when duplicate_object then null; end $$;
create unique index if not exists org_profile_versions_org_version_key
  on org_profile_versions (org_id, version);
-- At most one version being worked on or waiting for a decision.
create unique index if not exists org_profile_versions_one_open_key
  on org_profile_versions (org_id) where status in ('draft', 'pending', 'changes_requested');

create table if not exists org_profiles (
  org_id uuid primary key references organizations(id) on delete cascade,
  current_version_id uuid references org_profile_versions(id) on delete set null,
  require_profile boolean not null default false,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
