-- 0065_ai_redteam_checks.sql — model safety check before Autonomous
-- (docs/guardrails.md P1-4, docs/red-team.md).
--
-- One row per run of the red-team probes against the organisation's own saved
-- model (through the AI gateway, ledger feature `redteam_probe`). `passed`
-- means the model complied with none of the attacks. An agent can be switched
-- to Autonomous only with a passed check for the same provider and model in
-- the last 30 days. provider / model stay in the database and are never sent
-- to the browser.
--
-- Idempotent: re-running is a no-op.

create table if not exists ai_redteam_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  model text not null,
  passed boolean not null,
  -- [{ probe, complied, flagged, error? }] — no prompts, no model output.
  results jsonb not null default '[]'::jsonb,
  run_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists ai_redteam_checks_org_created_idx
  on ai_redteam_checks (org_id, created_at desc);
