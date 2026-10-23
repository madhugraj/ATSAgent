-- 0046_screening_calls.sql — phone screening by the Screening call agent
-- (docs/voice-screening-agent.md).
--
-- * phone_screening_settings: per organisation (defaults when no row): off;
--   assistant "Saranya"; calls 10:00–19:00 in the organisation's time zone,
--   Monday to Saturday; at most 3 attempts; 15 minutes per call.
-- * screening_calls: one phone screening of one application — its attempts,
--   consent, transcript (kept only after consent) and answers per kit question.
--   Erasing the candidate erases their calls. The phone number is never copied
--   here: it is read from the candidate when dialling; only its last 4 digits
--   are kept for display.
--
-- Idempotent: re-running is a no-op.

create table if not exists phone_screening_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default false,
  assistant_name text not null default 'Saranya'
    check (char_length(assistant_name) between 2 and 40),
  window_start_minute integer not null default 600
    check (window_start_minute between 0 and 1439),
  window_end_minute integer not null default 1140
    check (window_end_minute between 1 and 1440),
  -- ISO weekdays the organisation calls on (1 = Monday … 7 = Sunday).
  call_days integer[] not null default '{1,2,3,4,5,6}',
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  max_minutes integer not null default 15 check (max_minutes between 5 and 30),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint phone_screening_settings_window_check
    check (window_end_minute > window_start_minute)
);

create table if not exists screening_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  application_id uuid references applications(id) on delete set null,
  requisition_id uuid references requisitions(id) on delete set null,
  kit_id uuid references screening_kits(id) on delete set null,
  -- The Screening agent run that asked for the call, and the call's own run.
  requested_run_id uuid references agent_runs(id) on delete set null,
  agent_run_id uuid references agent_runs(id) on delete set null,
  requested_by uuid references users(id) on delete set null,
  status text not null default 'requested',
  attempt integer not null default 0,
  due_at timestamptz,
  callback_at timestamptz,
  phone_last4 text,
  consent_at timestamptz,
  language text,
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  duration_s integer,
  transcript jsonb not null default '[]'::jsonb,
  answers jsonb not null default '[]'::jsonb,
  screening_run_id uuid references screening_runs(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table screening_calls add constraint screening_calls_status_check
    check (status in ('requested', 'approved', 'dialling', 'in_progress', 'completed',
      'callback', 'no_answer', 'failed', 'consent_declined', 'cancelled', 'fell_back'));
exception when duplicate_object then null; end $$;

create index if not exists screening_calls_due_idx
  on screening_calls (org_id, status, due_at);
create index if not exists screening_calls_application_idx
  on screening_calls (application_id, created_at);
create index if not exists screening_calls_candidate_idx
  on screening_calls (candidate_id);
