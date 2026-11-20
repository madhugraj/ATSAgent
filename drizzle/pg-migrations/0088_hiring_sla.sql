-- Hiring SLA (end to end) and the panel's answer window.
-- organizations.hiring_sla_days: days from application to offer (default 5).
-- applications.sla_flag: the last SLA state the hiring desk was told about
-- (at_risk | breached), so each is posted once.
-- interview_confirmations.reminded_at / lapsed_at: the panel's answer window —
-- a reminder, then a default when it closes. Additive and idempotent.
-- Roll: node scripts/migrate-pg.mjs
alter table organizations add column if not exists hiring_sla_days smallint not null default 5;
alter table applications add column if not exists sla_flag text;
alter table interview_confirmations add column if not exists reminded_at timestamptz;
alter table interview_confirmations add column if not exists lapsed_at timestamptz;
