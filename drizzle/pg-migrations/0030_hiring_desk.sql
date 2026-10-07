-- 0030_hiring_desk.sql — Phase 6a hiring desk (docs/agentic-plan.md §13.2).
--
-- hiring_conversations   one chat thread per hiring need: the details gathered
--                        so far (slots), the requisition it became, and a JD to
--                        reuse when the person chose one
-- hiring_messages        the thread: person, desk and agent messages, with an
--                        optional structured card (similar roles, approval
--                        request, ranked candidates, …)
-- agent_runs.conversation_id  runs working for a thread post their results to it
--
-- Idempotent: re-running is a no-op.

create table if not exists hiring_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  created_by uuid not null references users (id) on delete cascade,
  title text not null default 'New hiring need',
  status text not null default 'gathering',
  slots jsonb not null default '{}'::jsonb,
  requisition_id uuid references requisitions (id) on delete set null,
  reuse_jd_from uuid references requisitions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hiring_conversations_org_idx
  on hiring_conversations (org_id, updated_at desc);
create index if not exists hiring_conversations_req_idx
  on hiring_conversations (requisition_id) where requisition_id is not null;

create table if not exists hiring_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references hiring_conversations (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  role text not null,
  agent_type text,
  body text not null default '',
  card jsonb,
  created_at timestamptz not null default now()
);
create index if not exists hiring_messages_conv_idx
  on hiring_messages (conversation_id, created_at);

alter table agent_runs add column if not exists conversation_id uuid
  references hiring_conversations (id) on delete set null;
create index if not exists agent_runs_conversation_idx on agent_runs (conversation_id)
  where conversation_id is not null;
