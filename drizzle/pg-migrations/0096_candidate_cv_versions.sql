-- CV versions and evidence claims (plan row 2, A2). Every CV a person sent is
-- kept; claims carry their evidence strength and source passage.
-- Design: docs/candidate-identification/track-a-design.md §2.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs

create table if not exists candidate_cv_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  requisition_id uuid references requisitions(id) on delete set null,
  source text not null,
  file_hash text,
  file_path text,
  file_name text,
  parsed_text text not null default '',
  accepted boolean not null default true,
  extraction_status text not null default 'pending',
  extraction_attempts integer not null default 0,
  extraction_lease_until timestamptz,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint candidate_cv_versions_status_check
    check (extraction_status in ('pending','running','done','failed','skipped'))
);
create index if not exists candidate_cv_versions_candidate_idx
  on candidate_cv_versions (org_id, candidate_id, submitted_at);
create index if not exists candidate_cv_versions_extract_idx
  on candidate_cv_versions (extraction_status, created_at);

create table if not exists candidate_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  version_id uuid not null references candidate_cv_versions(id) on delete cascade,
  claim_type text not null,
  normalised_value text not null,
  raw_value text not null,
  evidence_strength text not null,
  passage text not null,
  employer text,
  start_text text,
  end_text text,
  created_at timestamptz not null default now(),
  constraint candidate_claims_type_check
    check (claim_type in ('skill','role','project','cert','achievement')),
  constraint candidate_claims_strength_check
    check (evidence_strength in ('demonstrated','listed','inferred'))
);
create index if not exists candidate_claims_candidate_idx on candidate_claims (org_id, candidate_id);
create index if not exists candidate_claims_version_idx on candidate_claims (version_id);
create index if not exists candidate_claims_value_idx on candidate_claims (org_id, normalised_value);

-- The A1 key table's source_version_id gains its FK now that versions exist.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'candidate_identity_keys_source_version_fk') then
    alter table candidate_identity_keys
      add constraint candidate_identity_keys_source_version_fk
      foreign key (source_version_id) references candidate_cv_versions(id) on delete set null;
  end if;
end $$;

-- Backfill: each existing org-scoped, non-merged candidate with CV text gets
-- version 1 from today's denormalised columns. Status 'skipped': deploying this
-- must never fan out AI calls across every tenant's pool; a tenant re-queues
-- extraction deliberately (requeueClaimsExtraction).
insert into candidate_cv_versions (org_id, candidate_id, source, file_hash, file_path, parsed_text, extraction_status, submitted_at, created_at)
select c.org_id, c.id, 'backfill', c.file_hash, c.resume_file_path, coalesce(c.resume_text, ''), 'skipped', c.created_at, c.created_at
from candidates c
where c.org_id is not null
  and c.merged_into_id is null
  and coalesce(c.resume_text, '') <> ''
  and not exists (select 1 from candidate_cv_versions v where v.candidate_id = c.id);
