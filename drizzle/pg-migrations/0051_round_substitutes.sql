-- 0051_round_substitutes.sql — interview panels, step P3
-- (docs/interview-panel-plan.md).
--
-- * round_substitutes: for one candidate's round only, a panellist replaced by
--   another member — proposed by the Interview coordinator, approved by a
--   person (the role's hiring manager, else the HR head). The role's approved
--   panel (role_panels) is unchanged.
-- * interviews.unavailable: interviewers on a booked round who said they
--   cannot make it ([{ email, note, at }]).
--
-- Idempotent: re-running is a no-op.

create table if not exists round_substitutes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  level integer not null,
  replace_member_id uuid not null references org_members(id) on delete cascade,
  with_member_id uuid not null references org_members(id) on delete cascade,
  reason text,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz not null default now()
);
create unique index if not exists round_substitutes_round_member_key
  on round_substitutes (application_id, level, replace_member_id);
create index if not exists round_substitutes_org_idx on round_substitutes (org_id);
do $$ begin
  alter table round_substitutes add constraint round_substitutes_level_check
    check (level between 1 and 3);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table round_substitutes add constraint round_substitutes_distinct_check
    check (replace_member_id <> with_member_id);
exception when duplicate_object then null; end $$;

alter table interviews add column if not exists unavailable jsonb not null default '[]'::jsonb;
