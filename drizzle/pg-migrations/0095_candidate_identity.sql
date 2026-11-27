-- Candidate identity (plan row 1): normalised strong keys, the merge review
-- queue, reversible merges (tombstone rows + undo snapshots), and per-tenant
-- identity thresholds. Design: docs/candidate-identification/track-a-design.md §1.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs

alter table candidates add column if not exists file_hash text;
alter table candidates add column if not exists merged_into_id uuid references candidates(id) on delete set null;
create index if not exists candidates_merged_tombstone_idx on candidates (org_id) where merged_into_id is not null;

create table if not exists candidate_identity_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  key_type text not null,
  key_value text not null,
  source_version_id uuid,
  created_at timestamptz not null default now()
);
-- The guarantee: one row per strong key per org. shared_* keys (a family or
-- agency contact two people legitimately share) stay outside it by design.
create unique index if not exists candidate_identity_keys_unique
  on candidate_identity_keys (org_id, key_type, key_value)
  where key_type not in ('shared_email','shared_phone','shared_linkedin','shared_github');
create index if not exists candidate_identity_keys_lookup_idx
  on candidate_identity_keys (org_id, key_type, key_value);
create index if not exists candidate_identity_keys_candidate_idx
  on candidate_identity_keys (candidate_id);

create table if not exists candidate_merge_suggestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  candidate_a_id uuid not null references candidates(id) on delete cascade,
  candidate_b_id uuid not null references candidates(id) on delete cascade,
  score numeric(4,3) not null default 1,
  reasons jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  merge_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists candidate_merge_suggestions_queue_idx
  on candidate_merge_suggestions (org_id, status, created_at);
do $$ begin
  alter table candidate_merge_suggestions add constraint candidate_merge_suggestions_status_check
    check (status in ('pending','merged','kept_separate','stale'));
exception when duplicate_object then null; end $$;

create table if not exists candidate_merges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  survivor_id uuid not null references candidates(id) on delete cascade,
  merged_id uuid not null references candidates(id) on delete cascade,
  undo_snapshot jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  undone_by uuid,
  undone_at timestamptz,
  undo_note text
);
create index if not exists candidate_merges_candidate_idx
  on candidate_merges (org_id, survivor_id, merged_id);

create table if not exists candidate_identity_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  auto_merge_strong_keys boolean not null default true,
  fuzzy_high_threshold numeric(3,2) not null default 0.85,
  fuzzy_low_threshold numeric(3,2) not null default 0.60,
  default_phone_region text,
  flag_config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
do $$ begin
  alter table candidate_identity_settings add constraint candidate_identity_settings_thresholds_check
    check (fuzzy_low_threshold >= 0 and fuzzy_low_threshold <= fuzzy_high_threshold and fuzzy_high_threshold <= 1);
exception when duplicate_object then null; end $$;
