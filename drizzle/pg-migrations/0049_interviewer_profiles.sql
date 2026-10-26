-- 0049_interviewer_profiles.sql — interview panels, step P0
-- (docs/interview-panel-plan.md).
--
-- * member_interviewer_profiles: registered once by the admin — whether a member
--   interviews, the areas they assess (matched to a round's competencies), the
--   rounds they take, and how many interviews a week at most.
-- * requisitions.hiring_manager_member_id: the role's hiring manager is a
--   member (the free-text hiring_manager stays for older roles).
--
-- Idempotent: re-running is a no-op.

create table if not exists member_interviewer_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  member_id uuid not null references org_members(id) on delete cascade,
  active boolean not null default true,
  areas text[] not null default '{}',
  rounds integer[] not null default '{1,2,3}',
  weekly_cap integer not null default 4,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index if not exists member_interviewer_profiles_member_key
  on member_interviewer_profiles (member_id);
create index if not exists member_interviewer_profiles_org_idx
  on member_interviewer_profiles (org_id, active);
do $$ begin
  alter table member_interviewer_profiles add constraint member_interviewer_profiles_weekly_cap_check
    check (weekly_cap between 1 and 20);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table member_interviewer_profiles add constraint member_interviewer_profiles_rounds_check
    check (rounds <@ array[1,2,3] and cardinality(rounds) >= 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table member_interviewer_profiles add constraint member_interviewer_profiles_areas_check
    check (cardinality(areas) <= 20);
exception when duplicate_object then null; end $$;

alter table requisitions add column if not exists hiring_manager_member_id uuid
  references org_members(id) on delete set null;
