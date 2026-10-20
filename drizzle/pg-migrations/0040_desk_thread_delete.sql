-- 0040_desk_thread_delete.sql — deleting a hiring-desk chat, with a 30-day
-- restore.
--
-- A chat may be deleted while it is still gathering details, or together with
-- its unused draft requisition. It is hidden at once (deleted_at), can be
-- restored by an owner for 30 days, and is then purged by the scheduler's
-- sweep (its messages go with it; agent runs keep their record with the link
-- cleared). Every delete, restore and purge is in the audit log.
--
-- Idempotent: re-running is a no-op.

alter table hiring_conversations add column if not exists deleted_at timestamptz;
alter table hiring_conversations add column if not exists deleted_by uuid
  references users(id) on delete set null;
alter table hiring_conversations add column if not exists delete_reason text;
create index if not exists hiring_conversations_deleted_idx
  on hiring_conversations (org_id, deleted_at) where deleted_at is not null;
