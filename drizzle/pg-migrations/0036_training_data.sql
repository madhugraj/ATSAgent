-- 0036_training_data.sql — training data for a future HR model.
--
-- Everything a model needs to learn this work later, captured as it happens
-- (docs/agentic-plan.md §14):
--
-- * training_settings: per organisation, OFF by default. Using a customer's
--   candidate data to train a model is a separate purpose that needs that
--   customer's agreement (DPDP Act 2023 / GDPR), so nothing is captured until
--   an owner switches it on; retention is set here too.
-- * training_inferences: every model call — system prompt, input or messages,
--   tools offered, output or tool calls, model, tokens, latency, outcome —
--   with the agent run, role and candidate it belongs to.
-- * training_feedback: human and real-world judgements on that work — task
--   decisions (approve / decline with reason / edited arguments), answers,
--   desk change requests, HR verifying an AI document read, scorecards,
--   approver send-backs, candidate answers to offers, final outcomes, and
--   reviewer annotations.
-- * training_eval_results: eval scenarios, their checks and verdicts.
--
-- Erasure: rows cascade with their organisation and their candidate.
-- Idempotent: re-running is a no-op.

create table if not exists training_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default false,
  -- Who agreed, and when (the record of consent).
  consented_by uuid references users(id) on delete set null,
  consented_at timestamptz,
  retention_days integer not null default 730 check (retention_days between 30 and 3650),
  updated_at timestamptz not null default now()
);

create table if not exists training_inferences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- 'json' (structured output), 'research' (web-grounded), 'agent_step' (tool use).
  call_kind text not null,
  feature text not null,
  provider text not null,
  model text not null,
  -- What the model was given: system, prompt or messages, tools, output schema.
  request jsonb not null,
  -- What it returned: data, or text and tool calls; null when the call failed.
  response jsonb,
  status text not null,
  error_message text,
  stop_reason text,
  grounded boolean,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  latency_ms integer,
  -- sha256 of the request, to find duplicates across the corpus.
  request_hash text not null,
  -- Where it happened.
  agent_run_id uuid references agent_runs(id) on delete set null,
  requisition_id uuid references requisitions(id) on delete set null,
  application_id uuid references applications(id) on delete set null,
  candidate_id uuid references candidates(id) on delete cascade,
  usage_event_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists training_inferences_org_created_idx on training_inferences (org_id, created_at);
create index if not exists training_inferences_run_idx on training_inferences (agent_run_id, created_at) where agent_run_id is not null;
create index if not exists training_inferences_feature_idx on training_inferences (feature, created_at);
create index if not exists training_inferences_application_idx on training_inferences (application_id) where application_id is not null;
create index if not exists training_inferences_candidate_idx on training_inferences (candidate_id) where candidate_id is not null;
create index if not exists training_inferences_hash_idx on training_inferences (request_hash);

create table if not exists training_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- Where the judgement came from, e.g. task_decision, clarification,
  -- desk_feedback, document_review, scorecard, offer_send_back,
  -- candidate_offer_answer, outcome, annotation.
  source text not null,
  -- The judgement itself, e.g. approved, rejected, edited, answered,
  -- verified, select, hold, hired, declined, good, bad.
  label text not null,
  rating integer,
  reason text,
  -- What the AI proposed, and what a person said it should have been.
  original jsonb,
  corrected jsonb,
  -- The model call this judges, when known; else its run / task / subject.
  inference_id uuid references training_inferences(id) on delete cascade,
  agent_run_id uuid references agent_runs(id) on delete set null,
  agent_task_id uuid references agent_tasks(id) on delete set null,
  requisition_id uuid references requisitions(id) on delete set null,
  application_id uuid references applications(id) on delete set null,
  candidate_id uuid references candidates(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  -- 'human', 'candidate', 'system' (an outcome), 'eval'.
  actor_kind text not null default 'human',
  created_at timestamptz not null default now()
);
create index if not exists training_feedback_org_created_idx on training_feedback (org_id, created_at);
create index if not exists training_feedback_inference_idx on training_feedback (inference_id) where inference_id is not null;
create index if not exists training_feedback_run_idx on training_feedback (agent_run_id) where agent_run_id is not null;
create index if not exists training_feedback_application_idx on training_feedback (application_id) where application_id is not null;
create index if not exists training_feedback_source_idx on training_feedback (source, label);

create table if not exists training_eval_results (
  id uuid primary key default gen_random_uuid(),
  scenario text not null,
  agent_type text not null,
  agent_version text,
  definition_hash text,
  -- 'scripted' (CI) or 'live' (a real model).
  mode text not null,
  provider text,
  model text,
  passed boolean not null,
  checks jsonb not null,
  transcript jsonb,
  tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists training_eval_results_scenario_idx on training_eval_results (scenario, created_at);
