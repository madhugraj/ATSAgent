-- Pay terms, Phase 1 (docs/pay-terms-plan.md, 11 November 2026): currency, pay
-- basis, kinds of work, pay zones, pooling regions, exchange rates and pay
-- figures stored as said. Every existing row is backfilled to the behaviour in
-- use today: the organisation's currency (else INR), annual, permanent.
-- Idempotent.

alter table organizations add column if not exists pay_basis_default text not null default 'annual';
alter table organizations add column if not exists hours_per_week_default numeric(5,2) not null default 40;
alter table organizations add column if not exists kinds_of_work text[] not null default '{permanent}'::text[];

create table if not exists pooling_regions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  default_rule text not null default 'same_region',
  created_at timestamptz not null default now(),
  constraint pooling_regions_rule_check check (default_rule in ('same_zone','same_region','entity_countries','global_remote'))
);
create unique index if not exists pooling_regions_org_name_key on pooling_regions (org_id, name);

create table if not exists pay_zones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  countries text[] not null,
  cities text[] not null default '{}'::text[],
  currency text not null,
  pay_basis text not null default 'annual',
  payments_per_year integer not null default 12,
  includes text[] not null default '{base}'::text[],
  hours_per_week numeric(5,2) not null default 40,
  working_days_per_year integer not null default 250,
  kinds text[] not null default '{permanent}'::text[],
  contract_types text[] not null default '{}'::text[],
  entity text,
  geo_factor numeric(6,3),
  region_id uuid references pooling_regions(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pay_zones_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint pay_zones_basis_check check (pay_basis in ('annual','monthly','daily','hourly')),
  constraint pay_zones_payments_check check (payments_per_year between 12 and 16)
);
create unique index if not exists pay_zones_org_name_key on pay_zones (org_id, name);

create table if not exists exchange_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  from_currency text not null,
  to_currency text not null,
  rate numeric(20,10) not null,
  source text not null,
  rate_at timestamptz not null,
  entered_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint exchange_rates_rate_check check (rate > 0),
  constraint exchange_rates_codes_check check (from_currency ~ '^[A-Z]{3}$' and to_currency ~ '^[A-Z]{3}$')
);
create index if not exists exchange_rates_org_pair_idx on exchange_rates (org_id, from_currency, to_currency, rate_at);

create table if not exists pay_figures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  owner_type text not null,
  owner_id uuid not null,
  figure text not null,
  amount numeric(16,2) not null,
  currency text not null,
  pay_basis text not null,
  gross boolean,
  payments_per_year integer,
  includes text[],
  said_as text,
  currency_assumed boolean not null default false,
  source text not null,
  pay_amount numeric(16,2),
  pay_currency text,
  reporting_amount numeric(16,2),
  reporting_currency text,
  rate jsonb,
  refusal text,
  candidate_id uuid references candidates(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint pay_figures_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint pay_figures_basis_check check (pay_basis in ('annual','monthly','daily','hourly')),
  constraint pay_figures_owner_check check (owner_type in ('requisition','application','offer')),
  constraint pay_figures_amount_check check (amount >= 0)
);
create index if not exists pay_figures_owner_idx on pay_figures (org_id, owner_type, owner_id, figure, created_at);

alter table requisitions add column if not exists kind_of_work text not null default 'permanent';
alter table requisitions add column if not exists pay_basis text not null default 'annual';
alter table requisitions add column if not exists pay_currency text not null default 'INR';
alter table requisitions add column if not exists pay_zone_id uuid references pay_zones(id) on delete set null;
alter table requisitions add column if not exists hours_per_week numeric(5,2);
alter table requisitions add column if not exists days_per_week numeric(3,1);
alter table requisitions add column if not exists contract_months integer;
alter table requisitions add column if not exists extendable boolean;
alter table requisitions add column if not exists contract_type text;
alter table requisitions add column if not exists pays_by_location boolean not null default false;
alter table requisitions add column if not exists needed_by date;

-- Backfill: each requisition pays in its organisation's currency (today's behaviour).
update requisitions r
   set pay_currency = o.currency
  from organizations o
 where r.org_id = o.id
   and r.pay_currency = 'INR'
   and o.currency ~ '^[A-Z]{3}$'
   and o.currency <> 'INR';

alter table requisitions drop constraint if exists requisitions_pay_currency_check;
alter table requisitions add constraint requisitions_pay_currency_check check (pay_currency ~ '^[A-Z]{3}$');
alter table requisitions drop constraint if exists requisitions_pay_basis_check;
alter table requisitions add constraint requisitions_pay_basis_check check (pay_basis in ('annual','monthly','daily','hourly'));
alter table requisitions drop constraint if exists requisitions_kind_of_work_check;
alter table requisitions add constraint requisitions_kind_of_work_check check (kind_of_work in ('permanent','fixed_term','contract_hourly','part_time','intern'));
