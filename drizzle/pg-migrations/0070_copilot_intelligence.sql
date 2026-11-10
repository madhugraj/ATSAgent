-- Copilot intelligence: the copilot can propose handing work to the agents
-- (the goal is kept on its answer until the person confirms), and each
-- organisation keeps one cached demand outlook (internal requisition trends +
-- market signal, ranked). Idempotent. Roll: node scripts/migrate-pg.mjs
alter table copilot_messages
  add column if not exists handoff jsonb;

create table if not exists demand_outlooks (
  org_id uuid primary key references organizations(id) on delete cascade,
  payload jsonb not null,
  generated_by uuid references users(id) on delete set null,
  generated_at timestamptz not null default now()
);
