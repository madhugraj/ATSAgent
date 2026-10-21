-- 0044_job_distribution.sql — advertising a role beyond the partner boards.
--
-- org_job_distribution: one row per organisation. google_jobs_enabled lists
-- every approved role on Google for Jobs (structured data on its apply page);
-- the feed token (encrypted, plus a SHA-256 lookup hash) keys the
-- organisation's public job feeds read by Jooble, Adzuna and Jora.
--
-- job_index_notifications: the queue of Google Indexing API notifications
-- (a role listed or taken down). Sent by the scheduler within Google's daily
-- quota, which is shared by every organisation on the platform.
--
-- requisition_board_postings now also records feed, Google and hand-posted
-- channels (provider = a channel id from src/lib/job-channels.ts); no schema
-- change is needed for that.
--
-- Idempotent: re-running is a no-op.

create table if not exists org_job_distribution (
  org_id uuid primary key references organizations(id) on delete cascade,
  google_jobs_enabled boolean not null default false,
  feed_token text,
  feed_token_hash text,
  feed_rotated_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create unique index if not exists org_job_distribution_feed_token_hash_key
  on org_job_distribution (feed_token_hash) where feed_token_hash is not null;

create table if not exists job_index_notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  requisition_id uuid references requisitions(id) on delete set null,
  url text not null,
  kind text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
do $$ begin
  alter table job_index_notifications add constraint job_index_notifications_kind_check
    check (kind in ('URL_UPDATED', 'URL_DELETED'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table job_index_notifications add constraint job_index_notifications_status_check
    check (status in ('pending', 'sent', 'failed', 'expired'));
exception when duplicate_object then null; end $$;
create index if not exists job_index_notifications_status_idx
  on job_index_notifications (status, created_at);
create index if not exists job_index_notifications_org_idx
  on job_index_notifications (org_id, created_at desc);
