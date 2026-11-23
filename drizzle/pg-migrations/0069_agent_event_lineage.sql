-- Agent event lineage: record the agent run that published each event, so a
-- hand-off chain (run → event → run → event …) can be followed end to end and
-- loops detected. Null for events a person or the system published, and for
-- events written before this column existed. Roll: node scripts/migrate-pg.mjs
alter table agent_events
  add column if not exists source_run_id uuid references agent_runs(id) on delete set null;
create index if not exists agent_events_source_run_idx on agent_events (source_run_id);
