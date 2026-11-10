-- Voice Guard (docs/voice-guard.md): every answered AI phone call is reviewed
-- after it ends — silently, observe-and-report only. The call keeps its
-- turn-taking and audio stats (previously only logged), and each call gets one
-- review: per-check verdicts and findings with quoted evidence, for a person.
-- Idempotent. Roll: node scripts/migrate-pg.mjs

alter table screening_calls
  add column if not exists call_stats jsonb;
-- The instructions and facts the answered call ran with: what the review checks
-- "beyond scope", "invented facts" and "commitments" against.
alter table screening_calls
  add column if not exists brief text;

create table if not exists call_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- The call is the candidate's record: erasing it (or the candidate) removes the review.
  call_id uuid not null references screening_calls(id) on delete cascade,
  purpose text not null,
  status text not null default 'due',
  -- full: the transcript was kept (the candidate consented to notes and the quality
  -- check); timing_only: nothing was kept, so only the call's stats are reviewed.
  scope text not null default 'full',
  agent_run_id uuid references agent_runs(id) on delete set null,
  verdict text,
  quality_score integer,
  summary text,
  checks jsonb not null default '[]'::jsonb,
  findings jsonb not null default '[]'::jsonb,
  breaches integer not null default 0,
  attempts integer not null default 0,
  last_error text,
  reviewed_at timestamptz,
  acknowledged_by uuid references users(id) on delete set null,
  acknowledged_at timestamptz,
  ack_outcome text,
  ack_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint call_reviews_status_check check (status in ('due', 'reviewing', 'done', 'failed')),
  constraint call_reviews_scope_check check (scope in ('full', 'timing_only')),
  constraint call_reviews_verdict_check check (verdict is null or verdict in ('pass', 'attention', 'breach')),
  constraint call_reviews_quality_check check (quality_score is null or quality_score between 1 and 5),
  constraint call_reviews_ack_check check (ack_outcome is null or ack_outcome in ('confirmed', 'disputed')),
  constraint call_reviews_checks_array check (jsonb_typeof(checks) = 'array'),
  constraint call_reviews_findings_array check (jsonb_typeof(findings) = 'array')
);

create unique index if not exists call_reviews_call_key on call_reviews (call_id);
create index if not exists call_reviews_org_status_idx on call_reviews (org_id, status, updated_at);
create index if not exists call_reviews_org_created_idx on call_reviews (org_id, created_at desc);
