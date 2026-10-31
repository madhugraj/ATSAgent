-- 0060_panel_transcripts.sql — silent panel agents, step S1
-- (docs/silent-panel-agent-plan.md).
--
-- * panel_agent_settings: the silent panel agent switched on per organisation
--   (off by default) and for which rounds (levels 1–3).
-- * interviews.transcription: off | requested (switched on for the meeting,
--   waiting for the call's transcript) | ready | unavailable (it will not
--   come; transcription_detail says why) | candidate_declined.
--   transcript_checked_at / transcript_checks pace the fetch.
-- * interview_transcripts: the call's transcript as speaker-labelled segments,
--   one per round. Candidate data: org-scoped and deleted with the
--   application (and so with the candidate).
--
-- Idempotent: re-running is a no-op.

create table if not exists panel_agent_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default false,
  levels integer[] not null default '{1,2,3}',
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
do $$ begin
  alter table panel_agent_settings add constraint panel_agent_settings_levels_check
    check (levels <@ array[1, 2, 3] and cardinality(levels) between 1 and 3);
exception when duplicate_object then null; end $$;

alter table interviews add column if not exists transcription text not null default 'off';
alter table interviews add column if not exists transcription_detail text;
alter table interviews add column if not exists transcript_checked_at timestamptz;
alter table interviews add column if not exists transcript_checks integer not null default 0;
do $$ begin
  alter table interviews add constraint interviews_transcription_check
    check (transcription in ('off', 'requested', 'ready', 'unavailable', 'candidate_declined'));
exception when duplicate_object then null; end $$;
create index if not exists interviews_transcription_due_idx
  on interviews (org_id, scheduled_at) where transcription = 'requested';

create table if not exists interview_transcripts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  interview_id uuid not null references interviews(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  provider text not null,
  segments jsonb not null default '[]'::jsonb,
  segment_count integer not null default 0,
  fetched_at timestamptz not null default now()
);
create unique index if not exists interview_transcripts_interview_key
  on interview_transcripts (interview_id);
create index if not exists interview_transcripts_org_idx on interview_transcripts (org_id);
create index if not exists interview_transcripts_application_idx
  on interview_transcripts (application_id);
do $$ begin
  alter table interview_transcripts add constraint interview_transcripts_provider_check
    check (provider in ('zoom', 'google_meet', 'teams'));
exception when duplicate_object then null; end $$;
