-- 0055_org_context.sql — the Organisation context agent (O1) and the
-- consumers of the approved profile (O2). docs/org-context-agent-plan.md.
--
-- - org_context_sources: one row per website page or uploaded document the
--   agent read. `text` holds the extracted (or OCR-recognised) text every
--   profile item must quote; items whose quote is not in it are dropped in
--   code. A page that trips the injection tripwire contributes nothing until
--   a person accepts it (injection_flagged). Deleting a document is a soft
--   delete: items sourced from it render "(source removed)" until the next
--   approval.
-- - org_profiles gains the website (its own domain only — owner-confirmed when
--   it differs from the registered e-mail domain) and the monthly re-read
--   bookkeeping the sweep dispatches on.
-- - agent_runs.org_profile_version_id records which approved version a
--   consuming agent run read.
-- - hiring_conversations.kind separates organisation-desk threads from hiring
--   threads; every row that existed before this migration is 'hiring'.
--
-- Idempotent: re-running is a no-op.

create table if not exists org_context_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null,
  url text,
  file_key text,
  file_name text,
  mime text,
  bytes integer,
  ocr_pages integer not null default 0,
  sha256 text not null,
  text text not null default '',
  injection_flagged boolean not null default false,
  fetched_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references users(id) on delete set null
);
do $$ begin
  alter table org_context_sources add constraint org_context_sources_kind_check
    check (kind in ('website_page', 'document'));
exception when duplicate_object then null; end $$;
-- A re-read upserts the page instead of adding a duplicate row.
create unique index if not exists org_context_sources_page_key
  on org_context_sources (org_id, url) where kind = 'website_page' and deleted_at is null;
create index if not exists org_context_sources_org_idx
  on org_context_sources (org_id, kind, created_at);

alter table org_profiles
  add column if not exists website_url text,
  add column if not exists website_confirmed_by uuid references users(id) on delete set null,
  add column if not exists website_confirmed_at timestamptz,
  add column if not exists last_reread_at timestamptz,
  add column if not exists last_reread_status text,
  add column if not exists reread_failures integer not null default 0,
  add column if not exists next_reread_at timestamptz;
do $$ begin
  alter table org_profiles add constraint org_profiles_reread_status_check
    check (last_reread_status in ('ok', 'unchanged', 'failed'));
exception when duplicate_object then null; end $$;

alter table agent_runs
  add column if not exists org_profile_version_id uuid references org_profile_versions(id) on delete set null;
create index if not exists agent_runs_org_profile_idx on agent_runs (org_profile_version_id);

alter table hiring_conversations
  add column if not exists kind text not null default 'hiring';
do $$ begin
  alter table hiring_conversations add constraint hiring_conversations_kind_check
    check (kind in ('hiring', 'org_profile'));
exception when duplicate_object then null; end $$;
create index if not exists hiring_conversations_org_kind_idx
  on hiring_conversations (org_id, kind, updated_at);
