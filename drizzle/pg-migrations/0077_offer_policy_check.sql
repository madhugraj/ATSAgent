-- Labour law & policy agent L3 (docs/labour-policy-agent-plan.md, 11 November 2026):
-- the offer check — before an offer goes for approval its letter and terms are
-- checked against the organisation's approved labour rules for the role's pay
-- zone; a "fix needed" blocks it unless the HR head overrides with a reason.
-- Idempotent.
alter table offers add column if not exists policy_check jsonb;
alter table offers add column if not exists policy_override jsonb;
