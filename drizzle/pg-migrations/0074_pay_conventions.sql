-- Pay terms, Phase 2 (docs/pay-terms-plan.md, 11 November 2026): the organisation
-- agent proposes pay conventions (reporting currency, defaults, tolerance, pooling
-- regions, pay zones) as a draft; the HR head approves it and only then is it
-- applied. The tolerance: how far over a band's ceiling is a blocker (20 = today).
-- Idempotent.
alter table organizations add column if not exists pay_far_above_pct integer not null default 20;
alter table organizations drop constraint if exists organizations_pay_far_above_pct_check;
alter table organizations add constraint organizations_pay_far_above_pct_check check (pay_far_above_pct between 0 and 100);

create table if not exists pay_convention_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  status text not null default 'pending',
  conventions jsonb not null,
  summary text not null default '',
  agent_run_id uuid,
  proposed_by uuid references users(id) on delete set null,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  constraint pay_convention_drafts_status_check check (status in ('pending','approved','sent_back','declined','superseded'))
);
create index if not exists pay_convention_drafts_org_idx on pay_convention_drafts (org_id, status, created_at);
