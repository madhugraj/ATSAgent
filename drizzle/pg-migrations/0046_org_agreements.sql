-- 0046_org_agreements.sql — an organisation's acceptance of the Terms of
-- Service, Privacy Policy and Data Processing Agreement (src/lib/legal).
--
-- One row per (organisation, document, version). Registration records the
-- current versions; when a document gets a new version the owner is asked
-- again on next sign-in and a new row is added — earlier rows stay as the
-- history. The signatory's name, title and email are copied onto the row so
-- the record survives the user account being removed; the request IP is kept
-- only as an HMAC (ip_hash), never in the clear.
--
-- Idempotent: re-running is a no-op.

create table if not exists org_agreements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null,
  version text not null,
  accepted_by uuid references users(id) on delete set null,
  accepted_at timestamptz not null default now(),
  accepter_name text not null,
  accepter_title text not null,
  accepter_email text not null,
  ip_hash text
);
do $$ begin
  alter table org_agreements add constraint org_agreements_kind_check
    check (kind in ('terms', 'privacy', 'dpa'));
exception when duplicate_object then null; end $$;
create unique index if not exists org_agreements_org_kind_version_key
  on org_agreements (org_id, kind, version);
create index if not exists org_agreements_org_idx
  on org_agreements (org_id, accepted_at);
