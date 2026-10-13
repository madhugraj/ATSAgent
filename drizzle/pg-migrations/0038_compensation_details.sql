-- 0038_compensation_details.sql — the candidate's compensation and
-- availability, collected at screening, before any offer is drafted.
--
-- * compensation_requests: a private form link sent to the candidate at
--   screening (same timeline as written assessments: due date, reminders,
--   closing), with what they answered.
-- * compensation_details: the record an offer is built on — current pay
--   (fixed / variable), expected CTC, notice period, earliest joining date,
--   competing offers, location and relocation — from the candidate's form or
--   entered by TA / HR after a screening call. Visible to TA, HR head, CBO and
--   owners only. The latest row per application is the one in force.
--
-- Idempotent: re-running is a no-op.

create table if not exists compensation_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  token text not null unique,
  status text not null default 'sent', -- sent | completed | expired | cancelled
  due_at timestamptz,
  closes_at timestamptz,
  reminders_sent integer not null default 0,
  last_reminded_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists compensation_requests_open_idx
  on compensation_requests (org_id, status, due_at) where status = 'sent';
create index if not exists compensation_requests_application_idx
  on compensation_requests (application_id);

create table if not exists compensation_details (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  currency text not null default 'INR',
  current_fixed numeric(14, 2),
  current_variable numeric(14, 2),
  expected_ctc numeric(14, 2),
  notice_period_days integer check (notice_period_days between 0 and 365),
  earliest_joining date,
  competing_offers boolean,
  competing_note text,
  current_location text,
  open_to_relocate boolean,
  note text,
  -- 'candidate_form' | 'screening_call' | 'recruiter'
  source text not null,
  entered_by uuid references users(id) on delete set null,
  request_id uuid references compensation_requests(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists compensation_details_application_idx
  on compensation_details (application_id, created_at desc);
