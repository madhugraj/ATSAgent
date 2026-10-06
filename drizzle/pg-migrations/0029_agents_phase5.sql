-- 0029_agents_phase5.sql — hardening and scale (docs/agentic-plan.md §10, Phase 5).
--
-- agent_runs.mode / replay_of   dry-run replays of a finished run: read tools run,
--                               write / external / human steps are simulated
-- agent_runs.otel_exported_at   OpenTelemetry export watermark per run
-- agent_steps.notify_state      act_and_notify: actions the principal is told about
--                               ('pending' until they mark them seen)
-- agent_steps.injection_suspected  third-party text in a tool result looked like
--                               an instruction to the model (alerting)
-- agent_issues.notified_at      alert e-mail / webhook sent for this issue
-- agent_telemetry_settings      per-org trace export and alert channels
--                               (credentials encrypted at rest)
--
-- Idempotent: re-running is a no-op.

alter table agent_runs add column if not exists mode text not null default 'live';
alter table agent_runs add column if not exists replay_of uuid
  references agent_runs (id) on delete set null;
alter table agent_runs add column if not exists otel_exported_at timestamptz;
create index if not exists agent_runs_replay_of_idx on agent_runs (replay_of)
  where replay_of is not null;
create index if not exists agent_runs_export_idx on agent_runs (org_id, finished_at)
  where otel_exported_at is null and finished_at is not null;

alter table agent_steps add column if not exists notify_state text;
alter table agent_steps add column if not exists injection_suspected boolean not null default false;
create index if not exists agent_steps_notify_idx on agent_steps (org_id, notify_state)
  where notify_state = 'pending';

alter table agent_issues add column if not exists notified_at timestamptz;

create table if not exists agent_telemetry_settings (
  org_id uuid primary key references organizations (id) on delete cascade,
  otlp_enabled boolean not null default false,
  otlp_endpoint text,
  otlp_headers_enc text,
  alert_email_enabled boolean not null default true,
  alert_webhook_url text,
  alert_webhook_secret_enc text,
  last_export_at timestamptz,
  last_attempt_at timestamptz,
  last_export_error text,
  updated_by uuid references users (id) on delete set null,
  updated_at timestamptz not null default now()
);
