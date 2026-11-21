-- Workflow app and API (19 November 2026): an organisation's own keys to start
-- and follow a granted workflow from its other systems. Only the SHA-256 hash
-- of a key is stored; runs act as the person who issued it. Idempotent.
create table if not exists workflow_api_keys (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references agent_workflows(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  label text not null default '',
  key_prefix text not null,
  key_hash text not null,
  principal_user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create unique index if not exists workflow_api_keys_hash_key on workflow_api_keys (key_hash);
create index if not exists workflow_api_keys_org_idx on workflow_api_keys (org_id, workflow_id);
