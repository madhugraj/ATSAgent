-- Organisation scoring template: the default candidate-scoring weights every new
-- requisition starts from (the six built-ins plus up to four of the
-- organisation's own dimensions). Null keeps the platform default split.
-- The same weights drive the full match score and the ranked shortlist.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs
alter table organizations add column if not exists scoring_template jsonb;
