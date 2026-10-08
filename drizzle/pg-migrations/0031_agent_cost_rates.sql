-- 0031_agent_cost_rates.sql — the organisation's own AI token prices, for
-- cost estimates on Agent observability (utilisation & efficiency).
--
-- Organisations bring their own AI key, so the price depends on their model
-- and plan; the app never assumes one. Costs are shown only once a rate is
-- set, and always labelled as estimates at that rate.
--
-- Idempotent: re-running is a no-op.

create table if not exists agent_cost_rates (
  org_id uuid primary key references organizations (id) on delete cascade,
  currency text not null default 'USD',
  input_per_million numeric(12, 4) not null,
  output_per_million numeric(12, 4) not null,
  updated_by uuid references users (id) on delete set null,
  updated_at timestamptz not null default now()
);
