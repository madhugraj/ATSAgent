-- B3: bulk JD import, semantic duplicate check, tenant sector taxonomy
-- (docs/candidate-identification/track-b-design.md §3–4). Additive, idempotent.

ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS external_job_code text;
CREATE INDEX IF NOT EXISTS requisitions_org_external_job_code_idx
  ON requisitions (org_id, external_job_code);

CREATE TABLE IF NOT EXISTS jd_requirement_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_description_id uuid REFERENCES job_descriptions(id) ON DELETE CASCADE,
  requisition_id uuid REFERENCES requisitions(id) ON DELETE CASCADE,
  profile jsonb NOT NULL,
  role_family text,
  sector text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS jd_requirement_profiles_jd_key
  ON jd_requirement_profiles (job_description_id) WHERE job_description_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jd_requirement_profiles_org_family_idx
  ON jd_requirement_profiles (org_id, role_family);
CREATE INDEX IF NOT EXISTS jd_requirement_profiles_req_idx
  ON jd_requirement_profiles (requisition_id);

CREATE TABLE IF NOT EXISTS jd_import_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  import_id uuid NOT NULL,
  file_name text NOT NULL,
  status text NOT NULL,
  profile_id uuid REFERENCES jd_requirement_profiles(id) ON DELETE SET NULL,
  match_requisition_id uuid REFERENCES requisitions(id) ON DELETE SET NULL,
  requisition_id uuid REFERENCES requisitions(id) ON DELETE SET NULL,
  proposed_verdict text,
  decided_verdict text,
  similarity numeric(4,3),
  comparison jsonb,
  comparisons integer NOT NULL DEFAULT 0,
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jd_import_items_org_import_idx ON jd_import_items (org_id, import_id);
DO $$ BEGIN
  ALTER TABLE jd_import_items ADD CONSTRAINT jd_import_items_status_check
    CHECK (status in ('created','review','linked','error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS sector_taxonomy_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  term text NOT NULL,
  parent_id uuid,
  seeded_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sector_taxonomy_terms_org_term_key
  ON sector_taxonomy_terms (org_id, term);
