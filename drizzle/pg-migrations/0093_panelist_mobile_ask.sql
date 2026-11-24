-- Panel members add their own mobile (for the AI time-check call, 0092):
-- a private link (only its SHA-256 kept) and when / how often they were asked.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs
alter table panelists add column if not exists mobile_token_hash text;
alter table panelists add column if not exists phone_asked_at timestamptz;
alter table panelists add column if not exists phone_ask_count integer not null default 0;
create unique index if not exists panelists_mobile_token_key on panelists (mobile_token_hash);
