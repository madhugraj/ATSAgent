-- Custom scoring dimensions: an organisation scores a candidate on its own
-- job-related parameters (values, domain, craft) alongside the six built-in
-- dimensions. Requisitions define them (label, scoring hint, weight — the
-- combined weights still total 100); match_scores keeps what the scorer
-- returned with the cited CV evidence. Roll: node scripts/migrate-pg.mjs
alter table requisitions
  add column if not exists custom_weights jsonb not null default '[]'::jsonb;
alter table match_scores
  add column if not exists custom_scores jsonb not null default '[]'::jsonb;
