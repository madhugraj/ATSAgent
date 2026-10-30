-- 0058_negotiation_call.sql — the AI negotiation call, step N0
-- (docs/negotiator-voice-agent.md).
--
-- * screening_calls: a third purpose, 'negotiation', always tied to the pay
--   discussion it follows up.
-- * offer_negotiations.call_step_ctc: the one improved figure the call may
--   offer (above the proposal, at or under the ceiling); null = hold.
-- * offer_negotiations.call_outcome: what the call heard. It pre-fills the
--   confirm form; only a person's confirmation marks the discussion agreed.
--
-- Idempotent: re-running is a no-op.

alter table screening_calls drop constraint if exists screening_calls_purpose_check;
alter table screening_calls add constraint screening_calls_purpose_check
  check (purpose in ('screening', 'scheduling', 'negotiation'));

alter table screening_calls add column if not exists negotiation_id uuid
  references offer_negotiations(id) on delete set null;
-- A negotiation call always follows up a pay discussion.
do $$ begin
  alter table screening_calls add constraint screening_calls_negotiation_check
    check (purpose <> 'negotiation' or negotiation_id is not null);
exception when duplicate_object then null; end $$;
create index if not exists screening_calls_negotiation_idx on screening_calls (negotiation_id);

alter table offer_negotiations add column if not exists call_step_ctc numeric(14, 2);
do $$ begin
  alter table offer_negotiations add constraint offer_negotiations_call_step_check
    check (call_step_ctc is null or (call_step_ctc > proposed_ctc and call_step_ctc <= ceiling));
exception when duplicate_object then null; end $$;
alter table offer_negotiations add column if not exists call_outcome jsonb;
