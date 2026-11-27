-- Profile-based matching (plan row 8, C1): one score per candidate x requisition,
-- computed against the consolidated evidence profile. A cheap evidence pass
-- ranks the whole pool; the top K per requisition get a requirement-by-
-- requirement AI review whose verdicts must cite the candidate's own claims.
-- The overall score is computed in code from the verdicts and tenant weights.
-- Design: docs/candidate-identification/track-a-design.md §4.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs

create table if not exists profile_match_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  requisition_id uuid not null references requisitions(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  coarse_score numeric(6,3) not null default 0,
  coarse_rank integer,
  overall_score integer,
  stage text not null default 'coarse',
  factors jsonb not null default '[]'::jsonb,
  requirements jsonb not null default '[]'::jsonb,
  knockouts jsonb not null default '[]'::jsonb,
  rationale text,
  profile_stamp text not null default '',
  decision text,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  judged_at timestamptz,
  computed_at timestamptz not null default now(),
  constraint profile_match_scores_stage_check check (stage in ('coarse','judged')),
  constraint profile_match_scores_decision_check
    check (decision is null or decision in ('shortlisted','rejected'))
);
create unique index if not exists profile_match_scores_req_cand_key
  on profile_match_scores (requisition_id, candidate_id);
create index if not exists profile_match_scores_rank_idx
  on profile_match_scores (org_id, requisition_id, overall_score desc nulls last, coarse_score desc);

create table if not exists profile_match_runs (
  requisition_id uuid primary key references requisitions(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  expansions jsonb not null default '[]'::jsonb,
  expansions_stamp text not null default '',
  pool_size integer not null default 0,
  judged integer not null default 0,
  status text not null default 'idle',
  last_error text,
  last_run_at timestamptz,
  requested_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists profile_match_runs_org_idx on profile_match_runs (org_id);
