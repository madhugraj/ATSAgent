-- 0066_rate_limits_step_up.sql — docs/guardrails.md P2-2 and P2-4.
--
-- - rate_limit_hits: the shared request limiter's counters (one row per caller
--   key per one-minute window), used when RATE_LIMIT_STORE=postgres so every
--   Cloud Run instance enforces one limit. UNLOGGED: losing counters in a
--   crash only resets a minute of limits, and it keeps writes cheap. Rows older
--   than five minutes are deleted by the limiter itself.
-- - sessions.reauthenticated_at: when the person last re-entered their
--   password in this session (step-up). Offer release and bulk rejection
--   need it within the last 10 minutes.
--
-- Idempotent: re-running is a no-op.

create unlogged table if not exists rate_limit_hits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);
create index if not exists rate_limit_hits_window_idx on rate_limit_hits (window_start);

alter table sessions add column if not exists reauthenticated_at timestamptz;
