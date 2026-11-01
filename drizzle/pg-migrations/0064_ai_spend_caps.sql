-- 0064_ai_spend_caps.sql — denial-of-wallet guards (docs/guardrails.md, P1-2).
--
-- - ai_settings.monthly_token_cap: AI tokens an organisation may use per
--   calendar month (UTC) across every feature, counted from the
--   ai_usage_events ledger (what the provider reported). The gateway refuses
--   new AI requests once the month's total reaches it. NULL = no cap.
-- - ai_settings.daily_scores_per_requisition: automatic CV scorings per
--   requisition per day (UTC); applications over it wait for the next day
--   instead of being scored. NULL = no cap.
--
-- Idempotent: re-running is a no-op.

alter table ai_settings add column if not exists monthly_token_cap bigint;
alter table ai_settings add column if not exists daily_scores_per_requisition integer;

do $$ begin
  alter table ai_settings add constraint ai_settings_monthly_token_cap_positive
    check (monthly_token_cap is null or monthly_token_cap > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table ai_settings add constraint ai_settings_daily_scores_positive
    check (daily_scores_per_requisition is null or daily_scores_per_requisition > 0);
exception when duplicate_object then null; end $$;
