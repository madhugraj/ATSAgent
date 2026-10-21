-- 0045_candidate_pool_use.sql — what a CV may be used for, by where it came from.
--
-- Some portals' terms limit the applications they hand over to the one role
-- they were for (Naukri's apply terms, Internshala and Job Hai: "solely" /
-- "only" for that hiring). A candidate created from such a portal's CV
-- (an upload or a careers-inbox mail from the portal) is 'role_only': it is
-- never added to another role, matched to other roles or invited, and once
-- its roles are over a person is asked to erase it (Distribution agent).
-- pool_use_source names the portal whose terms apply. Candidates who applied
-- through the organisation's own apply page are 'pool' whatever link they
-- followed — the candidate gave the CV to the organisation directly.
--
-- Idempotent: re-running is a no-op.

alter table candidates add column if not exists pool_use text not null default 'pool';
alter table candidates add column if not exists pool_use_source text;
do $$ begin
  alter table candidates add constraint candidates_pool_use_check
    check (pool_use in ('pool', 'role_only'));
exception when duplicate_object then null; end $$;
create index if not exists candidates_role_only_idx
  on candidates (org_id) where pool_use = 'role_only';
