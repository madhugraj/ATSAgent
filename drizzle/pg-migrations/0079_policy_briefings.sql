-- Labour policy briefings (docs/labour-policy-agent-plan.md, 11 November 2026): per
-- law, a dated timeline of what the government published (each entry linked to its
-- document and checked against the source's listing), the key provisions with their
-- section references and exact quotes (each a finding), and what it means for HR —
-- decided by the HR head in one approval. Idempotent.
create table if not exists policy_briefings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  topic text not null,
  hr_impact text not null default '',
  timeline jsonb not null default '[]'::jsonb,
  provisions jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  agent_run_id uuid,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  constraint policy_briefings_status_check check (status in ('pending','approved','rejected','superseded'))
);
create index if not exists policy_briefings_org_idx on policy_briefings (org_id, status, created_at);
alter table policy_findings add column if not exists briefing_id uuid references policy_briefings(id) on delete set null;
