-- E-mail branding per organisation: a logo (object key under
-- <org_id>/branding/) and a brand colour, used by every e-mail the
-- organisation sends. Additive and idempotent. Roll: node scripts/migrate-pg.mjs
alter table organizations add column if not exists brand_logo_path text;
alter table organizations add column if not exists brand_logo_content_type text;
alter table organizations add column if not exists brand_color text;
