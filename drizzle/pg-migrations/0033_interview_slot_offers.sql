-- 0033_interview_slot_offers.sql — candidates choose their interview time.
--
-- The Interview coordinator offers a few free times (from the interviewer's
-- calendar when Google or Microsoft is connected); the candidate picks one at
-- /schedule/<token>. The round, meeting link and both invites are created only
-- when they pick. Unanswered offers expire; "none of these work" is recorded.
--
-- Idempotent: re-running is a no-op.

create table if not exists interview_slot_offers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  application_id uuid not null references applications (id) on delete cascade,
  level integer not null,
  interviewer_name text,
  interviewer_email text not null,
  duration_mins integer not null default 60,
  mode text not null default 'online',
  meeting_provider text,
  agenda text,
  slots jsonb not null,
  token text not null,
  status text not null default 'offered',
  chosen_at timestamptz,
  interview_id uuid references interviews (id) on delete set null,
  candidate_note text,
  expires_at timestamptz not null,
  created_by uuid,
  agent_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists interview_slot_offers_token_key on interview_slot_offers (token);
create index if not exists interview_slot_offers_open_idx
  on interview_slot_offers (org_id, status, expires_at);
create index if not exists interview_slot_offers_application_idx
  on interview_slot_offers (application_id);
