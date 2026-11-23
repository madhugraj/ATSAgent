-- Interview confirmations: which of the offered times a panelist can do, and
-- another time they suggest. The candidate is offered only the times every
-- panelist can do; with none in common the Interview coordinator offers new
-- times built from the suggestions. Additive and idempotent.
-- Roll: node scripts/migrate-pg.mjs
alter table interview_confirmations add column if not exists ok_slots jsonb;
alter table interview_confirmations add column if not exists suggested_at timestamptz;
