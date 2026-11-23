-- Voice-first interview scheduling: when times are offered, the AI scheduling
-- call goes first and the e-mailed link is held back until that call ends
-- without a booking (or cannot happen in time). link_emailed_at records when
-- the link went out; null = held. Rows from before this change were e-mailed
-- when offered, so they are backfilled with their creation time.
-- Roll: node scripts/migrate-pg.mjs
alter table interview_slot_offers
  add column if not exists link_emailed_at timestamptz;
update interview_slot_offers
  set link_emailed_at = created_at
  where link_emailed_at is null
    and created_at < '2026-11-18T00:00:00Z';
create index if not exists interview_slot_offers_held_idx
  on interview_slot_offers (org_id, status)
  where link_emailed_at is null;
