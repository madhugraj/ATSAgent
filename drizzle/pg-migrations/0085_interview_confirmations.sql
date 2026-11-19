-- Interview time confirmations: each panelist, and the candidate on a round a
-- person booked, accepts or declines the time through a private link before
-- the candidate is told. One row per person per time asked; a re-schedule
-- supersedes the old rows. Emails waiting on these rows sit in the outbox as
-- status 'held' (a text column — no enum change).
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs
create table if not exists interview_confirmations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  interview_id uuid references interviews(id) on delete cascade,
  offer_id uuid references interview_slot_offers(id) on delete cascade,
  party text not null,
  email text not null,
  name text,
  token text not null,
  state text not null default 'pending',
  scheduled_at timestamptz,
  note text,
  responded_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists interview_confirmations_token_key
  on interview_confirmations (token);
create index if not exists interview_confirmations_interview_idx
  on interview_confirmations (org_id, interview_id);
create index if not exists interview_confirmations_offer_idx
  on interview_confirmations (org_id, offer_id);
