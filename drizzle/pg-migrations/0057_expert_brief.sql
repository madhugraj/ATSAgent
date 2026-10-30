-- 0057_expert_brief.sql — the Role expert interview agent: what the role's
-- hiring manager said the role really needs (must-haves with why,
-- deal-breakers, must-ask screening questions, each round's focus), approved
-- by them and read by the screening kit and the interview plan.
--
-- Idempotent: re-running is a no-op.

alter table requisitions
  add column if not exists expert_brief jsonb;
