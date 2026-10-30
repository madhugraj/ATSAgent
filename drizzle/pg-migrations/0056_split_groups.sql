-- 0056_split_groups.sql — link the threads of one fan-out (parallel hiring
-- needs) so the desk can show the tracks chip: statuses, what needs the
-- person, side-by-side entry — from any thread of the group.
--
-- Idempotent: re-running is a no-op.

alter table hiring_conversations
  add column if not exists split_group_id uuid;
create index if not exists hiring_conversations_split_group_idx
  on hiring_conversations (split_group_id) where split_group_id is not null;
