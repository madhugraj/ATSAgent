-- 0034_interview_panels_plans.sql — interview plans, panels and outcomes.
--
-- * requisitions.interview_plan: the role's rounds (name, focus, competencies
--   from its must-haves, panel size) and verdict policy; null = the default
--   built from the role's must-haves.
-- * interviews.panel: further interviewers on a round (the first stays in
--   interviewer / interviewer_email); interviews.outcome_note: why a round did
--   not happen (no-show, cancelled).
-- * evaluations.evaluator_email: one scorecard per panel member per round.
-- * interview_slot_offers.panel: the panel for an offered round.
--
-- Idempotent: re-running is a no-op.

alter table requisitions add column if not exists interview_plan jsonb;
alter table interviews add column if not exists panel jsonb not null default '[]'::jsonb;
alter table interviews add column if not exists outcome_note text;
alter table evaluations add column if not exists evaluator_email text;
alter table interview_slot_offers add column if not exists panel jsonb not null default '[]'::jsonb;

-- One scorecard per interviewer per round (was: one per round).
drop index if exists evaluations_interview_evaluator_idx;
drop index if exists evaluations_interview_id_key;
create unique index if not exists evaluations_interview_evaluator_key
  on evaluations (interview_id, coalesce(lower(evaluator_email), ''))
  where interview_id is not null;
