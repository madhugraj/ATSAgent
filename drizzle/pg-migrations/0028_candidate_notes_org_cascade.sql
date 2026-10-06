-- 0028_candidate_notes_org_cascade.sql — candidate notes follow their
-- organisation on delete.
--
-- candidate_notes.org_id referenced organisations without ON DELETE CASCADE,
-- so deleting an organisation that had any candidate notes failed (tenant
-- deletion, test and demo teardown). Every other tenant table cascades.
--
-- Idempotent: re-running is a no-op.

alter table candidate_notes
  drop constraint if exists candidate_notes_org_id_organizations_id_fk;
alter table candidate_notes
  add constraint candidate_notes_org_id_organizations_id_fk
  foreign key (org_id) references organizations (id) on delete cascade;
