-- Archive import (plan rows 3-4, A3): a queued, resumable, idempotent bulk CV
-- import with per-file state, a trial-run mode, and an explicit lifecycle for
-- staged files (they hold personal data with no owning candidate yet).
-- Design: docs/candidate-identification/track-a-design.md §3.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs

create table if not exists candidate_archive_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_by uuid,
  status text not null default 'staging',
  trial_run boolean not null default false,
  trial_limit integer,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_archive_imports_status_check
    check (status in ('staging','running','paused','done','cancelled'))
);
create index if not exists candidate_archive_imports_org_idx
  on candidate_archive_imports (org_id, created_at);

create table if not exists candidate_archive_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  import_id uuid not null references candidate_archive_imports(id) on delete cascade,
  file_name text not null,
  file_hash text not null,
  file_size integer not null default 0,
  staged_path text,
  status text not null default 'pending',
  candidate_id uuid references candidates(id) on delete set null,
  detail text,
  trial jsonb,
  attempts integer not null default 0,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_archive_items_status_check
    check (status in ('pending','running','done','merged','needs_review','skipped','failed'))
);
create unique index if not exists candidate_archive_items_import_hash_key
  on candidate_archive_items (import_id, file_hash);
create index if not exists candidate_archive_items_queue_idx
  on candidate_archive_items (status, updated_at);
create index if not exists candidate_archive_items_import_idx
  on candidate_archive_items (import_id, status);
