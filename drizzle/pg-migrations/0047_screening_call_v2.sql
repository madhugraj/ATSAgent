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

do $$ begin
  alter table phone_screening_settings add constraint phone_screening_settings_next_steps_check
    check (next_steps_text is null or char_length(next_steps_text) <= 300);
exception when duplicate_object then null; end $$;

alter table screening_calls add column if not exists booked_by_candidate boolean not null default false;
-- What the candidate said about their current role, experience, location and
-- availability (never pay: pay goes only to the HR-only compensation record).
alter table screening_calls add column if not exists details jsonb not null default '{}'::jsonb;
