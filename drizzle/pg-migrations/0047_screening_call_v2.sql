-- 0047_screening_call_v2.sql — the screening call done the way HR does it
-- (docs/voice-screening-stage1.1-plan.md, step A).
--
-- * phone_screening_settings: the assistant's voice, what candidates are told
--   about next steps, and a 10-minute call by default (Level 0 screening).
-- * screening_calls: whether the time was agreed with the candidate on an
--   earlier call (a booked call is expected, not a cold call), and the
--   practical details the candidate gave (never pay).
--
-- Idempotent: re-running is a no-op.

alter table phone_screening_settings add column if not exists voice text not null default 'Kore';
alter table phone_screening_settings add column if not exists next_steps_text text;
alter table phone_screening_settings alter column max_minutes set default 10;
-- How many times a candidate may move the call to another time (then the
-- written assessment or a person is offered instead).
alter table phone_screening_settings add column if not exists max_reschedules integer not null default 2;
do $$ begin
  alter table phone_screening_settings add constraint phone_screening_settings_max_reschedules_check
    check (max_reschedules between 0 and 5);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table phone_screening_settings add constraint phone_screening_settings_next_steps_check
    check (next_steps_text is null or char_length(next_steps_text) <= 300);
exception when duplicate_object then null; end $$;

alter table screening_calls add column if not exists booked_by_candidate boolean not null default false;
alter table screening_calls add column if not exists reschedules integer not null default 0;

-- The voice worker's heartbeat: the web app learns a phone line is available
-- from it, so only the worker ever holds the PBX credentials.
create table if not exists voice_worker_heartbeat (
  worker_id text primary key,
  last_seen timestamptz not null default now(),
  max_concurrent integer not null default 1,
  calls_in_progress integer not null default 0
);
-- What the candidate said about their current role, experience, location and
-- availability (never pay: pay goes only to the HR-only compensation record).
alter table screening_calls add column if not exists details jsonb not null default '{}'::jsonb;
