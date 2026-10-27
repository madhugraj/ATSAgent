-- 0048_scheduling_call.sql — the voice scheduling call, step S0
-- (docs/voice-scheduling-call-plan.md).
--
-- * screening_calls also carries scheduling calls: `purpose`, the e-mailed
--   interview-time offer it follows up (`slot_offer_id`), and up to three
--   extra times checked against the interviewers' calendars (`alternates`).
--   One dispatcher, worker, calling window and set of health rules serve both.
-- * phone_screening_settings: scheduling calls switched on (off by default)
--   and how long an e-mailed offer waits unanswered before a call (24 h).
-- * candidates.ai_call_opt_out_at: the candidate asked not to be phoned by the
--   AI assistant; no AI call of any kind dials them again.
--
-- Idempotent: re-running is a no-op.

alter table screening_calls add column if not exists purpose text not null default 'screening';
do $$ begin
  alter table screening_calls add constraint screening_calls_purpose_check
    check (purpose in ('screening', 'scheduling'));
exception when duplicate_object then null; end $$;

alter table screening_calls add column if not exists slot_offer_id uuid
  references interview_slot_offers(id) on delete set null;
alter table screening_calls add column if not exists alternates jsonb not null default '[]'::jsonb;
do $$ begin
  alter table screening_calls add constraint screening_calls_alternates_check
    check (jsonb_typeof(alternates) = 'array' and jsonb_array_length(alternates) <= 3);
exception when duplicate_object then null; end $$;
-- A scheduling call always follows up an offer.
do $$ begin
  alter table screening_calls add constraint screening_calls_scheduling_offer_check
    check (purpose <> 'scheduling' or slot_offer_id is not null);
exception when duplicate_object then null; end $$;
create index if not exists screening_calls_slot_offer_idx on screening_calls (slot_offer_id);

alter table phone_screening_settings add column if not exists scheduling_enabled boolean not null default false;
alter table phone_screening_settings add column if not exists scheduling_wait_hours integer not null default 24;
do $$ begin
  alter table phone_screening_settings add constraint phone_screening_settings_scheduling_wait_check
    check (scheduling_wait_hours between 2 and 96);
exception when duplicate_object then null; end $$;

alter table candidates add column if not exists ai_call_opt_out_at timestamptz;
