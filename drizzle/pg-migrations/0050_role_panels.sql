-- 0050_role_panels.sql — interview panels, step P2
-- (docs/interview-panel-plan.md).
--
-- * role_panels: the approved interview panel for one role and round. The
--   Interview coordinator proposes it (propose_panel), a person — the role's
--   hiring manager, else the HR head — approves or changes it, and it is
--   reused for every candidate of that role and round until a person changes
--   it. `version` counts approvals.
--
-- Idempotent: re-running is a no-op.

create table if not exists role_panels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  requisition_id uuid not null references requisitions(id) on delete cascade,
  level integer not null,
  member_ids uuid[] not null,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index if not exists role_panels_requisition_level_key
  on role_panels (requisition_id, level);
create index if not exists role_panels_org_idx on role_panels (org_id);
do $$ begin
  alter table role_panels add constraint role_panels_level_check check (level between 1 and 3);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table role_panels add constraint role_panels_members_check
    check (cardinality(member_ids) between 1 and 3);
exception when duplicate_object then null; end $$;
