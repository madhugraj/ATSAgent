-- Panel-only access: an `interviewer` role for colleagues who only sit on
-- interview panels. A member whose only role is `interviewer` is denied every
-- tenant function except the panel ones (requirePanel in
-- src/lib/auth.middleware.ts) — their own rounds, brief, CV and scorecard.
-- Additive and idempotent. Roll: node scripts/migrate-pg.mjs
alter type app_role add value if not exists 'interviewer';
