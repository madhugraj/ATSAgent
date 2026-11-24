-- Voice confirmation and reminder calls (docs/voice-scheduling-call-plan.md,
-- "Confirmation and reminder calls"):
--  - purpose 'confirmation': the day before a booked round, the candidate is
--    phoned to confirm they will attend (their interview_confirmations row);
--  - purpose 'panel_check': a panelist who has not answered an interview time
--    is phoned (their interview_confirmations row), so they need a mobile in
--    the panel directory and may opt out of AI calls like a candidate;
--  - a scheduling call may now be a reminder (`reminder`): one more call when
--    the e-mailed times stay unanswered.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs

alter table panelists add column if not exists phone text;
alter table panelists add column if not exists ai_call_opt_out_at timestamptz;

alter table screening_calls add column if not exists confirmation_id uuid
  references interview_confirmations(id) on delete cascade;
alter table screening_calls add column if not exists panelist_id uuid
  references panelists(id) on delete cascade;
alter table screening_calls add column if not exists reminder boolean not null default false;

create index if not exists screening_calls_confirmation_idx on screening_calls (confirmation_id);

alter table screening_calls drop constraint if exists screening_calls_purpose_check;
alter table screening_calls add constraint screening_calls_purpose_check
  check (purpose in ('screening', 'scheduling', 'negotiation', 'confirmation', 'panel_check'));

-- candidate_id stays the candidate the call is about; a panel_check call
-- phones the panelist instead (panelist_id), and only that purpose does.
alter table screening_calls drop constraint if exists screening_calls_callee_check;
alter table screening_calls add constraint screening_calls_callee_check
  check ((purpose = 'panel_check') = (panelist_id is not null));

alter table screening_calls drop constraint if exists screening_calls_confirmation_check;
alter table screening_calls add constraint screening_calls_confirmation_check
  check (purpose not in ('confirmation', 'panel_check') or confirmation_id is not null);
