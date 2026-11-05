-- 0068_panel_directory.sql — the panel directory (docs/panel-directory.md).
--
-- panelists: everyone who may sit on an interview panel, internal (an org
-- member, or an employee without a login) or external (a client, an advisor).
-- Added in the hiring desk when the Interview coordinator asks for someone new;
-- the HR person who types them in approves them (self-approval is recorded).
-- Every org member is copied in once as an internal panelist.
--
-- role_panels.panelist_ids and round_substitutes.*_panelist_id point at the
-- directory; the old member columns stay (nullable) so code that predates this
-- migration keeps working on the same database.
--
-- panelist_scorecard_links: one private, expiring scorecard link per external
-- panelist per interview. Only the SHA-256 of the token is stored.
--
-- Idempotent: re-running is a no-op.

create table if not exists panelists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null default 'internal',
  member_id uuid references org_members(id) on delete cascade,
  full_name text not null,
  email text not null,
  title text,
  company text,
  areas text[] not null default '{}'::text[],
  rounds integer[] not null default '{1,2,3}'::integer[],
  weekly_cap integer not null default 4,
  active boolean not null default true,
  added_by uuid references users(id) on delete set null,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  self_approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$ begin
  alter table panelists add constraint panelists_kind_check
    check (kind in ('internal', 'external'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table panelists add constraint panelists_external_member_check
    check (kind = 'internal' or member_id is null);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table panelists add constraint panelists_rounds_check
    check (rounds <@ array[1,2,3] and cardinality(rounds) >= 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table panelists add constraint panelists_weekly_cap_check
    check (weekly_cap between 1 and 20);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table panelists add constraint panelists_areas_check check (cardinality(areas) <= 20);
exception when duplicate_object then null; end $$;
create unique index if not exists panelists_org_email_key on panelists (org_id, lower(email));
create unique index if not exists panelists_member_key on panelists (member_id)
  where member_id is not null;
create index if not exists panelists_org_idx on panelists (org_id, active);

insert into panelists (org_id, kind, member_id, full_name, email, approved_at)
select m.org_id, 'internal', m.id, coalesce(nullif(m.full_name, ''), m.email), lower(m.email), now()
from org_members m
on conflict do nothing;

alter table role_panels add column if not exists panelist_ids uuid[];
update role_panels rp
set panelist_ids = (
  select array_agg(p.id order by array_position(rp.member_ids, p.member_id))
  from panelists p
  where p.member_id = any (rp.member_ids)
)
where rp.panelist_ids is null;
alter table role_panels drop constraint if exists role_panels_members_check;
do $$ begin
  alter table role_panels add constraint role_panels_panelists_check
    check (panelist_ids is null or cardinality(panelist_ids) between 1 and 3);
exception when duplicate_object then null; end $$;

alter table round_substitutes add column if not exists replace_panelist_id uuid
  references panelists(id) on delete cascade;
alter table round_substitutes add column if not exists with_panelist_id uuid
  references panelists(id) on delete cascade;
update round_substitutes s
set replace_panelist_id = (select p.id from panelists p where p.member_id = s.replace_member_id),
    with_panelist_id = (select p.id from panelists p where p.member_id = s.with_member_id)
where s.replace_panelist_id is null and s.replace_member_id is not null;
alter table round_substitutes alter column replace_member_id drop not null;
alter table round_substitutes alter column with_member_id drop not null;
alter table round_substitutes drop constraint if exists round_substitutes_distinct_check;
do $$ begin
  alter table round_substitutes add constraint round_substitutes_panelist_distinct_check
    check (replace_panelist_id is null or replace_panelist_id <> with_panelist_id);
exception when duplicate_object then null; end $$;
create unique index if not exists round_substitutes_round_panelist_key
  on round_substitutes (application_id, level, replace_panelist_id)
  where replace_panelist_id is not null;

create table if not exists panelist_scorecard_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  interview_id uuid not null references interviews(id) on delete cascade,
  panelist_id uuid not null references panelists(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists panelist_scorecard_links_token_key
  on panelist_scorecard_links (token_hash);
create unique index if not exists panelist_scorecard_links_round_key
  on panelist_scorecard_links (interview_id, panelist_id);
create index if not exists panelist_scorecard_links_org_idx on panelist_scorecard_links (org_id);
