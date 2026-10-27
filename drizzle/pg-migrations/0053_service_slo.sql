-- 0053_service_slo.sql — request SLIs and SLO burn-rate alerts.
--
-- service_request_minutes: per-minute request counts per app instance and
-- route group (server_fn | page | api_public | api_auth), written by each
-- instance once a minute (src/server/slo.server.ts). No paths, ids, orgs or
-- users — the label set is fixed (README → Observability). Kept 35 days.
-- slo_alerts: multi-window burn-rate alerts on the SLOs in src/server/slo.ts,
-- at most one open row per SLO.
--
-- Idempotent: re-running is a no-op (databases that applied it under its
-- earlier name 0046_service_slo.sql re-run it harmlessly).

create table if not exists service_request_minutes (
  minute timestamptz not null,
  instance_id text not null,
  route_group text not null,
  requests integer not null default 0,
  errors integer not null default 0,
  slow integer not null default 0,
  latency integer[] not null default '{}'::integer[],
  primary key (minute, instance_id, route_group)
);
create index if not exists service_request_minutes_minute_idx on service_request_minutes (minute);

create table if not exists slo_alerts (
  id uuid primary key default gen_random_uuid(),
  slo text not null,
  severity text not null,
  status text not null default 'open',
  burn_rate double precision not null,
  window_minutes integer not null,
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  notified_at timestamptz
);
create unique index if not exists slo_alerts_open_uq on slo_alerts (slo) where status = 'open';
create index if not exists slo_alerts_opened_idx on slo_alerts (opened_at);
