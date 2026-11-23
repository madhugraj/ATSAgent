-- Labour law & policy agent, L0–L2 (docs/labour-policy-agent-plan.md, 11 November 2026):
-- official sources per pay zone, what each read found, and the findings the HR
-- head approves into the organisation's rules. Idempotent.
create table if not exists policy_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  zone_id uuid references pay_zones(id) on delete cascade,
  country text,
  level text not null default 'country',
  label text not null,
  url text not null,
  host text not null,
  active boolean not null default true,
  seeded boolean not null default false,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint policy_sources_level_check check (level in ('global','regional','country','state','domain','organisation')),
  constraint policy_sources_url_check check (url ~ '^https://')
);
create unique index if not exists policy_sources_org_url_key on policy_sources (org_id, url);

create table if not exists policy_reads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  source_id uuid not null references policy_sources(id) on delete cascade,
  status text not null,
  hash text,
  text text,
  error text,
  fetched_at timestamptz not null default now(),
  agent_run_id uuid,
  constraint policy_reads_status_check check (status in ('changed','unchanged','first','failed'))
);
create index if not exists policy_reads_source_idx on policy_reads (org_id, source_id, fetched_at);

create table if not exists policy_findings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  source_id uuid references policy_sources(id) on delete set null,
  zone_id uuid references pay_zones(id) on delete set null,
  url text not null,
  quote text not null,
  area text not null,
  summary text not null,
  rule text not null,
  impact text not null default '',
  effective_date date,
  status text not null default 'new',
  agent_run_id uuid,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  constraint policy_findings_status_check check (status in ('new','proposed','approved','rejected','dismissed','superseded')),
  constraint policy_findings_area_check check (area in ('notice','probation','minimum_wage','hours','contracts','pay_transparency','questions','data','ai_and_recording','mandatory_pay','leave','other'))
);
create index if not exists policy_findings_org_idx on policy_findings (org_id, status, created_at);
create unique index if not exists policy_findings_source_quote_key on policy_findings (org_id, source_id, md5(quote));
