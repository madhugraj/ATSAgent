-- 0035_candidate_cost_offer_response.sql — cost per candidate; offer answers.
--
-- * ai_usage_events.requisition_id / application_id / candidate_id: every AI
--   request made for a specific role or candidate is attributed to it, so the
--   tokens and cost of hiring each candidate can be reported (no FKs: the
--   ledger outlives deleted records).
-- * offers.response_token: the candidate's private accept / decline / ask-for-
--   changes link in the released-offer email; counter: what they asked for;
--   revision: which version of the offer this is; responded_at.
-- * offer_status 'countered': the candidate asked for changes; the Offer agent
--   proposes a revision inside the band, which is approved again.
--
-- Idempotent: re-running is a no-op.

alter table ai_usage_events add column if not exists requisition_id uuid;
alter table ai_usage_events add column if not exists application_id uuid;
alter table ai_usage_events add column if not exists candidate_id uuid;
create index if not exists ai_usage_events_application_idx
  on ai_usage_events (application_id) where application_id is not null;
create index if not exists ai_usage_events_requisition_idx
  on ai_usage_events (requisition_id) where requisition_id is not null;

alter type offer_status add value if not exists 'countered';

alter table offers add column if not exists response_token text;
alter table offers add column if not exists counter jsonb;
alter table offers add column if not exists revision integer not null default 1;
alter table offers add column if not exists responded_at timestamptz;
create unique index if not exists offers_response_token_key
  on offers (response_token) where response_token is not null;
