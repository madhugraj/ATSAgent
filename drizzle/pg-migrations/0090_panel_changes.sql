-- Panel liberty under the hiring SLA.
-- 1. interviews.panel_changes: time changes a panelist made after accepting
--    (one each per round, never past the stage's SLA deadline).
-- 2. plan_change_proposals: a panelist's proposed change to their round's
--    scorecard, checked against the role's must-haves, reviewed by the AI and
--    applied only when the hiring manager (or the HR head) approves.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs
alter table interviews add column if not exists panel_changes jsonb not null default '[]'::jsonb;

create table if not exists plan_change_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  requisition_id uuid not null references requisitions(id) on delete cascade,
  interview_id uuid references interviews(id) on delete set null,
  level smallint not null,
  email text not null,
  name text,
  before jsonb not null,
  round jsonb not null,
  reason text not null,
  status text not null default 'reviewing',
  review jsonb,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  constraint plan_change_proposals_status_check
    check (status in ('reviewing','awaiting_approval','approved','rejected','stale'))
);
create index if not exists plan_change_proposals_req_idx
  on plan_change_proposals (org_id, requisition_id, status);
