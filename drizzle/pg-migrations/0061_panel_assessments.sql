-- 0061_panel_assessments.sql — silent panel agents, step S2
-- (docs/silent-panel-agent-plan.md).
--
-- * panel_assessments: the round's panel agent's own view of the call, one per
--   round — the candidate (rating 1–5, verdict, per-competency notes with
--   quoted evidence, strengths, gaps, open questions) and the panel
--   (competencies covered and missed, talk-time share, questions asked,
--   questions on protected ground). Hidden: nothing returns it to a person
--   before the round's panel has scored (S3 / S4). Candidate data: deleted with
--   the application. summary_sent_at: the panel's factual summary went out.
--
-- The three agents (panel_l1, panel_l2, panel_l3) are app-level agent types;
-- no schema change is needed for them.
--
-- Idempotent: re-running is a no-op.

create table if not exists panel_assessments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  interview_id uuid not null references interviews(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  level integer not null,
  agent_run_id uuid references agent_runs(id) on delete set null,
  rating integer,
  verdict text,
  candidate jsonb not null default '{}'::jsonb,
  panel jsonb not null default '{}'::jsonb,
  injection_suspected boolean not null default false,
  assessed_at timestamptz,
  summary_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists panel_assessments_interview_key
  on panel_assessments (interview_id);
create index if not exists panel_assessments_org_idx on panel_assessments (org_id);
create index if not exists panel_assessments_application_idx
  on panel_assessments (application_id);
do $$ begin
  alter table panel_assessments add constraint panel_assessments_level_check
    check (level between 1 and 3);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table panel_assessments add constraint panel_assessments_rating_check
    check (rating is null or rating between 1 and 5);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table panel_assessments add constraint panel_assessments_verdict_check
    check (verdict is null or verdict in ('select', 'hold', 'reject'));
exception when duplicate_object then null; end $$;
