-- 0039_offer_negotiations.sql — agreeing the figure with the candidate
-- before an offer is drafted, when their expectation is above what the
-- organisation can pay.
--
-- The Offer agent prepares (ceiling approved by the HR head — and the CBO
-- when it is above the band — a proposed figure, levers such as a joining
-- bonus or an early review, a talk track); a person always approves the
-- message before it reaches the candidate; the candidate answers on a
-- private link (accept, propose another figure, ask for a call), or TA
-- records the outcome of a call. Agreement restarts the Offer agent.
--
-- Idempotent: re-running is a no-op.

create table if not exists offer_negotiations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  -- open | message_sent | countered | call_requested | agreed | no_agreement | expired | cancelled
  status text not null default 'open',
  expected_ctc numeric(14, 2),
  ceiling numeric(14, 2) not null,
  -- 'hr_head' | 'president_cbo': who approved the ceiling (CBO when above the band)
  ceiling_approved_by text not null,
  proposed_ctc numeric(14, 2) not null,
  levers jsonb not null default '{}'::jsonb,
  talk_track text not null default '',
  message text,
  token text unique,
  due_at timestamptz,
  closes_at timestamptz,
  answer jsonb,
  outcome jsonb,
  run_id uuid references agent_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists offer_negotiations_app_idx
  on offer_negotiations (application_id, created_at desc);
create index if not exists offer_negotiations_open_idx
  on offer_negotiations (org_id, status)
  where status in ('open', 'message_sent', 'countered', 'call_requested');
