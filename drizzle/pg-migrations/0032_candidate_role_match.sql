-- 0032_candidate_role_match.sql — "new CV → open roles".
--
-- When a person joins the talent pool without a role (an inbox mail that named
-- no role, an upload, a capture, an HRMS import), the scheduler checks them
-- against every approved open role. This column records that the check ran,
-- so each new CV is checked once; the partial index keeps finding the
-- unchecked ones cheap.
--
-- Idempotent: re-running is a no-op.

alter table candidates add column if not exists role_match_checked_at timestamptz;

create index if not exists candidates_role_match_pending_idx
  on candidates (org_id, created_at)
  where role_match_checked_at is null;
