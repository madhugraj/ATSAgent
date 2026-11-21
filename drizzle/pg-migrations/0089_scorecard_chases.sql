-- Scorecard chasing under the hiring SLA: one row per interviewer per round,
-- recording how far the chase has gone (1: reminded as the round ended,
-- 2: reminded again, 3: the HR head told, 4+: daily escalation) and when.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs
create table if not exists scorecard_chases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  interview_id uuid not null references interviews(id) on delete cascade,
  email text not null,
  step smallint not null default 0,
  last_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists scorecard_chases_round_person_key
  on scorecard_chases (interview_id, email);
