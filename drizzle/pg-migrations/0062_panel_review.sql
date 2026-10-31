-- 0062_panel_review.sql — silent panel agents, step S3
-- (docs/silent-panel-agent-plan.md).
--
-- panel_assessments gains the comparison with the panel, made by a fixed rule
-- in code once every panellist has scored (src/lib/panel-reconcile.ts):
-- * outcome: agree | partial | disagree; panel_rating (the panellists'
--   average) and panel_verdict (the round's verdict) as compared.
-- * held: the candidate's move was held for the HR head (a disagreement).
-- * review_decision / review_note / reviewed_by / reviewed_at: the HR head's
--   decision on the review card (go_with_panel | confirmed | held | rejected).
--
-- Idempotent: re-running is a no-op.

alter table panel_assessments add column if not exists outcome text;
alter table panel_assessments add column if not exists panel_rating numeric(3, 2);
alter table panel_assessments add column if not exists panel_verdict text;
alter table panel_assessments add column if not exists held boolean not null default false;
alter table panel_assessments add column if not exists reconciled_at timestamptz;
alter table panel_assessments add column if not exists review_decision text;
alter table panel_assessments add column if not exists review_note text;
alter table panel_assessments add column if not exists reviewed_by uuid
  references users(id) on delete set null;
alter table panel_assessments add column if not exists reviewed_at timestamptz;
do $$ begin
  alter table panel_assessments add constraint panel_assessments_outcome_check
    check (outcome is null or outcome in ('agree', 'partial', 'disagree'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table panel_assessments add constraint panel_assessments_panel_verdict_check
    check (panel_verdict is null or panel_verdict in ('select', 'hold', 'reject'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table panel_assessments add constraint panel_assessments_review_decision_check
    check (review_decision is null
      or review_decision in ('go_with_panel', 'confirmed', 'held', 'rejected'));
exception when duplicate_object then null; end $$;
create index if not exists panel_assessments_review_open_idx
  on panel_assessments (org_id, reconciled_at)
  where outcome in ('partial', 'disagree') and review_decision is null;
