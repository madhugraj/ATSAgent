-- 0037_assessment_timeline_nudges.sql — assessment deadlines, reminders and
-- agent pop-ups.
--
-- * assessment_settings: per organisation (defaults when no row): due in
--   3 working days, first reminder after 2 days, at most 2 reminders, overdue
--   2 days after the due date, link closes 7 days after it was sent.
-- * candidate_assessments: the application it belongs to, its due and closing
--   time, reminders sent, and when it was flagged overdue / waived. Existing
--   links keep the 14 days they were sent with.
-- * notification_states: per person, whether an agent pop-up was seen,
--   snoozed or dismissed (notifications themselves stay derived live).
--
-- Idempotent: re-running is a no-op.

create table if not exists assessment_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  due_working_days integer not null default 3 check (due_working_days between 1 and 15),
  first_reminder_days integer not null default 2 check (first_reminder_days between 1 and 14),
  max_reminders integer not null default 2 check (max_reminders between 0 and 3),
  overdue_after_days integer not null default 2 check (overdue_after_days between 0 and 14),
  close_after_days integer not null default 7 check (close_after_days between 2 and 30),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table candidate_assessments add column if not exists application_id uuid references applications(id) on delete set null;
alter table candidate_assessments add column if not exists due_at timestamptz;
alter table candidate_assessments add column if not exists closes_at timestamptz;
alter table candidate_assessments add column if not exists reminders_sent integer not null default 0;
alter table candidate_assessments add column if not exists last_reminded_at timestamptz;
alter table candidate_assessments add column if not exists overdue_at timestamptz;
alter table candidate_assessments add column if not exists waived_reason text;

-- Links already sent keep their original 14 days; their due date is what the
-- invitation promised (3 days).
update candidate_assessments
  set closes_at = created_at + interval '14 days'
  where closes_at is null;
update candidate_assessments
  set due_at = created_at + interval '3 days'
  where due_at is null;
update candidate_assessments ca
  set application_id = a.id
  from applications a
  where ca.application_id is null and a.candidate_id = ca.candidate_id
    and a.requisition_id = ca.requisition_id;

create index if not exists candidate_assessments_open_idx
  on candidate_assessments (org_id, status, due_at) where status = 'sent';

create table if not exists notification_states (
  user_id uuid not null references users(id) on delete cascade,
  notification_id text not null,
  org_id uuid references organizations(id) on delete cascade,
  seen_at timestamptz,
  snoozed_until timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, notification_id)
);
